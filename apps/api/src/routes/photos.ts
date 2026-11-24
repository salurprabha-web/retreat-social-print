import type { FastifyInstance } from "fastify";
import archiver from "archiver";
import sharp from "sharp";
import { z } from "zod";
import type { Pool, Tx } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { can, requirePermission } from "../auth";
import { deleteFile, getFile, putFile, streamFile } from "../storage";
import { notifyWall } from "../wallBus";
import { wallImageKeys } from "./wall";
import { mosaicTileKey } from "../mosaicService";
import { cancelJobsForCompositions } from "../printService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THUMB_SIZES = [200, 400, 800] as const;
const MODERATION = ["pending", "approved", "rejected"] as const;

const listQuery = z.object({
  status: z.enum(MODERATION).optional(),
  q: z.string().trim().max(20).optional(),                       // guest ID (prefix)
  frameId: z.string().uuid().optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  wall: z.enum(["true", "false"]).optional(),
  finalized: z.enum(["true", "false"]).optional(),                // only pictures the guest finished (true) or abandoned drafts (false)
  sort: z.enum(["newest", "oldest"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(48),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function photoRoutes(app: FastifyInstance, pool: Pool) {
  const operate = requirePermission(pool, "print:operate", { eventParam: "eventId" });
  const manage = requirePermission(pool, "builder:edit", { eventParam: "eventId" });

  /** WHERE clause shared by the list, the counts and the export. `skipStatus` lets the counts ignore the status filter. */
  function where(eventId: string, f: z.infer<typeof listQuery>, skipStatus = false) {
    const v: unknown[] = [eventId];
    const add = (x: unknown) => { v.push(x); return `$${v.length}`; };
    const w = ["c.event_id=$1", "c.deleted_at IS NULL"];
    if (f.status && !skipStatus) w.push(`c.moderation=${add(f.status)}`);
    if (f.q) w.push(`s.guest_code ILIKE ${add(f.q.replace(/[%_\\]/g, "\\$&") + "%")}`);
    if (f.frameId) w.push(`c.frame_id=${add(f.frameId)}`);
    if (f.from) w.push(`c.created_at >= ${add(f.from)}`);
    if (f.to) w.push(`c.created_at < ${add(f.to)}`);
    if (f.wall) w.push(`c.show_on_wall=${add(f.wall === "true")}`);
    if (f.finalized) w.push(f.finalized === "true" ? "c.finalized_at IS NOT NULL" : "c.finalized_at IS NULL");
    return { sql: w.join(" AND "), v };
  }
  const FROM = `FROM final_compositions c
      LEFT JOIN guest_sessions s ON s.id=c.session_id AND s.event_id=c.event_id
      JOIN frames f ON f.id=c.frame_id AND f.event_id=c.event_id
      LEFT JOIN users u ON u.id=c.moderated_by`;
  const SLOTS = `(SELECT COALESCE(json_agg(json_build_object('slot',cp.slot,'uploadId',cp.upload_id,'width',up.width,'height',up.height) ORDER BY cp.slot),'[]'::json)
                    FROM composition_photos cp JOIN photo_uploads up ON up.id=cp.upload_id AND up.event_id=cp.event_id WHERE cp.composition_id=c.id) AS slots`;
  const COLS = `c.id,c.width_px,c.height_px,c.bytes,c.moderation,c.moderation_note,c.moderated_at,c.show_on_wall,c.created_at,c.finalized_at,s.guest_code,
      f.id AS frame_id,f.name AS frame_name,u.name AS moderator,
      (SELECT count(*)::int FROM share_events se WHERE se.composition_id=c.id AND se.channel='download') AS downloads,
      (SELECT count(*)::int FROM share_events se WHERE se.composition_id=c.id AND se.channel<>'download') AS share_attempts,
      (SELECT count(*)::int FROM print_jobs pj WHERE pj.composition_id=c.id) AS print_jobs,
      ${SLOTS}`;
  const shape = (r: any) => ({
    id: r.id, guestCode: r.guest_code, frame: { id: r.frame_id, name: r.frame_name }, widthPx: r.width_px, heightPx: r.height_px, bytes: Number(r.bytes),
    moderation: r.moderation, moderationNote: r.moderation_note, moderatedBy: r.moderator, moderatedAt: r.moderated_at, showOnWall: r.show_on_wall, finalized: !!r.finalized_at,
    createdAt: r.created_at, downloads: r.downloads, shareAttempts: r.share_attempts, printJobs: r.print_jobs, slots: r.slots,
  });

  app.get("/api/v1/events/:eventId/compositions", { preHandler: operate }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const f = listQuery.parse(req.query);
    const w = where(eventId, f); const wc = where(eventId, f, true);
    const order = f.sort === "oldest" ? "ASC" : "DESC";
    const rows = (await pool.query(`SELECT ${COLS} ${FROM} WHERE ${w.sql} ORDER BY c.created_at ${order}, c.id LIMIT ${f.limit} OFFSET ${f.offset}`, w.v)).rows;
    const total = (await pool.query(`SELECT count(*)::int c ${FROM} WHERE ${w.sql}`, w.v)).rows[0].c;
    const cnt = (await pool.query(`SELECT c.moderation, count(*)::int n ${FROM} WHERE ${wc.sql} GROUP BY c.moderation`, wc.v)).rows;
    const counts = { pending: 0, approved: 0, rejected: 0, all: 0 } as Record<string, number>;
    for (const r of cnt) { counts[r.moderation] = r.n; counts.all += r.n; }
    return { compositions: rows.map(shape), total, counts, limit: f.limit, offset: f.offset };
  });

  app.get("/api/v1/events/:eventId/compositions/:cid", { preHandler: operate }, async (req, reply) => {
    const { eventId, cid } = req.params as { eventId: string; cid: string };
    if (!UUID.test(cid)) return reply.code(404).send({ error: "not_found" });
    const r = (await pool.query(`SELECT ${COLS}, s.id AS session_id, s.consent_at, s.fields, s.created_at AS session_at ${FROM} WHERE c.event_id=$1 AND c.id=$2 AND c.deleted_at IS NULL`, [eventId, cid])).rows[0];
    if (!r) return reply.code(404).send({ error: "not_found" });
    const jobs = (await pool.query("SELECT status,count(*)::int n FROM print_jobs WHERE composition_id=$1 GROUP BY status", [cid])).rows;
    const pii = can(req.user!, "builder:edit", eventId);       // contact details only for managers; operators see the guest ID
    return {
      composition: shape(r), printJobsByStatus: Object.fromEntries(jobs.map((j) => [j.status, j.n])),
      guest: { code: r.guest_code, startedAt: r.session_at, consentAt: r.consent_at, fields: pii ? r.fields : undefined, fieldsHidden: !pii },
    };
  });

  // ----- Thumbnails (cached on disk beside the event's other files) -----
  async function thumb(eventId: string, kind: "c" | "u", id: string, size: number, srcKey: string): Promise<Buffer> {
    const key = `events/${eventId}/thumbs/${kind}-${id}-${size}.jpg`;
    try { return await getFile(key); } catch { /* not cached yet */ }
    const out = await sharp(await getFile(srcKey)).rotate().resize({ width: size, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    // putFile makes random names; thumbs need a stable name, so write through the storage helper's directory API
    const { writeStable } = await import("../storage");
    await writeStable(key, out);
    return out;
  }
  app.get("/api/v1/events/:eventId/compositions/:cid/thumb", { preHandler: operate }, async (req, reply) => {
    const { eventId, cid } = req.params as { eventId: string; cid: string };
    const size = z.coerce.number().int().refine((n) => (THUMB_SIZES as readonly number[]).includes(n)).default(400).safeParse((req.query as any).size);
    if (!UUID.test(cid) || !size.success) return reply.code(404).send({ error: "not_found" });
    const c = (await pool.query("SELECT storage_key FROM final_compositions WHERE id=$1 AND event_id=$2 AND deleted_at IS NULL", [cid, eventId])).rows[0];
    if (!c) return reply.code(404).send({ error: "not_found" });
    return reply.type("image/jpeg").send(await thumb(eventId, "c", cid, size.data, c.storage_key));
  });
  app.get("/api/v1/events/:eventId/uploads/:uid/thumb", { preHandler: operate }, async (req, reply) => {
    const { eventId, uid } = req.params as { eventId: string; uid: string };
    const size = z.coerce.number().int().refine((n) => (THUMB_SIZES as readonly number[]).includes(n)).default(400).safeParse((req.query as any).size);
    if (!UUID.test(uid) || !size.success) return reply.code(404).send({ error: "not_found" });
    const u = (await pool.query("SELECT storage_key FROM photo_uploads WHERE id=$1 AND event_id=$2 AND deleted_at IS NULL", [uid, eventId])).rows[0];
    if (!u) return reply.code(404).send({ error: "not_found" });
    return reply.type("image/jpeg").send(await thumb(eventId, "u", uid, size.data, u.storage_key));
  });

  // ----- Moderation -----
  const bulkSchema = z.object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    action: z.enum(["approve", "reject", "pending", "show_wall", "hide_wall", "delete"]),
    note: z.string().trim().max(300).optional(),
    confirmPrinted: z.boolean().optional(),
  });

  /** Removes pictures, the originals only they used, cached thumbnails and the files, after the database commit. */
  async function removeCompositions(tx: Tx, eventId: string, ids: string[]): Promise<string[]> {
    const keys: string[] = [];
    const comps = (await tx.query("SELECT id,storage_key FROM final_compositions WHERE id = ANY($1) AND event_id=$2", [ids, eventId])).rows;
    const ups = (await tx.query("SELECT DISTINCT cp.upload_id FROM composition_photos cp WHERE cp.composition_id = ANY($1) AND cp.event_id=$2", [ids, eventId])).rows.map((r) => r.upload_id as string);
    await tx.query("DELETE FROM final_compositions WHERE id = ANY($1) AND event_id=$2", [ids, eventId]);
    const orphan = (await tx.query(
      `DELETE FROM photo_uploads u WHERE u.id = ANY($1) AND u.event_id=$2
          AND NOT EXISTS (SELECT 1 FROM composition_photos cp WHERE cp.upload_id=u.id)
          AND NOT EXISTS (SELECT 1 FROM final_compositions f WHERE f.upload_id=u.id) RETURNING id,storage_key`, [ups, eventId])).rows;
    for (const c of comps) { keys.push(c.storage_key, mosaicTileKey(eventId, c.id), ...wallImageKeys(eventId, c.id)); for (const s of THUMB_SIZES) keys.push(`events/${eventId}/thumbs/c-${c.id}-${s}.jpg`); }
    for (const o of orphan) { keys.push(o.storage_key); for (const s of THUMB_SIZES) keys.push(`events/${eventId}/thumbs/u-${o.id}-${s}.jpg`); }
    return keys;
  }

  app.post("/api/v1/events/:eventId/compositions/bulk", { preHandler: operate }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const b = bulkSchema.parse(req.body);
    const ids = [...new Set(b.ids)];
    const existing = (await pool.query("SELECT id FROM final_compositions WHERE id = ANY($1) AND event_id=$2 AND deleted_at IS NULL", [ids, eventId])).rows.map((r) => r.id as string);
    const missing = ids.filter((i) => !existing.includes(i));
    if (!existing.length) return reply.code(404).send({ error: "not_found", missing });

    if (b.action === "delete") {
      const withJobs = new Set((await pool.query("SELECT DISTINCT composition_id FROM print_jobs WHERE composition_id = ANY($1)", [existing])).rows.map((r) => r.composition_id as string));
      const blocked = b.confirmPrinted ? [] : existing.filter((i) => withJobs.has(i));
      const doomed = existing.filter((i) => !blocked.includes(i));
      let keys: string[] = [];
      if (doomed.length) keys = await withTx(pool, async (tx) => {
        const k = await removeCompositions(tx, eventId, doomed);
        await audit(tx, req.user!.id, "photo_delete", { eventId, entity: "composition", detail: { ids: doomed, withPrintJobs: doomed.filter((i) => withJobs.has(i)) }, ip: req.ip });
        return k;
      });
      for (const k of keys) await deleteFile(k).catch(() => {});
      notifyWall(eventId);
      return { deleted: doomed.length, blocked, missing };
    }

    if (b.action === "show_wall" || b.action === "hide_wall") {
      const r = await pool.query("UPDATE final_compositions SET show_on_wall=$3 WHERE id = ANY($1) AND event_id=$2 AND deleted_at IS NULL", [existing, eventId, b.action === "show_wall"]);
      await audit(pool, req.user!.id, b.action, { eventId, entity: "composition", detail: { ids: existing }, ip: req.ip });
      notifyWall(eventId);
      return { updated: r.rowCount, missing };
    }
    const status = ({ approve: "approved", reject: "rejected", pending: "pending" } as const)[b.action];
    const r = await pool.query(
      `UPDATE final_compositions SET moderation=$3, moderated_by=$4, moderated_at=now(), moderation_note=$5 WHERE id = ANY($1) AND event_id=$2 AND deleted_at IS NULL`,
      [existing, eventId, status, req.user!.id, b.note || null]);
    await audit(pool, req.user!.id, `photo_${status}`, { eventId, entity: "composition", detail: { ids: existing, note: b.note ?? null }, ip: req.ip });
    if (status === "rejected") await cancelJobsForCompositions(pool, eventId, existing, req.user!.id, "Picture rejected");
    notifyWall(eventId);
    return { updated: r.rowCount, missing };
  });

  // Single-item convenience wrappers around the same logic.
  app.post("/api/v1/events/:eventId/compositions/:cid/moderation", { preHandler: operate }, async (req, reply) => {
    const { eventId, cid } = req.params as { eventId: string; cid: string };
    if (!UUID.test(cid)) return reply.code(404).send({ error: "not_found" });
    const b = z.object({ status: z.enum(MODERATION), note: z.string().trim().max(300).optional() }).parse(req.body);
    const r = await pool.query(
      `UPDATE final_compositions SET moderation=$3, moderated_by=$4, moderated_at=now(), moderation_note=$5 WHERE id=$1 AND event_id=$2 AND deleted_at IS NULL`,
      [cid, eventId, b.status, req.user!.id, b.note || null]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, `photo_${b.status}`, { eventId, entity: "composition", entityId: cid, detail: { note: b.note ?? null }, ip: req.ip });
    if (b.status === "rejected") await cancelJobsForCompositions(pool, eventId, [cid], req.user!.id, "Picture rejected");
    notifyWall(eventId);
    return { ok: true };
  });

  // ----- Privacy: remove everything about one guest -----
  app.delete("/api/v1/events/:eventId/guests/:code", { preHandler: manage }, async (req, reply) => {
    const { eventId, code } = req.params as { eventId: string; code: string };
    if (!/^G[A-Z0-9]{5}$/.test(code)) return reply.code(404).send({ error: "not_found" });
    const s = (await pool.query("SELECT id FROM guest_sessions WHERE event_id=$1 AND guest_code=$2", [eventId, code])).rows[0];
    if (!s) return reply.code(404).send({ error: "not_found" });
    const keys: string[] = [];
    const counts = await withTx(pool, async (tx) => {
      const comps = (await tx.query("SELECT id,storage_key FROM final_compositions WHERE session_id=$1 AND event_id=$2", [s.id, eventId])).rows;
      const ups = (await tx.query("SELECT id,storage_key FROM photo_uploads WHERE session_id=$1 AND event_id=$2", [s.id, eventId])).rows;
      for (const c of comps) { keys.push(c.storage_key, mosaicTileKey(eventId, c.id), ...wallImageKeys(eventId, c.id)); for (const z of THUMB_SIZES) keys.push(`events/${eventId}/thumbs/c-${c.id}-${z}.jpg`); }
      for (const u of ups) { keys.push(u.storage_key); for (const z of THUMB_SIZES) keys.push(`events/${eventId}/thumbs/u-${u.id}-${z}.jpg`); }
      await tx.query("DELETE FROM guest_sessions WHERE id=$1 AND event_id=$2", [s.id, eventId]);   // cascades uploads, pictures, shares and print jobs
      await audit(tx, req.user!.id, "guest_data_delete", { eventId, entity: "guest", entityId: code, detail: { pictures: comps.length, originals: ups.length }, ip: req.ip });
      return { pictures: comps.length, originals: ups.length };
    });
    for (const k of keys) await deleteFile(k).catch(() => {});
    notifyWall(eventId);
    return { ok: true, ...counts };
  });

  // ----- Export: ZIP of final images (streamed, never held in memory) -----
  app.get("/api/v1/events/:eventId/compositions-export", { preHandler: operate }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const f = listQuery.parse({ status: "approved", ...(req.query as object), limit: 100, offset: 0 });
    const w = where(eventId, f);
    const rows = (await pool.query(`SELECT c.id,c.storage_key,s.guest_code,c.created_at ${FROM} WHERE ${w.sql} ORDER BY c.created_at LIMIT 5000`, w.v)).rows;
    await audit(pool, req.user!.id, "photo_export", { eventId, entity: "composition", detail: { count: rows.length, status: f.status ?? "all" }, ip: req.ip });
    const zip = archiver("zip", { zlib: { level: 0 } });          // JPEGs do not compress; store them
    zip.on("error", (e: Error) => req.log?.error?.(e));
    rows.forEach((r, i) => zip.append(streamFile(r.storage_key), { name: `${String(i + 1).padStart(4, "0")}-${r.guest_code ?? "guest"}-${String(r.id).slice(0, 8)}.jpg` }));
    void zip.finalize();
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", 'attachment; filename="photos.zip"');
    return reply.send(zip);
  });
}
