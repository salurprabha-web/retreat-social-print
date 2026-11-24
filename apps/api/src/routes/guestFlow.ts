import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomInt } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { MAX_UPLOADS_PER_SESSION, photoAdjustSchema, validateGuestInput, type PageDefinition } from "@rsp/shared";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { deleteFile, getFile, putFile } from "../storage";
import { config } from "../config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I: read aloud at an event desk
const newCode = () => "G" + Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
const MAX_PIXELS = 100_000_000;
const MAX_BODY = 100 * 1024 * 1024;

interface PubEvent { id: string; def: PageDefinition; maxUploadMb: number; requireConsent: boolean }

export async function guestFlowRoutes(app: FastifyInstance, pool: Pool) {
  // Photos are posted as raw bytes. The real type is decided from the bytes, never from this header.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_BODY }, (_r, body, done) => done(null, body));

  async function pubEvent(token: string): Promise<PubEvent | null> {
    if (!/^[0-9a-f]{24}$/.test(token)) return null;
    const r = (await pool.query(
      `SELECT e.id, p.definition, s.max_upload_mb, s.require_consent
         FROM events e
         JOIN guest_experience_pages p ON p.event_id=e.id AND p.state='published'
         JOIN event_settings s ON s.event_id=e.id
        WHERE e.guest_token=$1 AND e.status='active'`, [token])).rows[0];
    return r ? { id: r.id, def: r.definition, maxUploadMb: r.max_upload_mb, requireConsent: r.require_consent } : null;
  }

  /** Resolves the event from the link and the guest session from the header; the session must belong to THIS event. */
  async function authGuest(req: FastifyRequest, reply: FastifyReply) {
    const pe = await pubEvent((req.params as any).token);
    if (!pe) { reply.code(404).send({ error: "not_available" }); return null; }
    const sid = String(req.headers["x-guest-session"] ?? "");
    if (!UUID.test(sid)) { reply.code(401).send({ error: "session_required" }); return null; }
    const s = (await pool.query("SELECT id FROM guest_sessions WHERE id=$1 AND event_id=$2", [sid, pe.id])).rows[0];
    if (!s) { reply.code(401).send({ error: "session_invalid" }); return null; }
    return { pe, sessionId: sid };
  }

  app.post("/api/v1/public/g/:token/session", { config: { rateLimit: { max: () => config.guestRateLimitPerMin, timeWindow: "1 minute" } } }, async (req, reply) => {
    const pe = await pubEvent((req.params as any).token);
    if (!pe) return reply.code(404).send({ error: "not_available" });
    const input = z.object({ consent: z.boolean().default(false), fields: z.record(z.string().max(40), z.string().max(300)).default({}) }).parse(req.body ?? {});
    const v = validateGuestInput(pe.def, input, pe.requireConsent);
    if (!v.ok) return reply.code(400).send({ error: "validation", errors: v.errors });
    for (let i = 0; i < 8; i++) {
      try {
        const r = await pool.query(
          "INSERT INTO guest_sessions(event_id,guest_code,consent_at,fields) VALUES ($1,$2,$3,$4) RETURNING id,guest_code",
          [pe.id, newCode(), input.consent ? new Date() : null, JSON.stringify(v.clean)]);
        return reply.code(201).send({ sessionId: r.rows[0].id, guestCode: r.rows[0].guest_code });
      } catch (e: any) { if (e.code !== "23505") throw e; }   // code clash within the event: draw another
    }
    return reply.code(503).send({ error: "try_again" });
  });

  // Reject oversized uploads from the Content-Length header, before the body is read into memory.
  const earlyLimit = async (req: FastifyRequest, reply: FastifyReply) => {
    const pe = await pubEvent((req.params as any).token);
    if (!pe) return reply.code(404).send({ error: "not_available" });
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > pe.maxUploadMb * 1024 * 1024) return reply.code(413).send({ error: "too_large", maxMb: pe.maxUploadMb });
  };

  app.post("/api/v1/public/g/:token/photo", {
    bodyLimit: MAX_BODY, onRequest: earlyLimit,
    config: { rateLimit: { max: () => config.guestRateLimitPerMin, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const g = await authGuest(req, reply); if (!g) return;
    const { pe, sessionId } = g;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return reply.code(415).send({ error: "image_required" });
    if (buf.length > pe.maxUploadMb * 1024 * 1024) return reply.code(413).send({ error: "too_large", maxMb: pe.maxUploadMb });

    // HEIC/HEIF: iPhones convert to JPEG automatically when picking from the gallery; a raw HEIC cannot be decoded here.
    if (buf.length > 12 && buf.subarray(4, 8).toString() === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1|heif)/.test(buf.subarray(8, 12).toString()))
      return reply.code(415).send({ error: "heic_unsupported" });

    let meta: sharp.Metadata;
    try {
      meta = await sharp(buf, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
      if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format) || !meta.width || !meta.height) return reply.code(415).send({ error: "unsupported_image" });
      await sharp(buf, { failOn: "error", limitInputPixels: MAX_PIXELS }).resize(32, 32, { fit: "inside" }).raw().toBuffer();   // proves it fully decodes
    } catch { return reply.code(415).send({ error: "unsupported_image" }); }
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height! : meta.width!, height = swap ? meta.width! : meta.height!;
    const ext = meta.format === "jpeg" ? "jpg" : meta.format;
    const mime = meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format}`;
    const sha = createHash("sha256").update(buf).digest("hex");

    const dup = (await pool.query("SELECT id,width,height,low_res FROM photo_uploads WHERE session_id=$1 AND sha256=$2 AND deleted_at IS NULL", [sessionId, sha])).rows[0];
    if (dup) return { uploadId: dup.id, width: dup.width, height: dup.height, lowResolution: dup.low_res, duplicate: true };

    const used = (await pool.query("SELECT count(*)::int c FROM photo_uploads WHERE session_id=$1", [sessionId])).rows[0].c;
    if (used >= MAX_UPLOADS_PER_SESSION) return reply.code(429).send({ error: "too_many_uploads" });

    const lowRes = Math.max(width, height) < 1200;
    const key = await putFile(`events/${pe.id}/originals`, ext, buf);
    let id: string;
    const old: string[] = [];
    try {
      id = await withTx(pool, async (tx) => {
        // "Replace photo": earlier photos of this session that were never composed are removed (privacy: keep only what is used).
        const prev = (await tx.query(
          `SELECT u.id,u.storage_key FROM photo_uploads u WHERE u.session_id=$1 AND u.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM final_compositions f WHERE f.upload_id=u.id)`, [sessionId])).rows;
        for (const p of prev) { await tx.query("UPDATE photo_uploads SET deleted_at=now() WHERE id=$1", [p.id]); old.push(p.storage_key); }
        const r = await tx.query(
          `INSERT INTO photo_uploads(event_id,session_id,storage_key,mime,bytes,width,height,sha256,low_res) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [pe.id, sessionId, key, mime, buf.length, width, height, sha, lowRes]);
        return r.rows[0].id as string;
      });
    } catch (e) { await deleteFile(key); throw e; }
    for (const k of old) await deleteFile(k);
    return reply.code(201).send({ uploadId: id, width, height, lowResolution: lowRes, bytes: buf.length });
  });

  app.put("/api/v1/public/g/:token/photo/:uploadId/adjust", async (req, reply) => {
    const g = await authGuest(req, reply); if (!g) return;
    const uploadId = (req.params as any).uploadId as string;
    if (!UUID.test(uploadId)) return reply.code(404).send({ error: "not_found" });
    const adj = photoAdjustSchema.parse(req.body);
    const r = await pool.query("UPDATE photo_uploads SET adjust=$3 WHERE id=$1 AND session_id=$2 AND event_id=$4 AND deleted_at IS NULL",
      [uploadId, g.sessionId, JSON.stringify(adj), g.pe.id]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  // Operators/managers of THIS event can open an original. There is no public route to photos.
  app.get("/api/v1/events/:eventId/uploads/:uploadId/original",
    { preHandler: requirePermission(pool, "print:operate", { eventParam: "eventId" }) }, async (req, reply) => {
      const { eventId, uploadId } = req.params as { eventId: string; uploadId: string };
      if (!UUID.test(uploadId)) return reply.code(404).send({ error: "not_found" });
      const u = (await pool.query("SELECT storage_key,mime FROM photo_uploads WHERE id=$1 AND event_id=$2 AND deleted_at IS NULL", [uploadId, eventId])).rows[0];
      if (!u) return reply.code(404).send({ error: "not_found" });
      await audit(pool, req.user!.id, "photo_original_view", { eventId, entity: "photo", entityId: uploadId, ip: req.ip });
      reply.header("Content-Type", u.mime);
      reply.header("Content-Disposition", "inline");
      return reply.send(await getFile(u.storage_key));
    });
}
