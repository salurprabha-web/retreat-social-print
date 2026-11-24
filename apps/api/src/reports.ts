import {
  MAX_DAILY_DAYS, daysBetween, isDay, pct,
  type ActivityDay, type DailyReport, type DailyRow, type EventsOverviewRow, type FramesReport, type FunnelStep, type OperatorRow, type OperatorsReport,
  type PrinterRow, type PrintersReport, type ReportRange, type SubmissionRow, type SummaryReport, type Totals,
} from "@rsp/shared";
import type { Pool } from "./db";

/**
 * Report queries. Every number here is a count of real rows; nothing is estimated. A "day" is a calendar day in the chosen time zone.
 * Metric definitions are written into the shared types so the screen, CSV and PDF agree.
 */
/** A time-zone name is letters, digits and a few separators: anything else never reaches the database. */
export const TZ_RE = /^[A-Za-z0-9_+-/]{1,64}$/;

export class ReportError extends Error { constructor(public code: string, public status = 400) { super(code); } }

export interface Bounds { range: ReportRange; fromTs: Date | null; toTs: Date | null }

export async function resolveBounds(pool: Pool, q: { from?: unknown; to?: unknown; tz?: unknown }): Promise<Bounds> {
  const tz = typeof q.tz === "string" && q.tz ? q.tz : "UTC";
  if (!TZ_RE.test(tz) || !(await pool.query("SELECT 1 FROM pg_timezone_names WHERE name=$1", [tz])).rowCount) throw new ReportError("bad_timezone");
  const from = q.from === undefined || q.from === "" ? null : q.from, to = q.to === undefined || q.to === "" ? null : q.to;
  if ((from !== null && !isDay(from)) || (to !== null && !isDay(to))) throw new ReportError("bad_date");
  if (from && to && from > to) throw new ReportError("bad_range");
  const r = (await pool.query(
    "SELECT ($1::date)::timestamp AT TIME ZONE $3 AS f, (($2::date) + 1)::timestamp AT TIME ZONE $3 AS t", [from, to, tz])).rows[0];
  return { range: { from: from as string | null, to: to as string | null, tz }, fromTs: r.f, toTs: r.t };
}

/** After retention has deleted an event's guest data, its reports come from the snapshot taken just before (figures for the whole event, any period filter is ignored). */
async function frozen<T>(pool: Pool, eventId: string, key: string): Promise<T | null> {
  const row = (await pool.query("SELECT retention_snapshot s FROM events WHERE id=$1 AND purged_at IS NOT NULL", [eventId])).rows[0];
  return row?.s?.[key] ? ({ ...row.s[key], archived: true } as T) : null;
}

/** Rows whose timestamp column falls inside the range; $2/$3 are the bounds (null = open). */
const R = (col: string) => `(${col} >= $2::timestamptz OR $2::timestamptz IS NULL) AND (${col} < $3::timestamptz OR $3::timestamptz IS NULL)`;
const P = (b: Bounds, eventId: string) => [eventId, b.fromTs, b.toTs];
const num = async (pool: Pool, sql: string, b: Bounds, eventId: string) => ((await pool.query(sql, P(b, eventId))).rows[0]?.n ?? 0) as number;
const SHARE = "('instagram','whatsapp','native')";

export async function summary(pool: Pool, eventId: string, b: Bounds): Promise<SummaryReport> {
  const fz = await frozen<SummaryReport>(pool, eventId, "summary"); if (fz) return fz;
  const [scans, sessions, uploads, selections, completed, shares, printJobs, outcomes, wall, qr] = await Promise.all([
    num(pool, `SELECT count(*)::int n FROM qr_scan_events WHERE event_id=$1 AND ${R("at")}`, b, eventId),
    num(pool, `SELECT count(*)::int n FROM guest_sessions WHERE event_id=$1 AND ${R("created_at")}`, b, eventId),
    num(pool, `SELECT count(*)::int n FROM photo_uploads WHERE event_id=$1 AND ${R("created_at")}`, b, eventId),
    num(pool, `SELECT count(*)::int n FROM frame_selections WHERE event_id=$1 AND ${R("at")}`, b, eventId),
    num(pool, `SELECT count(*)::int n FROM final_compositions WHERE event_id=$1 AND finalized_at IS NOT NULL AND ${R("finalized_at")}`, b, eventId),
    pool.query(`SELECT count(*) FILTER (WHERE channel='instagram')::int ig, count(*) FILTER (WHERE channel='whatsapp')::int wa, count(*) FILTER (WHERE channel='native')::int nat,
                       count(*) FILTER (WHERE channel IN ('copy_caption','copy_hashtag'))::int cp, count(*) FILTER (WHERE channel='download')::int dl, count(DISTINCT session_id)::int sharers
                  FROM share_events WHERE event_id=$1 AND ${R("created_at")}`, P(b, eventId)),
    pool.query(`SELECT count(*) FILTER (WHERE kind='print')::int jobs, count(*) FILTER (WHERE kind='reprint')::int reprints FROM print_jobs WHERE event_id=$1 AND ${R("created_at")}`, P(b, eventId)),
    pool.query(`SELECT count(*) FILTER (WHERE e.to_status='printed')::int printed, COALESCE(sum(j.copies) FILTER (WHERE e.to_status='printed'),0)::int copies, count(*) FILTER (WHERE e.to_status='failed')::int failed
                  FROM print_job_events e JOIN print_jobs j ON j.id=e.job_id AND j.event_id=e.event_id WHERE e.event_id=$1 AND ${R("e.at")}`, P(b, eventId)),
    pool.query("SELECT COALESCE(sum(shown_count),0)::int n, count(*)::int pics FROM wall_views WHERE event_id=$1", [eventId]),     // all time: the wall keeps one running count per picture
    pool.query(`SELECT t.code, t.label, count(s.id)::int scans FROM qr_tracking t LEFT JOIN qr_scan_events s ON s.qr_id=t.id AND s.event_id=t.event_id AND ${R("s.at")}
                 WHERE t.event_id=$1 GROUP BY t.id ORDER BY scans DESC, t.created_at`, P(b, eventId)),
  ]);
  const sh = shares.rows[0], pj = printJobs.rows[0], oc = outcomes.rows[0];
  const totals: Totals = {
    scans, sessions, uploads, frameSelections: selections, completed,
    instagramAttempts: sh.ig, whatsappAttempts: sh.wa, nativeAttempts: sh.nat, shareAttempts: sh.ig + sh.wa + sh.nat, copies: sh.cp, downloads: sh.dl, uniqueSharers: sh.sharers,
    printJobs: pj.jobs, reprints: pj.reprints, printed: oc.printed, copiesPrinted: oc.copies, failedAttempts: oc.failed, wallAppearances: wall.rows[0].n, wallPictures: wall.rows[0].pics,
  };
  // The funnel follows the guests who STARTED in the range and shows how far they got (whenever they got there).
  const stage = async (join: string) => ((await pool.query(`SELECT count(DISTINCT s.id)::int n FROM guest_sessions s ${join} WHERE s.event_id=$1 AND ${R("s.created_at")}`, P(b, eventId))).rows[0].n) as number;
  const [up, chose, done, shared, printed] = await Promise.all([
    stage("JOIN photo_uploads u ON u.session_id=s.id AND u.event_id=s.event_id"),
    stage("JOIN frame_selections f ON f.session_id=s.id AND f.event_id=s.event_id"),
    stage("JOIN final_compositions c ON c.session_id=s.id AND c.event_id=s.event_id AND c.finalized_at IS NOT NULL"),
    stage("JOIN share_events e ON e.session_id=s.id AND e.event_id=s.event_id"),
    stage("JOIN final_compositions c ON c.session_id=s.id AND c.event_id=s.event_id JOIN print_jobs j ON j.composition_id=c.id AND j.event_id=c.event_id AND j.status='printed'"),
  ]);
  const funnel: FunnelStep[] = [
    { key: "guests", label: "Guests started", count: sessions, pct: sessions ? 100 : 0 },
    { key: "uploaded", label: "Added a photo", count: up, pct: pct(up, sessions) },
    { key: "frame", label: "Chose a frame", count: chose, pct: pct(chose, sessions) },
    { key: "finished", label: "Finished", count: done, pct: pct(done, sessions) },
    { key: "shared", label: "Shared or downloaded", count: shared, pct: pct(shared, sessions) },
    { key: "printed", label: "Got a print", count: printed, pct: pct(printed, sessions) },
  ];
  return { range: b.range, totals, funnel, qr: qr.rows.map((r) => ({ code: r.code, label: r.label, scans: r.scans })), generatedAt: new Date().toISOString() };
}

export async function daily(pool: Pool, eventId: string, b: Bounds): Promise<DailyReport> {
  const fz = await frozen<DailyReport>(pool, eventId, "daily"); if (fz) return fz;
  let { from, to } = b.range;
  const today = (await pool.query("SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') d", [b.range.tz])).rows[0].d as string;
  if (!to) to = today;
  if (!from) {                                                              // no start given: the last 30 days, but never before the first recorded activity
    const start = (await pool.query(
      `SELECT to_char((LEAST((SELECT created_at FROM events WHERE id=$1), (SELECT min(created_at) FROM guest_sessions WHERE event_id=$1), (SELECT min(at) FROM qr_scan_events WHERE event_id=$1)) AT TIME ZONE $2)::date,'YYYY-MM-DD') d`,
      [eventId, b.range.tz])).rows[0]?.d as string | undefined;
    const back = (await pool.query("SELECT to_char(($1::date - 29),'YYYY-MM-DD') d", [to])).rows[0].d as string;
    from = start && start > back ? start : back;
    if (from > to) from = to;
  }
  if (daysBetween(from, to) > MAX_DAILY_DAYS) throw new ReportError("range_too_long");
  const nb: Bounds = (await resolveBounds(pool, { from, to, tz: b.range.tz }));
  const params = [...P(nb, eventId), nb.range.tz];                         // $4 = time zone, used only by the per-day queries
  const D = (col: string) => `to_char((${col} AT TIME ZONE $4)::date,'YYYY-MM-DD')`;
  const perDay = async (sql: string) => { const m = new Map<string, Record<string, number>>(); for (const r of (await pool.query(sql, params)).rows) m.set(r.d, r); return m; };
  const [scans, sessions, uploads, sel, done, share, jobs, outcome] = await Promise.all([
    perDay(`SELECT ${D("at")} d, count(*)::int n FROM qr_scan_events WHERE event_id=$1 AND ${R("at")} GROUP BY 1`),
    perDay(`SELECT ${D("created_at")} d, count(*)::int n FROM guest_sessions WHERE event_id=$1 AND ${R("created_at")} GROUP BY 1`),
    perDay(`SELECT ${D("created_at")} d, count(*)::int n FROM photo_uploads WHERE event_id=$1 AND ${R("created_at")} GROUP BY 1`),
    perDay(`SELECT ${D("at")} d, count(*)::int n FROM frame_selections WHERE event_id=$1 AND ${R("at")} GROUP BY 1`),
    perDay(`SELECT ${D("finalized_at")} d, count(*)::int n FROM final_compositions WHERE event_id=$1 AND finalized_at IS NOT NULL AND ${R("finalized_at")} GROUP BY 1`),
    perDay(`SELECT ${D("created_at")} d, count(*) FILTER (WHERE channel IN ${SHARE})::int shares, count(*) FILTER (WHERE channel='instagram')::int ig, count(*) FILTER (WHERE channel='download')::int dl
              FROM share_events WHERE event_id=$1 AND ${R("created_at")} GROUP BY 1`),
    perDay(`SELECT ${D("created_at")} d, count(*) FILTER (WHERE kind='print')::int jobs, count(*) FILTER (WHERE kind='reprint')::int reprints FROM print_jobs WHERE event_id=$1 AND ${R("created_at")} GROUP BY 1`),
    perDay(`SELECT ${D("at")} d, count(*) FILTER (WHERE to_status='printed')::int printed, count(*) FILTER (WHERE to_status='failed')::int failed FROM print_job_events WHERE event_id=$1 AND ${R("at")} GROUP BY 1`),
  ]);
  const days = (await pool.query("SELECT to_char(d::date,'YYYY-MM-DD') AS day FROM generate_series($1::date, $2::date, '1 day') d", [from, to])).rows.map((r) => r.day as string);
  const rows: DailyRow[] = days.map((day) => ({
    day, scans: scans.get(day)?.n ?? 0, sessions: sessions.get(day)?.n ?? 0, uploads: uploads.get(day)?.n ?? 0, frameSelections: sel.get(day)?.n ?? 0, completed: done.get(day)?.n ?? 0,
    shareAttempts: share.get(day)?.shares ?? 0, instagramAttempts: share.get(day)?.ig ?? 0, downloads: share.get(day)?.dl ?? 0,
    printJobs: jobs.get(day)?.jobs ?? 0, reprints: jobs.get(day)?.reprints ?? 0, printed: outcome.get(day)?.printed ?? 0, failedAttempts: outcome.get(day)?.failed ?? 0,
  }));
  return { range: { from, to, tz: b.range.tz }, rows, generatedAt: new Date().toISOString() };
}

export async function frames(pool: Pool, eventId: string, b: Bounds): Promise<FramesReport> {
  const fz = await frozen<FramesReport>(pool, eventId, "frames"); if (fz) return fz;
  const rows = (await pool.query(
    `SELECT f.id, f.name, f.output_format, f.active, sp.name AS sponsor,
       (SELECT count(*)::int FROM frame_selections s WHERE s.frame_id=f.id AND s.event_id=f.event_id AND ${R("s.at")}) AS selections,
       (SELECT count(*)::int FROM final_compositions c WHERE c.frame_id=f.id AND c.event_id=f.event_id AND c.finalized_at IS NOT NULL AND ${R("c.finalized_at")}) AS completed,
       (SELECT count(*)::int FROM print_job_events pe JOIN print_jobs j ON j.id=pe.job_id AND j.event_id=pe.event_id JOIN final_compositions c ON c.id=j.composition_id AND c.event_id=j.event_id
         WHERE c.frame_id=f.id AND pe.to_status='printed' AND ${R("pe.at")}) AS printed,
       (SELECT count(*)::int FROM share_events e JOIN final_compositions c ON c.id=e.composition_id AND c.event_id=e.event_id WHERE c.frame_id=f.id AND e.channel IN ${SHARE} AND ${R("e.created_at")}) AS shares,
       (SELECT count(*)::int FROM share_events e JOIN final_compositions c ON c.id=e.composition_id AND c.event_id=e.event_id WHERE c.frame_id=f.id AND e.channel='download' AND ${R("e.created_at")}) AS downloads,
       (SELECT count(DISTINCT c.id)::int FROM share_events e JOIN final_compositions c ON c.id=e.composition_id AND c.event_id=e.event_id
         WHERE c.frame_id=f.id AND c.finalized_at IS NOT NULL AND e.channel IN ('instagram','whatsapp','native','download') AND ${R("c.finalized_at")}) AS shared_pictures
     FROM frames f LEFT JOIN sponsors sp ON sp.id=f.sponsor_id AND sp.event_id=f.event_id WHERE f.event_id=$1 ORDER BY completed DESC, selections DESC, f.name`, P(b, eventId))).rows;
  const total = rows.reduce((n, r) => n + r.completed, 0);
  return {
    range: b.range, generatedAt: new Date().toISOString(),
    rows: rows.map((r) => ({ frameId: r.id, name: r.name, format: r.output_format, active: r.active, sponsor: r.sponsor, selections: r.selections, completed: r.completed, completedPct: pct(r.completed, total),
      printed: r.printed, shareAttempts: r.shares, downloads: r.downloads, sharedOrDownloadedPct: pct(r.shared_pictures, r.completed) })),
  };
}

export const OPERATOR_NOTE = "Only actions taken by a signed-in person are listed. Automatic printing, the print agent and deliveries from a local venue server are not attributed to anyone.";

export async function operators(pool: Pool, eventId: string, b: Bounds): Promise<OperatorsReport> {
  const fz = await frozen<OperatorsReport>(pool, eventId, "operators"); if (fz) return fz;
  const mod = (await pool.query(
    `SELECT user_id,
        COALESCE(sum(n) FILTER (WHERE action='photo_approved'),0)::int approved, COALESCE(sum(n) FILTER (WHERE action='photo_rejected'),0)::int rejected,
        COALESCE(sum(n) FILTER (WHERE action='hide_wall'),0)::int hidden, COALESCE(sum(n) FILTER (WHERE action='photo_delete'),0)::int deleted, min(at) first_at, max(at) last_at
       FROM (SELECT user_id, action, at, COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(detail->'ids')='array' THEN detail->'ids' END),1) n
               FROM audit_logs WHERE event_id=$1 AND user_id IS NOT NULL AND action IN ('photo_approved','photo_rejected','hide_wall','photo_delete') AND ${R("at")}) a GROUP BY user_id`, P(b, eventId))).rows;
  const prn = (await pool.query(
    `SELECT user_id,
        count(*) FILTER (WHERE to_status='approved' AND from_status IN ('pending','received','reprint_requested'))::int print_approved,
        count(*) FILTER (WHERE to_status='approved' AND from_status='failed')::int retried,
        count(*) FILTER (WHERE to_status='pending' AND from_status='approved')::int held,
        count(*) FILTER (WHERE to_status='cancelled')::int cancelled,
        count(*) FILTER (WHERE from_status IS NULL)::int reprints, min(at) first_at, max(at) last_at
       FROM print_job_events WHERE event_id=$1 AND user_id IS NOT NULL AND ${R("at")} GROUP BY user_id`, P(b, eventId))).rows;
  const ids = [...new Set([...mod, ...prn].map((r) => r.user_id as string))];
  const users = new Map((await pool.query("SELECT id,name,email FROM users WHERE id = ANY($1::uuid[])", [ids])).rows.map((u) => [u.id as string, u]));
  const rows: OperatorRow[] = ids.map((id) => {
    const m = mod.find((r) => r.user_id === id), p = prn.find((r) => r.user_id === id), u = users.get(id);
    const row = { approved: m?.approved ?? 0, rejected: m?.rejected ?? 0, hidden: m?.hidden ?? 0, deleted: m?.deleted ?? 0, printApproved: p?.print_approved ?? 0, held: p?.held ?? 0, cancelled: p?.cancelled ?? 0, retried: p?.retried ?? 0, reprintsRequested: p?.reprints ?? 0 };
    const times = [m?.first_at, p?.first_at].filter(Boolean) as Date[], last = [m?.last_at, p?.last_at].filter(Boolean) as Date[];
    return { userId: id, name: u?.name ?? "Removed account", email: u?.email ?? null, ...row, total: Object.values(row).reduce((a, c) => a + c, 0),
      firstAt: times.length ? new Date(Math.min(...times.map((t) => +t))).toISOString() : null, lastAt: last.length ? new Date(Math.max(...last.map((t) => +t))).toISOString() : null };
  }).sort((a, b2) => b2.total - a.total || a.name.localeCompare(b2.name));
  return { range: b.range, rows, note: OPERATOR_NOTE, generatedAt: new Date().toISOString() };
}

export async function printers(pool: Pool, eventId: string, b: Bounds): Promise<PrintersReport> {
  const fz = await frozen<PrintersReport>(pool, eventId, "printers"); if (fz) return fz;
  const rows = (await pool.query(
    `SELECT p.id, p.name, p.paper_size, d.name AS computer, p.last_seen_at,
        count(j.id) FILTER (WHERE j.status='printed')::int printed, COALESCE(sum(j.copies) FILTER (WHERE j.status='printed'),0)::int copies,
        count(j.id) FILTER (WHERE j.status='failed')::int failed,
        avg(extract(epoch FROM (j.finished_at - j.started_at))) FILTER (WHERE j.status='printed' AND j.started_at IS NOT NULL) avg_s
       FROM printers p LEFT JOIN devices d ON d.id=p.device_id
       LEFT JOIN print_jobs j ON j.printer_id=p.id AND j.event_id=p.event_id AND j.finished_at IS NOT NULL AND ${R("j.finished_at")}
      WHERE p.event_id=$1 GROUP BY p.id, d.name ORDER BY printed DESC, p.name`, P(b, eventId))).rows;
  const un = (await pool.query(
    `SELECT count(*) FILTER (WHERE status='printed')::int printed, COALESCE(sum(copies) FILTER (WHERE status='printed'),0)::int copies, count(*) FILTER (WHERE status='failed')::int failed
       FROM print_jobs WHERE event_id=$1 AND printer_id IS NULL AND finished_at IS NOT NULL AND ${R("finished_at")}`, P(b, eventId))).rows[0];
  const out: PrinterRow[] = rows.map((r) => ({ printerId: r.id, name: r.name, computer: r.computer, paper: r.paper_size, printed: r.printed, copiesPrinted: r.copies, failed: r.failed,
    successPct: r.printed + r.failed ? pct(r.printed, r.printed + r.failed) : null, avgSeconds: r.avg_s === null ? null : Math.round(Number(r.avg_s) * 10) / 10, lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null }));
  if (un.printed || un.failed) out.push({ printerId: null, name: "Not assigned to a printer", computer: null, paper: null, printed: un.printed, copiesPrinted: un.copies, failed: un.failed, successPct: pct(un.printed, un.printed + un.failed), avgSeconds: null, lastSeenAt: null });
  return { range: b.range, rows: out, generatedAt: new Date().toISOString() };
}

export const SUBMISSION_LIMIT = 50000;
export async function submissions(pool: Pool, eventId: string, b: Bounds): Promise<{ rows: SubmissionRow[]; truncated: boolean }> {
  if ((await pool.query("SELECT 1 FROM events WHERE id=$1 AND purged_at IS NOT NULL", [eventId])).rowCount) return { rows: [], truncated: false };      // the pictures are gone
  const rows = (await pool.query(
    `SELECT s.guest_code, c.created_at, c.finalized_at, f.name AS frame, c.moderation,
        (SELECT count(*)::int FROM print_jobs j WHERE j.composition_id=c.id) AS jobs,
        (SELECT count(*)::int FROM print_jobs j WHERE j.composition_id=c.id AND j.status='printed') AS printed,
        (SELECT count(*)::int FROM share_events e WHERE e.composition_id=c.id AND e.channel IN ${SHARE}) AS shares,
        (SELECT count(*)::int FROM share_events e WHERE e.composition_id=c.id AND e.channel='download') AS downloads,
        COALESCE((SELECT shown_count FROM wall_views w WHERE w.composition_id=c.id),0)::int AS wall
       FROM final_compositions c LEFT JOIN guest_sessions s ON s.id=c.session_id AND s.event_id=c.event_id LEFT JOIN frames f ON f.id=c.frame_id AND f.event_id=c.event_id
      WHERE c.event_id=$1 AND c.finalized_at IS NOT NULL AND ${R("c.finalized_at")} ORDER BY c.finalized_at LIMIT ${SUBMISSION_LIMIT + 1}`, P(b, eventId))).rows;
  const truncated = rows.length > SUBMISSION_LIMIT;
  return { truncated, rows: rows.slice(0, SUBMISSION_LIMIT).map((r) => ({ guestCode: r.guest_code, createdAt: new Date(r.created_at).toISOString(), finalizedAt: r.finalized_at ? new Date(r.finalized_at).toISOString() : null, frame: r.frame ?? "", moderation: r.moderation, printJobs: r.jobs, printed: r.printed, shareAttempts: r.shares, downloads: r.downloads, wallShown: r.wall })) };
}

/** One row per event the caller may see: for the administrator who watches all events at once. */
export async function eventsOverview(pool: Pool, eventIds: string[] | null, b: Bounds): Promise<EventsOverviewRow[]> {
  const rows = (await pool.query(
    `SELECT e.id, e.name, e.status,
        (SELECT count(*)::int FROM guest_sessions s WHERE s.event_id=e.id AND ${R("s.created_at")}) sessions,
        (SELECT count(*)::int FROM final_compositions c WHERE c.event_id=e.id AND c.finalized_at IS NOT NULL AND ${R("c.finalized_at")}) completed,
        (SELECT count(*)::int FROM print_job_events p WHERE p.event_id=e.id AND p.to_status='printed' AND ${R("p.at")}) printed,
        (SELECT count(*)::int FROM print_job_events p WHERE p.event_id=e.id AND p.to_status='failed' AND ${R("p.at")}) failed,
        (SELECT count(*)::int FROM share_events x WHERE x.event_id=e.id AND x.channel IN ${SHARE} AND ${R("x.created_at")}) shares,
        (SELECT count(*)::int FROM share_events x WHERE x.event_id=e.id AND x.channel='download' AND ${R("x.created_at")}) downloads,
        (SELECT count(*)::int FROM qr_scan_events q WHERE q.event_id=e.id AND ${R("q.at")}) scans
       FROM events e WHERE e.status<>'archived' AND ($1::uuid[] IS NULL OR e.id = ANY($1)) ORDER BY e.created_at DESC`, [eventIds, b.fromTs, b.toTs])).rows;
  const gone = new Map((await pool.query("SELECT id, retention_snapshot s FROM events WHERE purged_at IS NOT NULL AND id = ANY($1::uuid[])", [rows.map((x) => x.id)])).rows.map((x) => [x.id as string, x.s?.summary?.totals]));
  for (const x of rows) { const t = gone.get(x.id); if (t) Object.assign(x, { sessions: t.sessions, completed: t.completed, printed: t.printed, failed: t.failedAttempts, shares: t.shareAttempts, downloads: t.downloads, scans: t.scans }); }
  return rows.map((r) => ({ eventId: r.id, name: r.name, status: r.status, sessions: r.sessions, completed: r.completed, printed: r.printed, failedAttempts: r.failed, shareAttempts: r.shares, downloads: r.downloads, scans: r.scans }));
}

/** Finished pictures and completed prints per day over the last `days` days, for the events the caller may see. */
export async function activity(pool: Pool, eventIds: string[] | null, days: number, tz: string): Promise<ActivityDay[]> {
  const rows = (await pool.query(
    `WITH d AS (SELECT (g::date) AS day FROM generate_series(((now() AT TIME ZONE $3)::date - ($2::int - 1)), (now() AT TIME ZONE $3)::date, '1 day') g)
     SELECT to_char(d.day,'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM final_compositions c WHERE c.finalized_at IS NOT NULL AND (c.finalized_at AT TIME ZONE $3)::date = d.day AND ($1::uuid[] IS NULL OR c.event_id = ANY($1))) completed,
        (SELECT count(*)::int FROM print_job_events p WHERE p.to_status='printed' AND (p.at AT TIME ZONE $3)::date = d.day AND ($1::uuid[] IS NULL OR p.event_id = ANY($1))) printed
       FROM d ORDER BY d.day`, [eventIds, days, tz])).rows;
  return rows.map((r) => ({ day: r.day, completed: r.completed, printed: r.printed }));
}
