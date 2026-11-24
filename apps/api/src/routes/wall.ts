import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { WALL_IMAGE_SIZES, resolveWallStyle, wallSettingsSchema } from "@rsp/shared";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { config } from "../config";
import { getFile, sniffImage, writeStable } from "../storage";
import { notifyWall, wallBus } from "../wallBus";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{24}$/;
const MAX_ON_WALL = 500;

/** A picture may appear on the wall only when ALL of these hold. One definition, used by the list, the image route and the stats. */
const ELIGIBLE = (modRequired: string) => `
  c.event_id=$1 AND c.deleted_at IS NULL AND c.finalized_at IS NOT NULL AND c.show_on_wall
  AND c.moderation<>'rejected' AND (NOT ${modRequired} OR c.moderation='approved') AND NOT s.wall_opt_out`;

export const wallImageKeys = (eventId: string, cid: string) => WALL_IMAGE_SIZES.map((w) => `events/${eventId}/wall/${cid}-${w}.jpg`);

export async function wallRoutes(app: FastifyInstance, pool: Pool) {
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });
  const edit = requirePermission(pool, "builder:edit", { eventParam: "eventId" });

  // ----- Admin -----
  async function load(eventId: string) {
    const r = (await pool.query(
      `SELECT w.moderation_required, w.display_seconds, w.mode, w.style, w.wall_token, s.photo_wall_enabled
         FROM photo_wall_settings w JOIN event_settings s ON s.event_id=w.event_id WHERE w.event_id=$1`, [eventId])).rows[0];
    return r ?? null;
  }
  const shape = (r: any) => ({
    settings: { enabled: r.photo_wall_enabled, moderationRequired: r.moderation_required, displaySeconds: r.display_seconds, mode: r.mode, style: resolveWallStyle(r.style) },
    token: r.wall_token, path: `/w/${r.wall_token}`,
  });

  app.get("/api/v1/events/:eventId/wall", { preHandler: view }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const r = await load(eventId); if (!r) return reply.code(404).send({ error: "not_found" });
    const st = (await pool.query(
      `SELECT count(*) FILTER (WHERE c.moderation<>'rejected' AND (NOT $2 OR c.moderation='approved') AND NOT s.wall_opt_out AND c.show_on_wall)::int eligible,
              count(*) FILTER (WHERE c.moderation='pending' AND c.show_on_wall AND NOT s.wall_opt_out)::int pending,
              count(*) FILTER (WHERE s.wall_opt_out)::int opted_out,
              count(*) FILTER (WHERE NOT c.show_on_wall)::int hidden
         FROM final_compositions c JOIN guest_sessions s ON s.id=c.session_id
        WHERE c.event_id=$1 AND c.deleted_at IS NULL AND c.finalized_at IS NOT NULL`, [eventId, r.moderation_required])).rows[0];
    const sh = (await pool.query("SELECT COALESCE(sum(shown_count),0)::int total, count(*)::int pictures FROM wall_views WHERE event_id=$1", [eventId])).rows[0];
    return { ...shape(r), stats: { eligible: st.eligible, pendingModeration: st.pending, optedOut: st.opted_out, hidden: st.hidden, totalShown: sh.total, picturesShown: sh.pictures } };
  });

  app.put("/api/v1/events/:eventId/wall", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const b = wallSettingsSchema.parse(req.body);
    if (!(await load(eventId))) return reply.code(404).send({ error: "not_found" });
    await withTx(pool, async (tx) => {
      await tx.query("UPDATE photo_wall_settings SET moderation_required=$2, display_seconds=$3, mode=$4, style=$5 WHERE event_id=$1", [eventId, b.moderationRequired, b.displaySeconds, b.mode, JSON.stringify(b.style)]);
      await tx.query("UPDATE event_settings SET photo_wall_enabled=$2 WHERE event_id=$1", [eventId, b.enabled]);
      await audit(tx, req.user!.id, "wall_update", { eventId, entity: "wall", detail: { enabled: b.enabled, mode: b.mode, moderationRequired: b.moderationRequired }, ip: req.ip });
    });
    notifyWall(eventId);
    return shape((await load(eventId))!);
  });

  app.post("/api/v1/events/:eventId/wall/regenerate-token", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const token = randomBytes(12).toString("hex");
    const r = await pool.query("UPDATE photo_wall_settings SET wall_token=$2 WHERE event_id=$1", [eventId, token]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, "wall_token_regenerate", { eventId, entity: "wall", ip: req.ip });
    notifyWall(eventId);                       // open displays re-check and find their old link dead
    return { token, path: `/w/${token}` };
  });

  // ----- Public display (no login: the unguessable link is the key; it is shown on a TV) -----
  async function wallFor(token: string) {
    if (!TOKEN.test(token)) return null;
    const r = (await pool.query(
      `SELECT e.id, e.name, e.hashtag, e.status, w.moderation_required, w.display_seconds, w.mode, w.style, s.photo_wall_enabled, s.branding, e.guest_token
         FROM photo_wall_settings w JOIN events e ON e.id=w.event_id JOIN event_settings s ON s.event_id=e.id
        WHERE w.wall_token=$1`, [token])).rows[0];
    // A disabled wall or an event that is not live shows nothing at all, exactly like an unknown link.
    return r && r.photo_wall_enabled && r.status === "active" ? r : null;
  }

  async function eligible(eventId: string, modRequired: boolean, limit = MAX_ON_WALL) {
    return (await pool.query(
      `SELECT c.id, c.width_px, c.height_px, c.created_at, COALESCE(c.finalized_at,c.created_at) AS at
         FROM final_compositions c JOIN guest_sessions s ON s.id=c.session_id
        WHERE ${ELIGIBLE("$2")} ORDER BY COALESCE(c.finalized_at,c.created_at) DESC, c.id LIMIT ${limit}`, [eventId, modRequired])).rows;
  }

  app.get("/api/v1/public/w/:token", async (req, reply) => {
    const w = await wallFor((req.params as any).token);
    if (!w) return reply.code(404).send({ error: "not_available" });
    const b = w.branding ?? {};
    return {
      event: { name: w.name, hashtag: w.hashtag },
      settings: { displaySeconds: w.display_seconds, mode: w.mode, style: resolveWallStyle(w.style) },
      logos: { event: !!b.eventLogo, client: !!b.clientLogo },
      joinPath: `/g/${w.guest_token}`,
      imageSizes: WALL_IMAGE_SIZES,
    };
  });

  app.get("/api/v1/public/w/:token/photos", async (req, reply) => {
    const w = await wallFor((req.params as any).token);
    if (!w) return reply.code(404).send({ error: "not_available" });
    const rows = await eligible(w.id, w.moderation_required);
    return { photos: rows.map((r) => ({ id: r.id, width: r.width_px, height: r.height_px, at: r.at })), serverTime: new Date().toISOString() };
  });

  app.get("/api/v1/public/w/:token/img/:cid", async (req, reply) => {
    const { token, cid } = req.params as { token: string; cid: string };
    const size = z.coerce.number().int().refine((n) => (WALL_IMAGE_SIZES as readonly number[]).includes(n)).default(1600).safeParse((req.query as any).w);
    if (!UUID.test(cid) || !size.success) return reply.code(404).send({ error: "not_found" });
    const w = await wallFor(token);
    if (!w) return reply.code(404).send({ error: "not_found" });
    // Only a picture that is allowed on the wall RIGHT NOW is served (a hidden, rejected, opted-out or deleted one is gone).
    const c = (await pool.query(
      `SELECT c.storage_key FROM final_compositions c JOIN guest_sessions s ON s.id=c.session_id
        WHERE ${ELIGIBLE("$3")} AND c.id=$2`, [w.id, cid, w.moderation_required])).rows[0];
    if (!c) return reply.code(404).send({ error: "not_found" });
    const key = `events/${w.id}/wall/${cid}-${size.data}.jpg`;
    let data: Buffer;
    try { data = await getFile(key); } catch {
      data = await sharp(await getFile(c.storage_key)).rotate().resize({ width: size.data, height: size.data, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      await writeStable(key, data);
    }
    reply.header("Cache-Control", "private, max-age=300");
    return reply.type("image/jpeg").send(data);
  });

  app.get("/api/v1/public/w/:token/logo/:kind", async (req, reply) => {
    const p = req.params as any;
    const w = await wallFor(p.token);
    const field = p.kind === "client" ? "clientLogo" : p.kind === "event" ? "eventLogo" : null;
    const key = w && field ? (w.branding ?? {})[field] : null;
    if (!key) return reply.code(404).send({ error: "not_found" });
    let data: Buffer; try { data = await getFile(key); } catch { return reply.code(404).send({ error: "not_found" }); }
    reply.header("Content-Type", sniffImage(data)!.mime);
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(data);
  });

  /** "Something changed" ticks. The display also polls, so a dropped stream only delays an update. */
  app.get("/api/v1/public/w/:token/stream", async (req, reply) => {
    const w = await wallFor((req.params as any).token);
    if (!w) return reply.code(404).send({ error: "not_available" });
    const eventId = w.id as string;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    res.write("retry: 3000\n\nevent: hello\ndata: {}\n\n");
    const tick = () => res.write("event: tick\ndata: {}\n\n");
    wallBus.on(eventId, tick);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    const done = () => { clearInterval(ping); wallBus.off(eventId, tick); };
    req.raw.on("close", done); res.on("error", done);
  });

  /** The display reports what it actually showed; only pictures that are eligible now are counted. */
  app.post("/api/v1/public/w/:token/shown", { config: { rateLimit: { max: () => config.guestRateLimitPerMin, timeWindow: "1 minute" } } }, async (req, reply) => {
    const w = await wallFor((req.params as any).token);
    if (!w) return reply.code(404).send({ error: "not_available" });
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).parse(req.body);
    const uniq = [...new Set(ids)];
    const r = await pool.query(
      `INSERT INTO wall_views(composition_id,event_id,shown_count)
       SELECT c.id,$1::uuid,1 FROM final_compositions c JOIN guest_sessions s ON s.id=c.session_id WHERE ${ELIGIBLE("$3")} AND c.id = ANY($2)
       ON CONFLICT (composition_id) DO UPDATE SET shown_count=wall_views.shown_count+1, last_shown_at=now()`, [w.id, uniq, w.moderation_required]);
    return { counted: r.rowCount };
  });
}
