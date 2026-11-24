import type { Pool } from "./db";
import { withTx } from "./db";
import { audit } from "./audit";
import { deletePrefix } from "./storage";
import { daily, frames, operators, printers, resolveBounds, summary } from "./reports";

/**
 * Retention. The clock starts when an event is ARCHIVED: `retention_days` later its guest data is deleted for good (guest sessions and,
 * through them, photos, final pictures, print jobs, share records, wall and mosaic tiles, and their files). Before that, the event's
 * report figures are frozen into a snapshot, so analytics survive without any guest data. Configuration (frames, sponsors, branding)
 * is kept. An event on "legal hold" is never purged automatically.
 */
const DAY = 86400_000;
const GUEST_DIRS = ["originals", "finals", "thumbs", "wall", "mosaic/tiles", "mosaic/render"];

export interface RetentionStatus {
  status: string; archivedAt: string | null; retentionDays: number; purgeAt: string | null; daysLeft: number | null;
  hold: boolean; purgedAt: string | null; due: boolean; counts: { guests: number; pictures: number; photos: number; printJobs: number };
}

export async function retentionStatus(pool: Pool, eventId: string, now = new Date()): Promise<RetentionStatus | null> {
  const e = (await pool.query(
    `SELECT e.status, e.archived_at, e.purged_at, e.retention_hold, s.retention_days FROM events e JOIN event_settings s ON s.event_id=e.id WHERE e.id=$1`, [eventId])).rows[0];
  if (!e) return null;
  const c = (await pool.query(
    `SELECT (SELECT count(*)::int FROM guest_sessions WHERE event_id=$1) guests, (SELECT count(*)::int FROM final_compositions WHERE event_id=$1) pictures,
            (SELECT count(*)::int FROM photo_uploads WHERE event_id=$1) photos, (SELECT count(*)::int FROM print_jobs WHERE event_id=$1) jobs`, [eventId])).rows[0];
  const purgeAt = e.status === "archived" && e.archived_at ? new Date(new Date(e.archived_at).getTime() + e.retention_days * DAY) : null;
  return {
    status: e.status, archivedAt: e.archived_at ? new Date(e.archived_at).toISOString() : null, retentionDays: e.retention_days, purgeAt: purgeAt?.toISOString() ?? null,
    // sub-second clock differences (database vs application) must not add a day
    daysLeft: purgeAt && !e.purged_at ? Math.max(0, Math.ceil((purgeAt.getTime() - now.getTime() - 1000) / DAY)) : null,
    hold: e.retention_hold, purgedAt: e.purged_at ? new Date(e.purged_at).toISOString() : null,
    due: !!purgeAt && !e.purged_at && !e.retention_hold && purgeAt <= now, counts: { guests: c.guests, pictures: c.pictures, photos: c.photos, printJobs: c.jobs },
  };
}

export class RetentionError extends Error { constructor(public code: string, public status = 409) { super(code); } }

/** Freezes the event's figures (all time, UTC) so reports keep working after its guest data is gone. */
async function takeSnapshot(pool: Pool, eventId: string) {
  const all = await resolveBounds(pool, { tz: "UTC" });
  const span = (await pool.query(
    `SELECT to_char((least(min(a), now()) AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') f, to_char((greatest(max(a), now()) AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') t FROM (
       SELECT created_at a FROM guest_sessions WHERE event_id=$1 UNION ALL SELECT at FROM qr_scan_events WHERE event_id=$1 UNION ALL SELECT created_at FROM events WHERE id=$1) x`, [eventId])).rows[0];
  const last366 = (await pool.query("SELECT to_char(($1::date - 365),'YYYY-MM-DD') d", [span.t])).rows[0].d as string;
  const from = span.f < last366 ? last366 : span.f;
  const dailyBounds = await resolveBounds(pool, { from, to: span.t, tz: "UTC" });
  const [s, d, f, o, p] = await Promise.all([summary(pool, eventId, all), daily(pool, eventId, dailyBounds), frames(pool, eventId, all), operators(pool, eventId, all), printers(pool, eventId, all)]);
  return { version: 1, takenAt: new Date().toISOString(), summary: s, daily: d, frames: f, operators: o, printers: p };
}

/**
 * Deletes an archived event's guest data. Refuses anything else: an active event is never purged, and a purge never runs twice.
 * `safe` lets a local venue server hold back while data has not yet reached the cloud.
 */
export async function purgeEvent(pool: Pool, eventId: string, o: { userId: string | null; reason: "automatic" | "manual"; ip?: string; safe?: (eventId: string) => Promise<boolean> }) {
  const st = await retentionStatus(pool, eventId);
  if (!st) throw new RetentionError("not_found", 404);
  if (st.purgedAt) throw new RetentionError("already_purged");
  if (st.status !== "archived") throw new RetentionError("not_archived");
  if (o.reason === "automatic" && st.hold) throw new RetentionError("on_hold");
  if (o.safe && !(await o.safe(eventId))) throw new RetentionError("undelivered_data");
  const snapshot = await takeSnapshot(pool, eventId);
  await withTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mosaic:${eventId}`]);
    const e = (await tx.query("SELECT status, purged_at FROM events WHERE id=$1 FOR UPDATE", [eventId])).rows[0];
    if (!e || e.status !== "archived" || e.purged_at) throw new RetentionError("already_purged");
    await tx.query("DELETE FROM guest_sessions WHERE event_id=$1", [eventId]);               // cascades to everything a guest created
    await tx.query("DELETE FROM qr_scan_events WHERE event_id=$1", [eventId]);
    await tx.query("UPDATE events SET purged_at=now(), retention_snapshot=$2, updated_at=now() WHERE id=$1", [eventId, JSON.stringify(snapshot)]);
    await audit(tx, o.userId, "retention_purge", { eventId, entity: "event", entityId: eventId, detail: { reason: o.reason, ...st.counts }, ip: o.ip });
  });
  for (const d of GUEST_DIRS) await deletePrefix(`events/${eventId}/${d}`).catch(() => {});      // files after the commit
  return { purged: true, counts: st.counts };
}

/** Purges every archived event whose retention period has ended. Safe to run as often as wanted. */
export async function runRetention(pool: Pool, opts: { now?: Date; safe?: (eventId: string) => Promise<boolean> } = {}): Promise<{ purged: string[]; skipped: { eventId: string; reason: string }[] }> {
  const now = opts.now ?? new Date();
  const rows = (await pool.query(
    `SELECT e.id FROM events e JOIN event_settings s ON s.event_id=e.id
      WHERE e.status='archived' AND e.purged_at IS NULL AND NOT e.retention_hold AND e.archived_at IS NOT NULL
        AND e.archived_at + make_interval(days => s.retention_days) <= $1`, [now])).rows;
  const purged: string[] = []; const skipped: { eventId: string; reason: string }[] = [];
  for (const r of rows) {
    try { await purgeEvent(pool, r.id, { userId: null, reason: "automatic", safe: opts.safe }); purged.push(r.id); }
    catch (e: any) { skipped.push({ eventId: r.id, reason: e instanceof RetentionError ? e.code : String(e?.message ?? e) }); }
  }
  return { purged, skipped };
}

export function startRetentionTimer(pool: Pool, everyMinutes: number, safe?: (eventId: string) => Promise<boolean>): () => void {
  const tick = () => { runRetention(pool, { safe }).then((r) => { if (r.purged.length) console.log(`[retention] purged ${r.purged.length} archived event(s)`); }).catch((e) => console.error("[retention] failed:", e?.message ?? e)); };
  const t = setInterval(tick, Math.max(1, everyMinutes) * 60_000); t.unref(); const first = setTimeout(tick, 30_000); first.unref();
  return () => { clearInterval(t); clearTimeout(first); };
}
