import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomInt } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { MAX_UPLOADS_PER_SESSION, SHARE_CHANNELS, photoAdjustSchema, resolveShare, validateGuestInput, type FrameLayer, type PageDefinition } from "@rsp/shared";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { deleteFile, getFile, putFile } from "../storage";
import { config } from "../config";
import { composeFrame, type SlotImage } from "../compose";
import { signCompositionPath, verifyComposition } from "../signing";
import { finalizeComposition } from "../printService";

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
    const input = z.object({ consent: z.boolean().default(false), fields: z.record(z.string().max(40), z.string().max(300)).default({}), wallOptOut: z.boolean().default(false) }).parse(req.body ?? {});
    const v = validateGuestInput(pe.def, input, pe.requireConsent);
    if (!v.ok) return reply.code(400).send({ error: "validation", errors: v.errors });
    for (let i = 0; i < 8; i++) {
      try {
        const r = await pool.query(
          "INSERT INTO guest_sessions(event_id,guest_code,consent_at,fields,wall_opt_out) VALUES ($1,$2,$3,$4,$5) RETURNING id,guest_code",
          [pe.id, newCode(), input.consent ? new Date() : null, JSON.stringify(v.clean), input.wallOptOut]);
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
    const slotQ = z.coerce.number().int().min(1).max(8).safeParse((req.query as any).slot ?? 1);
    if (!slotQ.success) return reply.code(400).send({ error: "bad_slot" });
    const slot = slotQ.data;
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

    const dup = (await pool.query("SELECT id,width,height,low_res FROM photo_uploads WHERE session_id=$1 AND slot=$3 AND sha256=$2 AND deleted_at IS NULL", [sessionId, sha, slot])).rows[0];
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
              AND u.slot=$2 AND NOT EXISTS (SELECT 1 FROM final_compositions f WHERE f.upload_id=u.id)
              AND NOT EXISTS (SELECT 1 FROM composition_photos cp WHERE cp.upload_id=u.id)`, [sessionId, slot])).rows;
        for (const p of prev) { await tx.query("UPDATE photo_uploads SET deleted_at=now() WHERE id=$1", [p.id]); old.push(p.storage_key); }
        const r = await tx.query(
          `INSERT INTO photo_uploads(event_id,session_id,storage_key,mime,bytes,width,height,sha256,low_res,slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [pe.id, sessionId, key, mime, buf.length, width, height, sha, lowRes, slot]);
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

  // ----- Final composition: ONE rendered file, used for download, share, wall and print -----
  const eventBranding = async (eventId: string) => (await pool.query("SELECT branding FROM event_settings WHERE event_id=$1", [eventId])).rows[0]?.branding ?? {};

  app.post("/api/v1/public/g/:token/compose", { config: { rateLimit: { max: () => config.composeRateLimitPerMin, timeWindow: "1 minute" } } }, async (req, reply) => {
    const g = await authGuest(req, reply); if (!g) return;
    const { pe, sessionId } = g;
    const body = z.object({
      frameId: z.string().uuid(),
      slots: z.array(z.object({ slot: z.number().int().min(1).max(8), uploadId: z.string().uuid(), adjust: photoAdjustSchema })).min(1).max(8),
    }).parse(req.body);

    const frame = (await pool.query("SELECT id,width_px,height_px,updated_at,sponsor_id FROM frames WHERE id=$1 AND event_id=$2 AND active", [body.frameId, pe.id])).rows[0];
    if (!frame) return reply.code(404).send({ error: "frame_not_found" });
    const layers = (await pool.query("SELECT props FROM frame_layers WHERE frame_id=$1 AND event_id=$2 ORDER BY z_index", [frame.id, pe.id])).rows.map((r) => r.props as FrameLayer);
    const need = layers.filter((l) => l.type === "photo").map((l: any) => l.slot as number).sort((a, b) => a - b);
    const got = body.slots.map((s) => s.slot).sort((a, b) => a - b);
    if (need.length !== got.length || need.some((n, i) => n !== got[i])) return reply.code(400).send({ error: "slots_mismatch", need });

    const ids = [...new Set(body.slots.map((s) => s.uploadId))];
    const ups = (await pool.query("SELECT id,storage_key,width,height FROM photo_uploads WHERE id = ANY($1) AND session_id=$2 AND event_id=$3 AND deleted_at IS NULL", [ids, sessionId, pe.id])).rows;
    const byId = new Map(ups.map((u) => [u.id as string, u]));
    if (ids.some((i) => !byId.has(i))) return reply.code(404).send({ error: "photo_not_found" });

    const sorted = [...body.slots].sort((a, b) => a.slot - b.slot);
    // The sponsor logo is part of the picture, so a changed or switched-off sponsor must not hand back an older composition.
    const sponsor = frame.sponsor_id ? (await pool.query("SELECT logo_asset FROM sponsors WHERE id=$1 AND event_id=$2 AND active", [frame.sponsor_id, pe.id])).rows[0] ?? null : null;
    const inputHash = createHash("sha256").update(JSON.stringify({ f: frame.id, u: new Date(frame.updated_at).toISOString(), s: sorted, sp: sponsor?.logo_asset ?? null })).digest("hex");
    const existing = (await pool.query("SELECT id,width_px,height_px,bytes FROM final_compositions WHERE session_id=$1 AND input_hash=$2 AND deleted_at IS NULL", [sessionId, inputHash])).rows[0];
    const reply201 = (r: any) => ({ compositionId: r.id, url: signCompositionPath(r.id), width: r.width_px, height: r.height_px, bytes: Number(r.bytes) });
    if (existing) return reply.code(200).send({ ...reply201(existing), duplicate: true });
    const made = (await pool.query("SELECT count(*)::int c FROM final_compositions WHERE session_id=$1", [sessionId])).rows[0].c;
    if (made >= 10) return reply.code(429).send({ error: "too_many_compositions" });

    const info = (await pool.query("SELECT name,hashtag,event_date,client_name FROM events WHERE id=$1", [pe.id])).rows[0];
    const branding = await eventBranding(pe.id);
    const safeRead = async (key: string) => { try { return await getFile(key); } catch { return null; } };
    const photos = new Map<number, SlotImage>();
    for (const s of sorted) { const u = byId.get(s.uploadId)!; photos.set(s.slot, { data: await getFile(u.storage_key), width: u.width, height: u.height, adjust: s.adjust }); }
    let out: { buffer: Buffer; width: number; height: number };
    try {
      out = await composeFrame({
        widthPx: frame.width_px, heightPx: frame.height_px, layers, photos,
        event: { name: info.name, hashtag: info.hashtag, eventDate: info.event_date ? new Date(info.event_date).toISOString().slice(0, 10) : null, clientName: info.client_name },
        asset: (name) => safeRead(`events/${pe.id}/frames/${name}`),
        logo: (kind) => kind === "sponsor" ? (sponsor?.logo_asset ? safeRead(sponsor.logo_asset) : Promise.resolve(null)) : (branding[kind === "client" ? "clientLogo" : "eventLogo"] ? safeRead(branding[kind === "client" ? "clientLogo" : "eventLogo"]) : Promise.resolve(null)),
      });
    } catch (e) { req.log?.error?.(e); return reply.code(500).send({ error: "compose_failed" }); }

    const key = await putFile(`events/${pe.id}/finals`, "jpg", out.buffer);
    const oldKeys: string[] = [];
    let row: any; let raced = false;
    try {
      row = await withTx(pool, async (tx) => {
        await tx.query("SELECT 1 FROM guest_sessions WHERE id=$1 FOR UPDATE", [sessionId]);       // serialise concurrent composes of one guest
        const again = (await tx.query("SELECT id,width_px,height_px,bytes FROM final_compositions WHERE session_id=$1 AND input_hash=$2 AND deleted_at IS NULL", [sessionId, inputHash])).rows[0];
        if (again) { raced = true; return again; }
        // A guest who tries another frame replaces their earlier (unprinted) composition: nothing is left behind.
        const old = (await tx.query(
          `DELETE FROM final_compositions c WHERE c.session_id=$1 AND NOT EXISTS (SELECT 1 FROM print_jobs p WHERE p.composition_id=c.id) RETURNING c.storage_key`, [sessionId])).rows;
        for (const o of old) oldKeys.push(o.storage_key);
        const r = (await tx.query(
          `INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256,session_id,input_hash,bytes,mime)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'image/jpeg') RETURNING id,width_px,height_px,bytes`,
          [pe.id, sorted[0].uploadId, frame.id, key, out.width, out.height, createHash("sha256").update(out.buffer).digest("hex"), sessionId, inputHash, out.buffer.length])).rows[0];
        for (const s of sorted) await tx.query("INSERT INTO composition_photos(composition_id,event_id,slot,upload_id,adjust) VALUES ($1,$2,$3,$4,$5)", [r.id, pe.id, s.slot, s.uploadId, JSON.stringify(s.adjust)]);
        await tx.query("INSERT INTO frame_selections(event_id,session_id,frame_id) VALUES ($1,$2,$3)", [pe.id, sessionId, frame.id]);      // frame popularity report
        return r;
      });
    } catch (e) { await deleteFile(key); throw e; }
    if (raced) await deleteFile(key);
    for (const k of oldKeys) await deleteFile(k);
    return reply.code(raced ? 200 : 201).send(reply201(row));
  });

  // A fresh link for the guest's own composition (links expire; the file does not).
  app.get("/api/v1/public/g/:token/composition/:cid/url", async (req, reply) => {
    const g = await authGuest(req, reply); if (!g) return;
    const cid = (req.params as any).cid as string;
    if (!UUID.test(cid)) return reply.code(404).send({ error: "not_found" });
    const r = (await pool.query("SELECT id FROM final_compositions WHERE id=$1 AND session_id=$2 AND event_id=$3 AND deleted_at IS NULL", [cid, g.sessionId, g.pe.id])).rows[0];
    return r ? { url: signCompositionPath(r.id) } : reply.code(404).send({ error: "not_found" });
  });

  // The guest tapped Finish: from here the picture is eligible for printing (what happens next depends on the event's print mode).
  app.post("/api/v1/public/g/:token/composition/:cid/finalize", { config: { rateLimit: { max: () => config.guestRateLimitPerMin, timeWindow: "1 minute" } } }, async (req, reply) => {
    const g = await authGuest(req, reply); if (!g) return;
    const cid = (req.params as any).cid as string;
    if (!UUID.test(cid)) return reply.code(404).send({ error: "not_found" });
    const r = await finalizeComposition(pool, g.pe.id, g.sessionId, cid);
    return reply.code(r.created ? 201 : 200).send({ finalized: true, queued: !!r.job, status: r.job?.status ?? null });
  });

  // A share tap is recorded as an ATTEMPT only. Neither the browser nor Instagram tells us whether a post happened, so we never claim it.
  app.post("/api/v1/public/g/:token/composition/:cid/share", { config: { rateLimit: { max: () => config.guestRateLimitPerMin, timeWindow: "1 minute" } } }, async (req, reply) => {
    const g = await authGuest(req, reply); if (!g) return;
    const cid = (req.params as any).cid as string;
    if (!UUID.test(cid)) return reply.code(404).send({ error: "not_found" });
    const { channel } = z.object({ channel: z.enum(SHARE_CHANNELS) }).parse(req.body);
    const own = (await pool.query("SELECT 1 FROM final_compositions WHERE id=$1 AND session_id=$2 AND event_id=$3 AND deleted_at IS NULL", [cid, g.sessionId, g.pe.id])).rowCount;
    if (!own) return reply.code(404).send({ error: "not_found" });
    const settings = resolveShare((await pool.query("SELECT share FROM event_settings WHERE event_id=$1", [g.pe.id])).rows[0]?.share);
    const key = ({ instagram: "instagram", whatsapp: "whatsapp", native: "native", download: "download", copy_caption: "copyCaption", copy_hashtag: "copyHashtag" } as const)[channel];
    if (!settings.channels[key]) return reply.code(400).send({ error: "channel_disabled" });
    const n = (await pool.query("SELECT count(*)::int c FROM share_events WHERE composition_id=$1", [cid])).rows[0].c;
    if (n >= 100) return reply.code(429).send({ error: "too_many_attempts" });
    await pool.query("INSERT INTO share_events(event_id,composition_id,channel,session_id) VALUES ($1,$2,$3,$4)", [g.pe.id, cid, channel, g.sessionId]);
    return reply.code(201).send({ ok: true, outcome: "attempted" });
  });

  // Signed, expiring link: lets the browser download/share the image without custom headers. Guessing or editing the link fails.
  app.get("/api/v1/public/c/:cid", async (req, reply) => {
    const cid = (req.params as any).cid as string; const q = req.query as any;
    if (!UUID.test(cid) || !verifyComposition(cid, q.exp, q.sig)) return reply.code(404).send({ error: "not_found" });
    const c = (await pool.query("SELECT storage_key,mime FROM final_compositions WHERE id=$1 AND deleted_at IS NULL", [cid])).rows[0];
    if (!c) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", c.mime);
    reply.header("Content-Disposition", q.dl === "1" ? 'attachment; filename="photo.jpg"' : "inline");
    reply.header("X-Robots-Tag", "noindex");
    return reply.send(await getFile(c.storage_key));
  });

  // Staff list/detail/moderation live in routes/photos.ts. The raw image routes stay here beside the originals.
  app.get("/api/v1/events/:eventId/compositions/:cid/image", { preHandler: requirePermission(pool, "print:operate", { eventParam: "eventId" }) }, async (req, reply) => {
    const { eventId, cid } = req.params as { eventId: string; cid: string };
    if (!UUID.test(cid)) return reply.code(404).send({ error: "not_found" });
    const c = (await pool.query("SELECT storage_key,mime FROM final_compositions WHERE id=$1 AND event_id=$2 AND deleted_at IS NULL", [cid, eventId])).rows[0];
    if (!c) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", c.mime);
    return reply.send(await getFile(c.storage_key));
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
