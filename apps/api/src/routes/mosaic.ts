import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { MOSAIC_PREVIEW_WIDTHS, mosaicPercent, mosaicSettingsSchema, resolveMosaicSettings } from "@rsp/shared";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { config } from "../config";
import { copyFile, deleteFile, getFile, presignPut, putFile, sniffImage, statFile } from "../storage";
import { signUploadTicket, verifyUploadTicket } from "../signing";
import { clearTiles, currentVersion, ensureProject, renderCurrent, setGrid, syncMosaic, type Project } from "../mosaicService";

const TOKEN = /^[0-9a-f]{24}$/;
const MAX_MASTER_BYTES = 25 * 1024 * 1024;
const MIN_MASTER_SIDE = 200;

export async function mosaicRoutes(app: FastifyInstance, pool: Pool) {
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });
  const edit = requirePermission(pool, "builder:edit", { eventParam: "eventId" });

  async function describe(p: Project, sync: boolean) {
    const s = resolveMosaicSettings(p.settings);
    const hasMaster = !!(p.master_storage_key && p.cols && p.rows);
    const r = hasMaster && sync ? await syncMosaic(pool, p.event_id) : { cells: (p.cols ?? 0) * (p.rows ?? 0), filled: 0, eligible: 0, left: 0 };
    return {
      settings: { ...s, enabled: p.enabled }, token: p.mosaic_token, path: `/m/${p.mosaic_token}`,
      master: hasMaster ? { width: p.master_width, height: p.master_height } : null,
      grid: hasMaster ? { cols: p.cols, rows: p.rows, cells: p.cols! * p.rows! } : null,
      stats: { cells: r.cells, filled: r.filled, percent: mosaicPercent(r.filled, r.cells), eligible: r.eligible, unused: r.left ? 0 : Math.max(0, r.eligible - r.filled), processing: r.left },
    };
  }

  // ----- Admin -----
  app.get("/api/v1/events/:eventId/mosaic", { preHandler: view }, async (req) => {
    const p = await ensureProject(pool, (req.params as any).eventId);
    return describe(p, p.enabled);
  });

  app.put("/api/v1/events/:eventId/mosaic", { preHandler: edit }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const { enabled, ...s } = mosaicSettingsSchema.parse(req.body);
    const p = await ensureProject(pool, eventId);
    await withTx(pool, async (tx) => {
      await tx.query("UPDATE mosaic_projects SET settings=$2, updated_at=now() WHERE event_id=$1", [eventId, JSON.stringify(s)]);
      await tx.query("UPDATE event_settings SET mosaic_enabled=$2 WHERE event_id=$1", [eventId, enabled]);
      await audit(tx, req.user!.id, "mosaic_update", { eventId, entity: "mosaic", detail: { enabled, tileTarget: s.tileTarget, moderationRequired: s.moderationRequired }, ip: req.ip });
    });
    if (p.master_storage_key && p.tile_count !== s.tileTarget) {            // a different tile count means a different grid: pictures are placed again
      await setGrid(pool, eventId, await getFile(p.master_storage_key), s.tileTarget);
    }
    const fresh = (await ensureProject(pool, eventId));
    return describe(fresh, enabled);
  });

  /** Validates a master image and installs it. `place` stores the bytes and returns the key. Shared by the plain and the direct upload routes. */
  async function installMaster(req: any, reply: any, eventId: string, body: Buffer, place: (ext: string) => Promise<string>) {
    if (body.length === 0) return reply.code(415).send({ error: "image_required" });
    if (body.length > MAX_MASTER_BYTES) return reply.code(413).send({ error: "too_large", maxMb: 25 });
    const t = sniffImage(body);
    if (!t || t.ext === "svg") return reply.code(415).send({ error: "unsupported_image" });          // a master must be a photo-like raster
    try {
      const m = await sharp(body, { failOn: "error", limitInputPixels: 100_000_000 }).metadata();
      if (!m.width || !m.height || Math.min(m.width, m.height) < MIN_MASTER_SIDE) return reply.code(422).send({ error: "master_too_small", minSide: MIN_MASTER_SIDE });
      await sharp(body, { limitInputPixels: 100_000_000 }).resize(16, 16, { fit: "inside" }).raw().toBuffer();   // proves it fully decodes
    } catch { return reply.code(415).send({ error: "unsupported_image" }); }
    const p = await ensureProject(pool, eventId);
    const key = await place(t.ext);
    try { await setGrid(pool, eventId, body, resolveMosaicSettings(p.settings).tileTarget, key); }
    catch (e) { await deleteFile(key).catch(() => {}); throw e; }
    if (p.master_storage_key) await deleteFile(p.master_storage_key).catch(() => {});
    await audit(pool, req.user!.id, "mosaic_master", { eventId, entity: "mosaic", detail: { bytes: body.length, type: t.ext }, ip: req.ip });
    return reply.code(201).send(await describe(await ensureProject(pool, eventId), (await ensureProject(pool, eventId)).enabled));
  }

  app.post("/api/v1/events/:eventId/mosaic/master", { preHandler: edit, bodyLimit: MAX_MASTER_BYTES + 1024 }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "image_required" });
    return installMaster(req, reply, eventId, body, (ext) => putFile(`events/${eventId}/mosaic`, ext, body));
  });

  // Direct upload (object storage): the browser sends the master straight to the bucket, then asks the server to check and install it.
  app.post("/api/v1/events/:eventId/mosaic/master/upload-url", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const body = z.object({ bytes: z.number().int().min(1) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "validation" });
    if (body.data.bytes > MAX_MASTER_BYTES) return reply.code(413).send({ error: "too_large", maxMb: 25 });
    const key = `incoming/${eventId}/${randomBytes(16).toString("hex")}`;
    const put = await presignPut(key, { expiresIn: config.directUrlTtlSeconds, contentType: "application/octet-stream", contentLength: body.data.bytes });
    if (!put) return reply.code(501).send({ error: "direct_upload_unavailable" });
    const ticket = signUploadTicket({ e: eventId, s: req.user!.id, slot: 0, k: key, n: body.data.bytes });
    return { upload: { method: "PUT", url: put.url, headers: put.headers }, ticket, expiresInSeconds: config.directUrlTtlSeconds };
  });

  app.post("/api/v1/events/:eventId/mosaic/master/confirm", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const t = verifyUploadTicket((req.body as any)?.ticket);
    if (!t || t.e !== eventId || t.s !== req.user!.id || !t.k.startsWith(`incoming/${eventId}/`)) return reply.code(400).send({ error: "bad_ticket" });
    const size = await statFile(t.k);
    if (size === null) return reply.code(404).send({ error: "upload_not_found" });
    if (size !== t.n || size > MAX_MASTER_BYTES) { await deleteFile(t.k); return reply.code(413).send({ error: "too_large", maxMb: 25 }); }
    const buf = await getFile(t.k);
    try {
      return await installMaster(req, reply, eventId, buf, async (ext) => {
        const key = `events/${eventId}/mosaic/${randomBytes(16).toString("hex")}.${ext}`;
        await copyFile(t.k, key);
        return key;
      });
    } finally { await deleteFile(t.k); }
  });

  app.get("/api/v1/events/:eventId/mosaic/master", { preHandler: view }, async (req, reply) => {
    const p = await ensureProject(pool, (req.params as any).eventId);
    if (!p.master_storage_key) return reply.code(404).send({ error: "not_found" });
    const data = await getFile(p.master_storage_key);
    reply.header("Content-Type", sniffImage(data)?.mime ?? "application/octet-stream");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(data);
  });

  app.post("/api/v1/events/:eventId/mosaic/rebuild", { preHandler: edit }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    await ensureProject(pool, eventId);
    await clearTiles(pool, eventId);
    await audit(pool, req.user!.id, "mosaic_rebuild", { eventId, entity: "mosaic", ip: req.ip });
    const p = await ensureProject(pool, eventId);
    return describe(p, p.enabled);
  });

  app.post("/api/v1/events/:eventId/mosaic/regenerate-token", { preHandler: edit }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    await ensureProject(pool, eventId);
    const token = randomBytes(12).toString("hex");
    await pool.query("UPDATE mosaic_projects SET mosaic_token=$2 WHERE event_id=$1", [eventId, token]);
    await audit(pool, req.user!.id, "mosaic_token_regenerate", { eventId, entity: "mosaic", ip: req.ip });
    return { token, path: `/m/${token}` };
  });

  async function sendRender(eventId: string, width: number, reply: any, opts: { cache: string; filename?: string }) {
    const out = await renderCurrent(pool, eventId, width);
    if (!out) return reply.code(404).send({ error: "no_master" });
    reply.header("Cache-Control", opts.cache);
    reply.header("X-Mosaic-Version", out.version);
    if (opts.filename) reply.header("Content-Disposition", `attachment; filename="${opts.filename}"`);
    return reply.type("image/jpeg").send(out.buffer);
  }

  app.get("/api/v1/events/:eventId/mosaic/image", { preHandler: view }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const w = z.coerce.number().int().refine((n) => (MOSAIC_PREVIEW_WIDTHS as readonly number[]).includes(n)).default(1600).safeParse((req.query as any).w);
    if (!w.success) return reply.code(404).send({ error: "not_found" });
    const p = await ensureProject(pool, eventId);
    if (p.enabled) await syncMosaic(pool, eventId);
    return sendRender(eventId, w.data, reply, { cache: "private, max-age=30" });
  });

  /** The finished file at the configured output width (up to the pixel budget). */
  app.get("/api/v1/events/:eventId/mosaic/download", { preHandler: view }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const p = await ensureProject(pool, eventId);
    if (!p.master_storage_key) return reply.code(404).send({ error: "no_master" });
    if (p.enabled) await syncMosaic(pool, eventId);
    await audit(pool, req.user!.id, "mosaic_download", { eventId, entity: "mosaic", ip: req.ip });
    return sendRender(eventId, resolveMosaicSettings(p.settings).outputWidth, reply, { cache: "no-store", filename: `mosaic-${eventId.slice(0, 8)}.jpg` });
  });

  // ----- Public display (unguessable link, like the photo wall) -----
  async function mosaicFor(token: string): Promise<Project & { name: string; hashtag: string | null; guest_token: string } | null> {
    if (!TOKEN.test(token)) return null;
    const r = (await pool.query(
      `SELECT p.*, s.mosaic_enabled AS enabled, s.branding, e.name, e.hashtag, e.guest_token
         FROM mosaic_projects p JOIN events e ON e.id=p.event_id JOIN event_settings s ON s.event_id=e.id
        WHERE p.mosaic_token=$1 AND e.status='active' AND s.mosaic_enabled AND p.master_storage_key IS NOT NULL`, [token])).rows[0];
    return r ?? null;
  }

  app.get("/api/v1/public/m/:token", async (req, reply) => {
    const m = await mosaicFor((req.params as any).token);
    if (!m) return reply.code(404).send({ error: "not_available" });
    const s = resolveMosaicSettings(m.settings);
    const r = await syncMosaic(pool, m.event_id);
    const { version } = await currentVersion(pool, m);
    return {
      version, event: { name: m.name, hashtag: m.hashtag }, title: s.title, showProgress: s.showProgress,
      aspect: m.master_width! / m.master_height!, progress: { filled: r.filled, cells: r.cells, percent: mosaicPercent(r.filled, r.cells) },
      joinPath: `/g/${m.guest_token}`, imageWidths: MOSAIC_PREVIEW_WIDTHS,
    };
  });

  app.get("/api/v1/public/m/:token/image", async (req, reply) => {
    const m = await mosaicFor((req.params as any).token);
    if (!m) return reply.code(404).send({ error: "not_available" });
    const w = z.coerce.number().int().refine((n) => (MOSAIC_PREVIEW_WIDTHS as readonly number[]).includes(n)).default(1600).safeParse((req.query as any).w);
    if (!w.success) return reply.code(404).send({ error: "not_found" });
    await syncMosaic(pool, m.event_id);
    return sendRender(m.event_id, w.data, reply, { cache: "private, max-age=300" });
  });

  void config;
}
