import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { config } from "../config";
import { getFile } from "../storage";
import { DEFAULT_QR_STYLE, QR_CODE_RE, newQrCode, qrContrastOk, qrPng, qrSvg, type QrStyle } from "../qrcodes";
import { renderPoster } from "../poster";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const landing = z.string().max(500).refine((u) => /^(https:\/\/[^\s]+|\/[^\s/][^\s]*)$/.test(u), "must start with https:// or /");
const styleSchema = z.object({ fg: hex, bg: hex, logo: z.boolean(), margin: z.number().int().min(1).max(8) }).partial();
const baseSchema = z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/);

const gone = (reply: FastifyReply) => reply.code(410).type("text/html").send(
  "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>QR code not active</title>" +
  "<body style='font-family:system-ui;text-align:center;padding:12vh 20px'><h1>This QR code is not active</h1><p>The event may not have started, may have ended, or this code was replaced. Please ask event staff for help.</p></body>");

export async function qrRoutes(app: FastifyInstance, pool: Pool) {
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });
  const edit = requirePermission(pool, "builder:edit", { eventParam: "eventId" });

  /** Public address the code points at. The admin page supplies its own origin (works for any deployment); PUBLIC_BASE_URL overrides. */
  function baseOf(req: FastifyRequest): string | null {
    const b = (req.query as any).base;
    if (b !== undefined) { const p = baseSchema.safeParse(b); return p.success ? p.data : null; }
    return config.publicBaseUrl || null;
  }
  const mergeStyle = (s: unknown): QrStyle => ({ ...DEFAULT_QR_STYLE, ...((s as Partial<QrStyle>) ?? {}) });
  const shape = (r: any, base: string | null, series: { day: string; count: number }[]) => ({
    id: r.id, code: r.code, label: r.label, enabled: r.enabled, expiresAt: r.expires_at, landingUrl: r.landing_url, kioskLabel: r.kiosk_label,
    style: mergeStyle(r.style), scans: r.scans, path: `/q/${r.code}`, url: base ? `${base}/q/${r.code}` : null, createdAt: r.created_at, scansByDay: series,
  });
  async function logoOf(eventId: string): Promise<Buffer | null> {
    const key = (await pool.query("SELECT branding->>'eventLogo' k FROM event_settings WHERE event_id=$1", [eventId])).rows[0]?.k;
    if (!key) return null;
    try { return await getFile(key); } catch { return null; }
  }
  async function load(eventId: string, qrId: string) {
    if (!UUID.test(qrId)) return null;
    return (await pool.query("SELECT * FROM qr_tracking WHERE id=$1 AND event_id=$2", [qrId, eventId])).rows[0] ?? null;
  }

  app.get("/api/v1/events/:eventId/qr", { preHandler: view }, async (req) => {
    const eventId = (req.params as any).eventId as string; const base = baseOf(req);
    const rows = (await pool.query("SELECT * FROM qr_tracking WHERE event_id=$1 ORDER BY created_at", [eventId])).rows;
    const days = (await pool.query(
      `SELECT qr_id, to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*)::int c FROM qr_scan_events
        WHERE event_id=$1 AND at > now() - interval '14 days' GROUP BY 1,2 ORDER BY 2`, [eventId])).rows;
    return { qrCodes: rows.map((r) => shape(r, base, days.filter((d) => d.qr_id === r.id).map((d) => ({ day: d.day, count: d.c })))), baseConfigured: !!config.publicBaseUrl };
  });

  const writeSchema = z.object({
    label: z.string().trim().min(1).max(80), enabled: z.boolean(), expiresAt: z.string().datetime().nullable(),
    landingUrl: landing.nullable(), kioskLabel: z.string().trim().max(80).nullable(), style: styleSchema,
  });
  function checkStyle(style: Partial<QrStyle> | undefined): string | null {
    const s = mergeStyle(style);
    return qrContrastOk(s.fg, s.bg) ? null : "low_contrast";
  }

  app.post("/api/v1/events/:eventId/qr", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const b = writeSchema.partial().required({ label: true }).parse(req.body);
    const bad = checkStyle(b.style); if (bad) return reply.code(400).send({ error: bad });
    const n = (await pool.query("SELECT count(*)::int c FROM qr_tracking WHERE event_id=$1", [eventId])).rows[0].c;
    if (n >= 50) return reply.code(409).send({ error: "too_many_qr_codes" });
    const r = (await pool.query(
      "INSERT INTO qr_tracking(event_id,code,label,expires_at,landing_url,kiosk_label,style,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [eventId, newQrCode(), b.label, b.expiresAt ?? null, b.landingUrl ?? null, b.kioskLabel ?? null, JSON.stringify(mergeStyle(b.style)), b.enabled ?? true])).rows[0];
    await audit(pool, req.user!.id, "qr_create", { eventId, entity: "qr", entityId: r.id, detail: { label: b.label }, ip: req.ip });
    return reply.code(201).send({ qr: shape(r, baseOf(req), []) });
  });

  app.patch("/api/v1/events/:eventId/qr/:qrId", { preHandler: edit }, async (req, reply) => {
    const { eventId, qrId } = req.params as { eventId: string; qrId: string };
    const cur = await load(eventId, qrId); if (!cur) return reply.code(404).send({ error: "not_found" });
    const b = writeSchema.partial().parse(req.body);
    const style = b.style ? { ...mergeStyle(cur.style), ...b.style } : undefined;
    if (style) { const bad = checkStyle(style); if (bad) return reply.code(400).send({ error: bad }); }
    const sets: string[] = []; const vals: unknown[] = [qrId, eventId];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (b.label !== undefined) add("label", b.label);
    if (b.enabled !== undefined) add("enabled", b.enabled);
    if (b.expiresAt !== undefined) add("expires_at", b.expiresAt);
    if (b.landingUrl !== undefined) add("landing_url", b.landingUrl);
    if (b.kioskLabel !== undefined) add("kiosk_label", b.kioskLabel);
    if (style) add("style", JSON.stringify(style));
    if (!sets.length) return reply.code(400).send({ error: "nothing_to_update" });
    const r = (await pool.query(`UPDATE qr_tracking SET ${sets.join(",")}, updated_at=now() WHERE id=$1 AND event_id=$2 RETURNING *`, vals)).rows[0];
    await audit(pool, req.user!.id, "qr_update", { eventId, entity: "qr", entityId: qrId, detail: b as object, ip: req.ip });
    return { qr: shape(r, baseOf(req), []) };
  });

  // Regenerate = a brand-new code on the same record. Printed copies of the old code stop working immediately.
  app.post("/api/v1/events/:eventId/qr/:qrId/regenerate", { preHandler: edit }, async (req, reply) => {
    const { eventId, qrId } = req.params as { eventId: string; qrId: string };
    if (!(await load(eventId, qrId))) return reply.code(404).send({ error: "not_found" });
    const r = (await pool.query("UPDATE qr_tracking SET code=$3, updated_at=now() WHERE id=$1 AND event_id=$2 RETURNING *", [qrId, eventId, newQrCode()])).rows[0];
    await audit(pool, req.user!.id, "qr_regenerate", { eventId, entity: "qr", entityId: qrId, ip: req.ip });
    return { qr: shape(r, baseOf(req), []) };
  });

  app.delete("/api/v1/events/:eventId/qr/:qrId", { preHandler: edit }, async (req, reply) => {
    const { eventId, qrId } = req.params as { eventId: string; qrId: string };
    if (!UUID.test(qrId)) return reply.code(404).send({ error: "not_found" });
    const r = await pool.query("DELETE FROM qr_tracking WHERE id=$1 AND event_id=$2", [qrId, eventId]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, "qr_delete", { eventId, entity: "qr", entityId: qrId, ip: req.ip });
    return { ok: true };
  });

  // ----- Downloads -----
  app.get("/api/v1/events/:eventId/qr/:qrId/image", { preHandler: view }, async (req, reply) => {
    const { eventId, qrId } = req.params as { eventId: string; qrId: string };
    const q = z.object({ format: z.enum(["png", "svg"]).default("png"), size: z.coerce.number().int().min(256).max(4096).default(1024), download: z.string().optional() }).parse(req.query);
    const row = await load(eventId, qrId); if (!row) return reply.code(404).send({ error: "not_found" });
    const base = baseOf(req); if (!base) return reply.code(400).send({ error: "base_required" });
    const style = mergeStyle(row.style); const logo = style.logo ? await logoOf(eventId) : null;
    const url = `${base}/q/${row.code}`;
    if (q.download) reply.header("Content-Disposition", `attachment; filename="qr-${row.code}.${q.format}"`);
    if (q.format === "svg") return reply.type("image/svg+xml").send(await qrSvg(url, style, q.size, logo));
    return reply.type("image/png").send(await qrPng(url, style, q.size, logo));
  });

  app.get("/api/v1/events/:eventId/qr/:qrId/poster", { preHandler: view }, async (req, reply) => {
    const { eventId, qrId } = req.params as { eventId: string; qrId: string };
    const row = await load(eventId, qrId); if (!row) return reply.code(404).send({ error: "not_found" });
    const base = baseOf(req); if (!base) return reply.code(400).send({ error: "base_required" });
    const style = mergeStyle(row.style);
    const ev = (await pool.query("SELECT e.name,e.hashtag,s.branding FROM events e JOIN event_settings s ON s.event_id=e.id WHERE e.id=$1", [eventId])).rows[0];
    const logo = await logoOf(eventId);
    const qrSize = 1500;
    const qr = await qrPng(`${base}/q/${row.code}`, style, qrSize, style.logo ? logo : null);
    const png = await renderPoster({ eventName: ev.name, hashtag: ev.hashtag, qr, qrSize, logo, accent: ev.branding?.primaryColor ?? "#b8862b" });
    reply.header("Content-Disposition", `attachment; filename="qr-poster-${row.code}.png"`);
    return reply.type("image/png").send(png);
  });

  // ----- Public: scanning -----
  async function activeCode(code: string) {
    if (!QR_CODE_RE.test(code)) return null;
    const r = (await pool.query(
      `SELECT q.id,q.event_id,q.landing_url,q.style,e.guest_token,e.name,e.hashtag,s.branding FROM qr_tracking q
         JOIN events e ON e.id=q.event_id JOIN event_settings s ON s.event_id=e.id
        WHERE q.code=$1 AND q.enabled AND (q.expires_at IS NULL OR q.expires_at > now()) AND e.status='active'`, [code])).rows[0];
    return r ?? null;
  }

  app.get("/api/v1/public/q/:code", async (req, reply) => {
    const r = await activeCode((req.params as any).code);
    if (!r) return gone(reply);
    await withTx(pool, async (tx) => {
      await tx.query("UPDATE qr_tracking SET scans=scans+1 WHERE id=$1", [r.id]);
      await tx.query("INSERT INTO qr_scan_events(event_id,qr_id) VALUES ($1,$2)", [r.event_id, r.id]);
    });
    return reply.redirect(r.landing_url ?? `/g/${r.guest_token}`, 302);
  });

  // Data for the full-screen kiosk QR page. Nothing secret: the event name, colours and the code itself.
  app.get("/api/v1/public/q/:code/display", async (req, reply) => {
    const r = await activeCode((req.params as any).code);
    if (!r) return reply.code(404).send({ error: "not_available" });
    const page = (await pool.query("SELECT definition FROM guest_experience_pages WHERE event_id=$1 AND state='published'", [r.event_id])).rows[0]?.definition;
    const t = page?.theme;
    return {
      eventName: r.name, hashtag: r.hashtag, path: `/q/${(req.params as any).code}`, style: mergeStyle(r.style), hasLogo: !!r.branding?.eventLogo,
      theme: t ? { background: t.background, textColor: t.textColor, accentColor: t.accentColor, fontFamily: t.fontFamily } : null,
    };
  });
  app.get("/api/v1/public/q/:code/logo", async (req, reply) => {
    const r = await activeCode((req.params as any).code);
    if (!r?.branding?.eventLogo) return reply.code(404).send({ error: "not_found" });
    const { sniffImage } = await import("../storage");
    const data = await getFile(r.branding.eventLogo);
    reply.header("Content-Type", sniffImage(data)!.mime);
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(data);
  });
}
