import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { MAX_SPONSORS_PER_EVENT, cleanTag, resolvePlacement, sponsorInputSchema } from "@rsp/shared";
import type { Pool } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { deleteFile, getFile, putFile, sniffImage, svgIsSafe } from "../storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Sponsors a guest screen or the wall may show: active ones, with the right placement. Nothing private is included. */
export async function publicSponsors(pool: Pool, eventId: string, where: "guest" | "wall") {
  const rows = (await pool.query("SELECT s.id,s.name,s.url,s.hashtag,s.logo_asset,s.placement, EXISTS (SELECT 1 FROM frames f WHERE f.sponsor_id=s.id AND f.event_id=s.event_id AND f.active) AS framed FROM sponsors s WHERE s.event_id=$1 AND s.active ORDER BY s.position,s.created_at", [eventId])).rows;
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, url: (r.url as string | null) ?? null, hashtag: cleanTag(r.hashtag) || null, hasLogo: !!r.logo_asset, placement: resolvePlacement(r.placement), framed: !!r.framed }))
    // A guest needs a sponsor when it is shown on guest screens, adds a hashtag, or owns a frame (its logo is part of the frame preview).
    .filter((s) => (where === "guest" ? s.placement.guest || !!s.hashtag || s.framed : s.placement.wall && s.hasLogo))
    .map(({ framed: _framed, ...s }) => s);
}

/** Serves a sponsor's logo only while the sponsor is active; the sandbox CSP keeps an SVG from ever running script. */
export async function sendSponsorLogo(pool: Pool, reply: FastifyReply, eventId: string, id: string, opts: { requireActive: boolean; where?: "guest" | "wall" }) {
  if (!UUID.test(id)) return reply.code(404).send({ error: "not_found" });
  const r = (await pool.query("SELECT s.logo_asset,s.active,s.placement, EXISTS (SELECT 1 FROM frames f WHERE f.sponsor_id=s.id AND f.event_id=s.event_id AND f.active) AS framed FROM sponsors s WHERE s.id=$1 AND s.event_id=$2", [id, eventId])).rows[0];
  if (!r?.logo_asset || (opts.requireActive && !r.active)) return reply.code(404).send({ error: "not_found" });
  if (opts.where && !resolvePlacement(r.placement)[opts.where] && !(opts.where === "guest" && r.framed)) return reply.code(404).send({ error: "not_found" });
  let data: Buffer; try { data = await getFile(r.logo_asset); } catch { return reply.code(404).send({ error: "not_found" }); }
  reply.header("Content-Type", sniffImage(data)?.mime ?? "application/octet-stream");
  reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  if (opts.requireActive) reply.header("Cache-Control", "private, max-age=60");
  return reply.send(data);
}

export async function sponsorRoutes(app: FastifyInstance, pool: Pool) {
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });
  const edit = requirePermission(pool, "builder:edit", { eventParam: "eventId" });

  const shape = (r: any) => ({
    id: r.id, name: r.name, url: r.url, hashtag: r.hashtag, active: r.active, position: r.position, hasLogo: !!r.logo_asset,
    placement: resolvePlacement(r.placement), frames: r.frames ?? 0, createdAt: r.created_at,
  });
  async function one(eventId: string, id: string) {
    if (!UUID.test(id)) return null;
    return (await pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM frames f WHERE f.sponsor_id=s.id AND f.event_id=s.event_id) AS frames FROM sponsors s WHERE s.id=$1 AND s.event_id=$2`, [id, eventId])).rows[0] ?? null;
  }

  app.get("/api/v1/events/:eventId/sponsors", { preHandler: view }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const rows = (await pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM frames f WHERE f.sponsor_id=s.id AND f.event_id=s.event_id) AS frames
         FROM sponsors s WHERE s.event_id=$1 ORDER BY s.position, s.created_at`, [eventId])).rows;
    return { sponsors: rows.map(shape), max: MAX_SPONSORS_PER_EVENT };
  });

  app.post("/api/v1/events/:eventId/sponsors", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const b = sponsorInputSchema.partial().required({ name: true }).parse(req.body);
    const n = (await pool.query("SELECT count(*)::int c, COALESCE(max(position),-1)+1 p FROM sponsors WHERE event_id=$1", [eventId])).rows[0];
    if (n.c >= MAX_SPONSORS_PER_EVENT) return reply.code(409).send({ error: "too_many_sponsors" });
    const r = (await pool.query(
      "INSERT INTO sponsors(event_id,name,url,hashtag,active,placement,position) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [eventId, b.name, b.url ?? null, cleanTag(b.hashtag) || null, b.active ?? true, JSON.stringify(resolvePlacement(b.placement)), n.p])).rows[0];
    await audit(pool, req.user!.id, "sponsor_create", { eventId, entity: "sponsor", entityId: r.id, detail: { name: b.name }, ip: req.ip });
    return reply.code(201).send({ sponsor: shape(await one(eventId, r.id)) });
  });

  app.put("/api/v1/events/:eventId/sponsors/:id", { preHandler: edit }, async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string };
    const b = sponsorInputSchema.parse(req.body);
    if (!(await one(eventId, id))) return reply.code(404).send({ error: "not_found" });
    await pool.query("UPDATE sponsors SET name=$3,url=$4,hashtag=$5,active=$6,placement=$7 WHERE id=$1 AND event_id=$2",
      [id, eventId, b.name, b.url, cleanTag(b.hashtag) || null, b.active, JSON.stringify(b.placement)]);
    await audit(pool, req.user!.id, "sponsor_update", { eventId, entity: "sponsor", entityId: id, detail: { active: b.active }, ip: req.ip });
    return { sponsor: shape(await one(eventId, id)) };
  });

  app.post("/api/v1/events/:eventId/sponsors/reorder", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_SPONSORS_PER_EVENT) }).parse(req.body);
    const have = (await pool.query("SELECT id FROM sponsors WHERE event_id=$1", [eventId])).rows.map((r) => r.id as string);
    if (new Set(ids).size !== ids.length || ids.length !== have.length || ids.some((i) => !have.includes(i))) return reply.code(400).send({ error: "ids_mismatch" });
    for (let i = 0; i < ids.length; i++) await pool.query("UPDATE sponsors SET position=$3 WHERE id=$1 AND event_id=$2", [ids[i], eventId, i]);
    return { ok: true };
  });

  app.delete("/api/v1/events/:eventId/sponsors/:id", { preHandler: edit }, async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string };
    const cur = await one(eventId, id); if (!cur) return reply.code(404).send({ error: "not_found" });
    await pool.query("DELETE FROM sponsors WHERE id=$1 AND event_id=$2", [id, eventId]);          // frames keep existing; their sponsor link is cleared by the foreign key
    if (cur.logo_asset) await deleteFile(cur.logo_asset).catch(() => {});
    await audit(pool, req.user!.id, "sponsor_delete", { eventId, entity: "sponsor", entityId: id, detail: { name: cur.name, frames: cur.frames }, ip: req.ip });
    return { ok: true, framesUnlinked: cur.frames };
  });

  // ----- Logo: raw image body, checked by its bytes, replaced atomically -----
  app.post("/api/v1/events/:eventId/sponsors/:id/logo", { preHandler: edit, bodyLimit: MAX_LOGO_BYTES + 1024 }, async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string };
    const cur = await one(eventId, id); if (!cur) return reply.code(404).send({ error: "not_found" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(415).send({ error: "image_required" });
    if (body.length > MAX_LOGO_BYTES) return reply.code(413).send({ error: "too_large", maxMb: 2 });
    const t = sniffImage(body);
    if (!t) return reply.code(415).send({ error: "unsupported_image" });
    if (t.ext === "svg" && !svgIsSafe(body.toString("utf8"))) return reply.code(422).send({ error: "unsafe_svg" });
    const key = await putFile(`events/${eventId}/sponsors`, t.ext, body);
    await pool.query("UPDATE sponsors SET logo_asset=$3 WHERE id=$1 AND event_id=$2", [id, eventId, key]);
    if (cur.logo_asset) await deleteFile(cur.logo_asset).catch(() => {});
    await audit(pool, req.user!.id, "sponsor_logo", { eventId, entity: "sponsor", entityId: id, detail: { bytes: body.length, type: t.ext }, ip: req.ip });
    return reply.code(201).send({ sponsor: shape(await one(eventId, id)) });
  });

  app.delete("/api/v1/events/:eventId/sponsors/:id/logo", { preHandler: edit }, async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string };
    const cur = await one(eventId, id); if (!cur) return reply.code(404).send({ error: "not_found" });
    await pool.query("UPDATE sponsors SET logo_asset=NULL WHERE id=$1 AND event_id=$2", [id, eventId]);
    if (cur.logo_asset) await deleteFile(cur.logo_asset).catch(() => {});
    return { sponsor: shape(await one(eventId, id)) };
  });

  app.get("/api/v1/events/:eventId/sponsors/:id/logo", { preHandler: view }, async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string };
    return sendSponsorLogo(pool, reply, eventId, id, { requireActive: false });
  });

  // ----- Public: a logo is reachable only while the sponsor is active and set to show in that place -----
  app.get("/api/v1/public/g/:token/sponsor/:id/logo", async (req, reply) => {
    const { token, id } = req.params as { token: string; id: string };
    const e = /^[0-9a-f]{24}$/.test(token) ? (await pool.query("SELECT id FROM events WHERE guest_token=$1 AND status='active'", [token])).rows[0] : null;
    if (!e) return reply.code(404).send({ error: "not_found" });
    return sendSponsorLogo(pool, reply, e.id, id, { requireActive: true, where: "guest" });
  });
  app.get("/api/v1/public/w/:token/sponsor/:id/logo", async (req, reply) => {
    const { token, id } = req.params as { token: string; id: string };
    const e = /^[0-9a-f]{24}$/.test(token) ? (await pool.query(
      `SELECT e.id FROM photo_wall_settings w JOIN events e ON e.id=w.event_id JOIN event_settings s ON s.event_id=e.id
        WHERE w.wall_token=$1 AND e.status='active' AND s.photo_wall_enabled`, [token])).rows[0] : null;
    if (!e) return reply.code(404).send({ error: "not_found" });
    return sendSponsorLogo(pool, reply, e.id, id, { requireActive: true, where: "wall" });
  });
}
