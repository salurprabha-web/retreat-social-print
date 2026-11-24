import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BUILTIN_TEMPLATES, DEFAULT_DEFINITION, builtinByKey, pageDefinitionSchema, stripAssets, type PageDefinition } from "@rsp/shared";
import type { Pool, Tx } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission, requireUser } from "../auth";
import { getFile, putFile, sniffImage, svgIsSafe } from "../storage";

const ASSET_RE = /^[a-f0-9]{32}\.(png|jpg|webp|svg)$/;

export async function guestPageRoutes(app: FastifyInstance, pool: Pool) {
  const edit = requirePermission(pool, "builder:edit", { eventParam: "eventId" });
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });

  const parse = (def: unknown): PageDefinition => pageDefinitionSchema.parse(def);

  async function eventInfo(db: Pool | Tx, id: string) {
    const r = (await db.query("SELECT name,hashtag,event_date,client_name,status FROM events WHERE id=$1", [id])).rows[0];
    return r ? { name: r.name, hashtag: r.hashtag, eventDate: r.event_date ? new Date(r.event_date).toISOString().slice(0, 10) : null, clientName: r.client_name, status: r.status } : null;
  }

  async function state(eventId: string) {
    const rows = (await pool.query(
      `SELECT g.version,g.state,g.note,g.created_at,g.published_at,g.definition,u.name AS author
         FROM guest_experience_pages g LEFT JOIN users u ON u.id=g.created_by WHERE g.event_id=$1 ORDER BY g.version DESC`, [eventId])).rows;
    const draft = rows.find((r) => r.state === "draft");
    const pub = rows.find((r) => r.state === "published");
    const working = draft?.definition ?? pub?.definition ?? DEFAULT_DEFINITION();
    return {
      definition: working as PageDefinition,
      draftVersion: draft?.version ?? null,
      hasUnpublishedChanges: !!draft,
      published: pub ? { version: pub.version, publishedAt: pub.published_at } : null,
      versions: rows.map((r) => ({ version: r.version, state: r.state, note: r.note, createdAt: r.created_at, publishedAt: r.published_at, author: r.author })),
      event: await eventInfo(pool, eventId),
    };
  }

  /** Create or replace the single draft row (one draft per event is enforced by a partial unique index). */
  async function saveDraft(tx: Tx, eventId: string, userId: string, def: PageDefinition, note: string | null) {
    await tx.query("SELECT 1 FROM events WHERE id=$1 FOR UPDATE", [eventId]);   // serialises concurrent builder writes
    const cur = (await tx.query("SELECT id FROM guest_experience_pages WHERE event_id=$1 AND state='draft'", [eventId])).rows[0];
    if (cur) {
      await tx.query("UPDATE guest_experience_pages SET definition=$2, note=COALESCE($3,note), created_by=$4 WHERE id=$1", [cur.id, JSON.stringify(def), note, userId]);
    } else {
      const v = (await tx.query("SELECT COALESCE(max(version),0)+1 v FROM guest_experience_pages WHERE event_id=$1", [eventId])).rows[0].v;
      await tx.query(
        "INSERT INTO guest_experience_pages(event_id,version,state,definition,note,created_by) VALUES ($1,$2,'draft',$3,$4,$5)",
        [eventId, v, JSON.stringify(def), note, userId]);
    }
  }

  app.get("/api/v1/events/:eventId/builder", { preHandler: view }, async (req) => state((req.params as any).eventId));

  app.put("/api/v1/events/:eventId/builder/draft", { preHandler: edit, bodyLimit: 1024 * 1024 }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const { definition } = z.object({ definition: z.unknown() }).parse(req.body);
    const def = parse(definition);
    await withTx(pool, (tx) => saveDraft(tx, eventId, req.user!.id, def, null));
    await audit(pool, req.user!.id, "builder_save_draft", { eventId, entity: "guest_page", ip: req.ip });
    return state(eventId);
  });

  app.post("/api/v1/events/:eventId/builder/publish", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const note = z.object({ note: z.string().max(200).optional() }).parse(req.body ?? {}).note ?? null;
    const ok = await withTx(pool, async (tx) => {
      await tx.query("SELECT 1 FROM events WHERE id=$1 FOR UPDATE", [eventId]);
      const d = (await tx.query("SELECT id,definition FROM guest_experience_pages WHERE event_id=$1 AND state='draft'", [eventId])).rows[0];
      if (!d) return false;
      parse(d.definition);   // never publish something that no longer validates
      await tx.query("UPDATE guest_experience_pages SET state='superseded' WHERE event_id=$1 AND state='published'", [eventId]);
      await tx.query("UPDATE guest_experience_pages SET state='published', published_at=now(), note=COALESCE($2,note) WHERE id=$1", [d.id, note]);
      await audit(tx, req.user!.id, "builder_publish", { eventId, entity: "guest_page", entityId: d.id, ip: req.ip });
      return true;
    });
    if (!ok) return reply.code(409).send({ error: "no_draft_to_publish" });
    return state(eventId);
  });

  app.post("/api/v1/events/:eventId/builder/unpublish", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const r = await pool.query("UPDATE guest_experience_pages SET state='superseded' WHERE event_id=$1 AND state='published'", [eventId]);
    if (!r.rowCount) return reply.code(409).send({ error: "not_published" });
    await audit(pool, req.user!.id, "builder_unpublish", { eventId, entity: "guest_page", ip: req.ip });
    return state(eventId);
  });

  app.post("/api/v1/events/:eventId/builder/restore", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const { version } = z.object({ version: z.number().int().positive() }).parse(req.body);
    const ok = await withTx(pool, async (tx) => {
      const v = (await tx.query("SELECT definition FROM guest_experience_pages WHERE event_id=$1 AND version=$2", [eventId, version])).rows[0];
      if (!v) return false;
      await saveDraft(tx, eventId, req.user!.id, parse(v.definition), `Restored from version ${version}`);
      return true;
    });
    if (!ok) return reply.code(404).send({ error: "version_not_found" });
    await audit(pool, req.user!.id, "builder_restore", { eventId, entity: "guest_page", detail: { version }, ip: req.ip });
    return state(eventId);
  });

  // ----- Templates -----
  app.get("/api/v1/templates", { preHandler: requireUser(pool) }, async () => {
    const saved = (await pool.query("SELECT id,name,category FROM guest_experience_templates WHERE event_id IS NULL ORDER BY created_at DESC")).rows;
    return {
      builtin: BUILTIN_TEMPLATES.map((t) => ({ key: t.key, name: t.name, category: t.category })),
      saved: saved.map((r) => ({ id: r.id, name: r.name, category: r.category })),
    };
  });

  app.post("/api/v1/events/:eventId/builder/apply-template", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const b = z.object({ builtin: z.string().optional(), templateId: z.string().uuid().optional() }).parse(req.body);
    let def: PageDefinition | null = null;
    if (b.builtin) def = builtinByKey(b.builtin)?.definition ?? null;
    else if (b.templateId) {
      const r = (await pool.query("SELECT definition FROM guest_experience_templates WHERE id=$1 AND event_id IS NULL", [b.templateId])).rows[0];
      def = r ? parse(r.definition) : null;
    }
    if (!def) return reply.code(404).send({ error: "template_not_found" });
    await withTx(pool, (tx) => saveDraft(tx, eventId, req.user!.id, structuredClone(def!), "Applied template"));
    await audit(pool, req.user!.id, "builder_apply_template", { eventId, entity: "guest_page", detail: b, ip: req.ip });
    return state(eventId);
  });

  // Saved templates are shared across events, so uploaded files are stripped: a template can never expose another client's assets.
  app.post("/api/v1/events/:eventId/builder/save-template", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const { name, definition } = z.object({ name: z.string().trim().min(2).max(80), definition: z.unknown() }).parse(req.body);
    const clean = stripAssets(parse(definition));
    const r = await pool.query("INSERT INTO guest_experience_templates(event_id,name,category,definition) VALUES (NULL,$1,'Saved',$2) RETURNING id", [name, JSON.stringify(clean)]);
    await audit(pool, req.user!.id, "builder_save_template", { eventId, entity: "template", entityId: r.rows[0].id, detail: { name }, ip: req.ip });
    return reply.code(201).send({ id: r.rows[0].id });
  });

  // ----- Assets used by the page (backgrounds, images, sponsor logos) -----
  app.post("/api/v1/events/:eventId/builder/asset", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(415).send({ error: "image_required" });
    const t = sniffImage(body);
    if (!t) return reply.code(415).send({ error: "unsupported_image" });
    if (t.ext === "svg" && !svgIsSafe(body.toString("utf8"))) return reply.code(422).send({ error: "unsafe_svg" });
    const key = await putFile(`events/${eventId}/builder`, t.ext, body);
    await audit(pool, req.user!.id, "builder_asset", { eventId, entity: "asset", detail: { bytes: body.length, type: t.ext }, ip: req.ip });
    return reply.code(201).send({ name: key.split("/").pop() });
  });

  async function sendAsset(reply: any, eventId: string, name: string) {
    if (!ASSET_RE.test(name)) return reply.code(404).send({ error: "not_found" });
    let data: Buffer;
    try { data = await getFile(`events/${eventId}/builder/${name}`); } catch { return reply.code(404).send({ error: "not_found" }); }
    reply.header("Content-Type", sniffImage(data)!.mime);
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(data);
  }
  app.get("/api/v1/events/:eventId/builder/asset/:name", { preHandler: view }, async (req, reply) => {
    const p = req.params as any; return sendAsset(reply, p.eventId, p.name);
  });

  // ----- Public (guests): only the PUBLISHED page of an ACTIVE event; nothing else about the event is exposed -----
  async function publicEvent(token: string) {
    if (!/^[0-9a-f]{24}$/.test(token)) return null;
    const e = (await pool.query("SELECT id FROM events WHERE guest_token=$1 AND status='active'", [token])).rows[0];
    if (!e) return null;
    const p = (await pool.query("SELECT definition FROM guest_experience_pages WHERE event_id=$1 AND state='published'", [e.id])).rows[0];
    return p ? { id: e.id as string, definition: p.definition as PageDefinition } : null;
  }

  app.get("/api/v1/public/g/:token", async (req, reply) => {
    const pe = await publicEvent((req.params as any).token);
    if (!pe) return reply.code(404).send({ error: "not_available" });
    const info = (await eventInfo(pool, pe.id))!;
    const b = (await pool.query("SELECT branding FROM event_settings WHERE event_id=$1", [pe.id])).rows[0]?.branding ?? {};
    return {
      definition: pe.definition,
      event: { name: info.name, hashtag: info.hashtag, eventDate: info.eventDate, clientName: info.clientName },
      logos: { event: !!b.eventLogo, client: !!b.clientLogo },
    };
  });

  app.get("/api/v1/public/g/:token/asset/:name", async (req, reply) => {
    const p = req.params as any;
    const pe = await publicEvent(p.token);
    // Only files the published page actually references are reachable.
    if (!pe || !JSON.stringify(pe.definition).includes(p.name)) return reply.code(404).send({ error: "not_found" });
    return sendAsset(reply, pe.id, p.name);
  });

  app.get("/api/v1/public/g/:token/logo/:kind", async (req, reply) => {
    const p = req.params as any;
    const pe = await publicEvent(p.token);
    const field = p.kind === "client" ? "clientLogo" : p.kind === "event" ? "eventLogo" : null;
    if (!pe || !field) return reply.code(404).send({ error: "not_found" });
    const key = (await pool.query("SELECT branding->>$2 AS k FROM event_settings WHERE event_id=$1", [pe.id, field])).rows[0]?.k;
    if (!key) return reply.code(404).send({ error: "not_found" });
    const data = await getFile(key);
    reply.header("Content-Type", sniffImage(data)!.mime);
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(data);
  });
}
