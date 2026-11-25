import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { shareSettingsSchema } from "@rsp/shared";
import { newQrCode } from "../qrcodes";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission, requireUser } from "../auth";
import { deletePrefix, deleteFile, getFile, putFile, sniffImage, svgIsSafe } from "../storage";

const STATUSES = ["draft", "active", "inactive", "archived"] as const;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  clientName: z.string().trim().max(120).optional(),
  hashtag: z.string().trim().max(60).regex(/^[A-Za-z0-9_]*$/, "letters, numbers and underscore only").optional(),
  eventDate: dateStr.optional(),
});
const settingsSchema = z.object({
  printMode: z.enum(["auto", "manual", "batch"]),
  defaultCopies: z.number().int().min(1).max(10),
  maxUploadMb: z.number().int().min(1).max(100),
  retentionDays: z.number().int().min(1).max(3650),
  requireConsent: z.boolean(),
  photoWallEnabled: z.boolean(),
  mosaicEnabled: z.boolean(),
  instagramHandle: z.string().trim().max(60).nullable(),
  suggestedCaption: z.string().trim().max(500).nullable(),
  primaryColor: hex,
  share: shareSettingsSchema.partial(),
}).partial();
const patchSchema = createSchema.partial().extend({ settings: settingsSchema.optional() });

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
const newSlug = (name: string) => `${slugify(name)}-${randomBytes(3).toString("hex")}`;

const EVENT_COLS = `e.id,e.name,e.slug,e.guest_token,e.client_name,e.hashtag,e.event_date,e.status,e.created_at,e.updated_at,e.archived_at`;

function shape(r: any) {
  return {
    id: r.id, name: r.name, slug: r.slug, guestToken: r.guest_token, clientName: r.client_name, hashtag: r.hashtag,
    eventDate: r.event_date ? new Date(r.event_date).toISOString().slice(0, 10) : null, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at,
    ...(r.print_mode ? {
      settings: {
        printMode: r.print_mode, defaultCopies: r.default_copies, maxUploadMb: r.max_upload_mb, retentionDays: r.retention_days,
        requireConsent: r.require_consent, photoWallEnabled: r.photo_wall_enabled, mosaicEnabled: r.mosaic_enabled,
        instagramHandle: r.instagram_handle, suggestedCaption: r.suggested_caption, branding: r.branding, share: r.share ?? {},
      },
    } : {}),
    ...(r.submissions !== undefined ? { submissions: r.submissions } : {}),
  };
}

async function createEvent(tx: any, userId: string, v: { name: string; clientName?: string | null; hashtag?: string | null; eventDate?: string | null }) {
  const e = (await tx.query(
    `INSERT INTO events(name,slug,client_name,hashtag,event_date,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [v.name, newSlug(v.name), v.clientName ?? null, v.hashtag ?? null, v.eventDate ?? null, userId])).rows[0].id as string;
  await tx.query("INSERT INTO photo_wall_settings(event_id) VALUES ($1)", [e]);
  await tx.query("INSERT INTO qr_tracking(event_id,code,label) VALUES ($1,$2,$3)", [e, newQrCode(), "Main QR"]);
  return e;
}

export async function eventRoutes(app: FastifyInstance, pool: Pool) {
  // Images arrive as the raw request body; the type is verified from the bytes, not from this header.
  for (const t of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) {
    app.addContentTypeParser(t, { parseAs: "buffer", bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  }

  async function load(id: string) {
    const r = await pool.query(
      `SELECT ${EVENT_COLS}, s.* FROM events e JOIN event_settings s ON s.event_id=e.id WHERE e.id=$1`, [id]);
    return r.rows[0] ? shape(r.rows[0]) : null;
  }

  app.get("/api/v1/events", { preHandler: requireUser(pool) }, async (req) => {
    const u = req.user!;
    const q = z.object({ status: z.enum(STATUSES).optional(), q: z.string().max(100).optional() }).parse(req.query);
    const scope = u.globalRole === "super_admin" ? null : Object.keys(u.eventRoles);
    const r = await pool.query(
      `SELECT ${EVENT_COLS},
          (SELECT count(*)::int FROM final_compositions f WHERE f.event_id=e.id AND f.deleted_at IS NULL) submissions
         FROM events e
        WHERE ($1::uuid[] IS NULL OR e.id = ANY($1))
          AND ($2::text IS NULL OR e.status=$2)
          AND ($3::text IS NULL OR e.name ILIKE '%'||$3||'%' OR e.client_name ILIKE '%'||$3||'%')
        ORDER BY e.created_at DESC LIMIT 500`,
      [scope, q.status ?? null, q.q ?? null]);
    return { events: r.rows.map(shape) };
  });

  app.post("/api/v1/events", { preHandler: requirePermission(pool, "event:create") }, async (req, reply) => {
    const v = createSchema.parse(req.body);
    const id = await withTx(pool, async (tx) => {
      const e = await createEvent(tx, req.user!.id, v);
      await tx.query("INSERT INTO event_settings(event_id) VALUES ($1)", [e]);
      await audit(tx, req.user!.id, "event_create", { eventId: e, entity: "event", entityId: e, detail: { name: v.name }, ip: req.ip });
      return e;
    });
    return reply.code(201).send({ event: await load(id) });
  });

  app.get("/api/v1/events/:eventId", { preHandler: requirePermission(pool, "event:view", { eventParam: "eventId" }) }, async (req, reply) => {
    const e = await load((req.params as any).eventId);
    return e ? { event: e } : reply.code(404).send({ error: "not_found" });
  });

  app.patch("/api/v1/events/:eventId", { preHandler: requirePermission(pool, "event:edit", { eventParam: "eventId" }) }, async (req, reply) => {
    const id = (req.params as any).eventId as string;
    const v = patchSchema.parse(req.body);
    const ok = await withTx(pool, async (tx) => {
      const cur = await tx.query("SELECT status FROM events WHERE id=$1 FOR UPDATE", [id]);
      if (!cur.rows[0]) return false;
      const set: string[] = []; const vals: unknown[] = [id];
      const add = (col: string, val: unknown) => { vals.push(val); set.push(`${col}=$${vals.length}`); };
      if (v.name !== undefined) add("name", v.name);
      if (v.clientName !== undefined) add("client_name", v.clientName || null);
      if (v.hashtag !== undefined) add("hashtag", v.hashtag || null);
      if (v.eventDate !== undefined) add("event_date", v.eventDate);
      if (set.length) await tx.query(`UPDATE events SET ${set.join(",")}, updated_at=now() WHERE id=$1`, vals);
      const s = v.settings;
      if (s) {
        const cols: Record<string, string> = {
          printMode: "print_mode", defaultCopies: "default_copies", maxUploadMb: "max_upload_mb", retentionDays: "retention_days",
          requireConsent: "require_consent", photoWallEnabled: "photo_wall_enabled", mosaicEnabled: "mosaic_enabled",
          instagramHandle: "instagram_handle", suggestedCaption: "suggested_caption",
        };
        const sset: string[] = []; const svals: unknown[] = [id];
        for (const [k, col] of Object.entries(cols)) if ((s as any)[k] !== undefined) { svals.push((s as any)[k]); sset.push(`${col}=$${svals.length}`); }
        if (s.share) { svals.push(JSON.stringify(s.share)); sset.push(`share=$${svals.length}::jsonb`); }
        if (s.primaryColor) { svals.push(JSON.stringify({ primaryColor: s.primaryColor })); sset.push(`branding=branding || $${svals.length}::jsonb`); }
        if (sset.length) await tx.query(`UPDATE event_settings SET ${sset.join(",")}, updated_at=now() WHERE event_id=$1`, svals);
      }
      await audit(tx, req.user!.id, "event_update", { eventId: id, entity: "event", entityId: id, detail: v as object, ip: req.ip });
      return true;
    });
    return ok ? { event: await load(id) } : reply.code(404).send({ error: "not_found" });
  });

  const ALLOWED: Record<string, string[]> = {
    draft: ["active", "inactive", "archived"], active: ["inactive", "archived"],
    inactive: ["active", "archived"], archived: ["inactive"],
  };
  app.post("/api/v1/events/:eventId/status", { preHandler: requirePermission(pool, "event:edit", { eventParam: "eventId" }) }, async (req, reply) => {
    const id = (req.params as any).eventId as string;
    const { status } = z.object({ status: z.enum(STATUSES) }).parse(req.body);
    const r = await withTx(pool, async (tx) => {
      const cur = (await tx.query("SELECT status FROM events WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!cur) return "missing" as const;
      if (!ALLOWED[cur.status].includes(status)) return "bad" as const;
      await tx.query("UPDATE events SET status=$2, updated_at=now(), archived_at = CASE WHEN $2='archived' THEN now() ELSE NULL END WHERE id=$1", [id, status]);
      await audit(tx, req.user!.id, "event_status", { eventId: id, entity: "event", entityId: id, detail: { from: cur.status, to: status }, ip: req.ip });
      return "ok" as const;
    });
    if (r === "missing") return reply.code(404).send({ error: "not_found" });
    if (r === "bad") return reply.code(409).send({ error: "invalid_transition" });
    return { event: await load(id) };
  });

  // Duplicate copies configuration only. Guest data, photos, QR scans and print history are never copied.
  app.post("/api/v1/events/:eventId/duplicate", { preHandler: requirePermission(pool, "event:create") }, async (req, reply) => {
    const src = (req.params as any).eventId as string;
    const id = await withTx(pool, async (tx) => {
      const o = (await tx.query("SELECT e.name,e.client_name,e.hashtag,e.event_date FROM events e WHERE e.id=$1", [src])).rows[0];
      if (!o) return null;
      const n = await createEvent(tx, req.user!.id, { name: `${o.name} (copy)`, clientName: o.client_name, hashtag: o.hashtag,
        eventDate: o.event_date ? new Date(o.event_date).toISOString().slice(0, 10) : null });
      await tx.query(
        `INSERT INTO event_settings(event_id,print_mode,default_copies,max_upload_mb,retention_days,require_consent,photo_wall_enabled,mosaic_enabled,branding,instagram_handle,suggested_caption)
         SELECT $2,print_mode,default_copies,max_upload_mb,retention_days,require_consent,photo_wall_enabled,mosaic_enabled,
                branding - 'clientLogo' - 'eventLogo',instagram_handle,suggested_caption FROM event_settings WHERE event_id=$1`, [src, n]);
      await audit(tx, req.user!.id, "event_duplicate", { eventId: n, entity: "event", entityId: n, detail: { from: src }, ip: req.ip });
      return n;
    });
    return id ? reply.code(201).send({ event: await load(id) }) : reply.code(404).send({ error: "not_found" });
  });

  app.delete("/api/v1/events/:eventId", { preHandler: requirePermission(pool, "event:delete") }, async (req, reply) => {
    const id = (req.params as any).eventId as string;
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
    const e = (await pool.query("SELECT name FROM events WHERE id=$1", [id])).rows[0];
    if (!e) return reply.code(404).send({ error: "not_found" });
    if (e.name !== confirmName) return reply.code(400).send({ error: "confirmation_mismatch" });
    await withTx(pool, async (tx) => {
      await audit(tx, req.user!.id, "event_delete", { entity: "event", entityId: id, detail: { name: e.name }, ip: req.ip });
      await tx.query("DELETE FROM events WHERE id=$1", [id]);
    });
    await deletePrefix(`events/${id}`);
    return { ok: true };
  });

  // Logo upload: raw image body. kind = client | event.
  app.post("/api/v1/events/:eventId/logo/:kind", { preHandler: requirePermission(pool, "event:edit", { eventParam: "eventId" }) }, async (req, reply) => {
    const { eventId, kind } = req.params as { eventId: string; kind: string };
    if (kind !== "client" && kind !== "event") return reply.code(400).send({ error: "bad_kind" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(415).send({ error: "image_required" });
    const t = sniffImage(body);
    if (!t) return reply.code(415).send({ error: "unsupported_image" });
    if (t.ext === "svg" && !svgIsSafe(body.toString("utf8"))) return reply.code(422).send({ error: "unsafe_svg" });
    const exists = await pool.query("SELECT 1 FROM events WHERE id=$1", [eventId]);
    if (!exists.rowCount) return reply.code(404).send({ error: "not_found" });
    const key = await putFile(`events/${eventId}/branding`, t.ext, body);
    const field = kind === "client" ? "clientLogo" : "eventLogo";
    const prev = (await pool.query("SELECT branding->>$2 AS k FROM event_settings WHERE event_id=$1", [eventId, field])).rows[0]?.k;
    await pool.query("UPDATE event_settings SET branding = branding || jsonb_build_object($2::text,$3::text), updated_at=now() WHERE event_id=$1", [eventId, field, key]);
    if (prev) await deleteFile(prev);
    await audit(pool, req.user!.id, "event_logo", { eventId, entity: "event", entityId: eventId, detail: { kind, bytes: body.length, type: t.ext }, ip: req.ip });
    return reply.code(201).send({ event: await load(eventId) });
  });

  // Served only to signed-in users with access to the event. Guest-facing serving arrives with the guest site (Phase 5).
  app.get("/api/v1/events/:eventId/logo/:kind", { preHandler: requirePermission(pool, "event:view", { eventParam: "eventId" }) }, async (req, reply) => {
    const { eventId, kind } = req.params as { eventId: string; kind: string };
    const field = kind === "client" ? "clientLogo" : kind === "event" ? "eventLogo" : null;
    if (!field) return reply.code(400).send({ error: "bad_kind" });
    const key = (await pool.query("SELECT branding->>$2 AS k FROM event_settings WHERE event_id=$1", [eventId, field])).rows[0]?.k;
    if (!key) return reply.code(404).send({ error: "not_found" });
    const data = await getFile(key);
    const t = sniffImage(data)!;
    reply.header("Content-Type", t.mime);
    // SVG is served with a sandboxing CSP so it can never run script even if opened directly.
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(data);
  });
}
