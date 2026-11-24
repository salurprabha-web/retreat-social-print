import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FRAME_FORMATS, PRESETS, customSize, frameInputSchema, frameSize, newLayerId, presetLayers, type FrameInput, type FrameLayer } from "@rsp/shared";
import type { Pool, Tx } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { can, requirePermission, requireUser } from "../auth";
import { deleteFile, getFile, putFile, sniffImage, svgIsSafe } from "../storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSET_RE = /^[a-f0-9]{32}\.(png|jpg|webp|svg)$/;

export async function frameRoutes(app: FastifyInstance, pool: Pool) {
  const edit = requirePermission(pool, "builder:edit", { eventParam: "eventId" });
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });

  async function loadFrame(db: Pool | Tx, eventId: string, frameId: string) {
    if (!UUID.test(frameId)) return null;
    const f = (await db.query("SELECT * FROM frames WHERE id=$1 AND event_id=$2", [frameId, eventId])).rows[0];
    if (!f) return null;
    const layers = (await db.query("SELECT props FROM frame_layers WHERE frame_id=$1 AND event_id=$2 ORDER BY z_index", [frameId, eventId])).rows.map((r) => r.props as FrameLayer);
    return shape(f, layers);
  }
  function shape(f: any, layers: FrameLayer[]) {
    return { id: f.id, name: f.name, format: f.output_format, orientation: f.orientation, widthPx: f.width_px, heightPx: f.height_px, dpi: f.dpi,
      active: f.active, sponsorId: (f.sponsor_id as string | null) ?? null, updatedAt: f.updated_at, createdAt: f.created_at, layers };
  }
  const dims = (i: FrameInput) => frameSize(i.format, i.orientation, customSize({ format: i.format, customWidthIn: i.customWidthIn, customHeightIn: i.customHeightIn }));

  /** Replace all layers of a frame in one transaction. Slots are mirrored into frames.placeholders for fast composition lookups. */
  async function writeLayers(tx: Tx, eventId: string, frameId: string, layers: FrameLayer[]) {
    await tx.query("DELETE FROM frame_layers WHERE frame_id=$1 AND event_id=$2", [frameId, eventId]);
    for (let z = 0; z < layers.length; z++)
      await tx.query("INSERT INTO frame_layers(event_id,frame_id,type,z_index,props) VALUES ($1,$2,$3,$4,$5)", [eventId, frameId, layers[z].type, z, JSON.stringify(layers[z])]);
    const slots = layers.filter((l) => l.type === "photo").map((l: any) => ({ slot: l.slot, x: l.x, y: l.y, w: l.w, h: l.h, rotation: l.rotation }));
    await tx.query("UPDATE frames SET placeholders=$2 WHERE id=$1", [frameId, JSON.stringify(slots)]);
  }

  app.get("/api/v1/frame-formats", { preHandler: requireUser(pool) }, async () => ({
    formats: Object.entries(FRAME_FORMATS).map(([key, f]) => ({ key, label: f.label, ...frameSize(key as any, "portrait", { wIn: f.wIn, hIn: f.hIn }) })),
    presets: PRESETS,
  }));

  app.get("/api/v1/events/:eventId/frames", { preHandler: view }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const rows = (await pool.query("SELECT * FROM frames WHERE event_id=$1 ORDER BY created_at", [eventId])).rows;
    const layers = (await pool.query("SELECT frame_id,props FROM frame_layers WHERE event_id=$1 ORDER BY frame_id,z_index", [eventId])).rows;
    return { frames: rows.map((f) => shape(f, layers.filter((l) => l.frame_id === f.id).map((l) => l.props))) };
  });

  app.get("/api/v1/events/:eventId/frames/:frameId", { preHandler: view }, async (req, reply) => {
    const p = req.params as any; const f = await loadFrame(pool, p.eventId, p.frameId);
    return f ? { frame: f } : reply.code(404).send({ error: "not_found" });
  });

  // Create: from a starter preset, or with explicit layers.
  app.post("/api/v1/events/:eventId/frames", { preHandler: edit, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const b = z.object({
      name: z.string().trim().min(1).max(80), format: z.enum(Object.keys(FRAME_FORMATS) as [string, ...string[]]).default("4x6"),
      orientation: z.enum(["portrait", "landscape"]).default("portrait"), customWidthIn: z.number().min(1).max(12).optional(), customHeightIn: z.number().min(1).max(12).optional(),
      preset: z.enum(PRESETS).optional(), layers: z.array(z.unknown()).optional(), active: z.boolean().default(true), sponsorId: z.string().uuid().nullable().optional(),
    }).parse(req.body);
    if (b.sponsorId && !(await pool.query("SELECT 1 FROM sponsors WHERE id=$1 AND event_id=$2", [b.sponsorId, eventId])).rowCount) return reply.code(400).send({ error: "sponsor_not_found" });
    const size = frameSize(b.format as any, b.orientation, customSize({ format: b.format as any, customWidthIn: b.customWidthIn, customHeightIn: b.customHeightIn }));
    const layers = b.layers ?? presetLayers(b.preset ?? "single", size.widthPx, size.heightPx);
    const input = frameInputSchema.parse({ name: b.name, format: b.format, orientation: b.orientation, customWidthIn: b.customWidthIn, customHeightIn: b.customHeightIn, layers });
    const id = await withTx(pool, async (tx) => {
      const r = await tx.query(
        "INSERT INTO frames(event_id,name,output_format,orientation,width_px,height_px,dpi,active,created_by,sponsor_id) VALUES ($1,$2,$3,$4,$5,$6,300,$7,$8,$9) RETURNING id",
        [eventId, input.name, input.format, input.orientation, size.widthPx, size.heightPx, b.active, req.user!.id, b.sponsorId ?? null]);
      await writeLayers(tx, eventId, r.rows[0].id, input.layers);
      await audit(tx, req.user!.id, "frame_create", { eventId, entity: "frame", entityId: r.rows[0].id, detail: { name: input.name, format: input.format }, ip: req.ip });
      return r.rows[0].id as string;
    });
    return reply.code(201).send({ frame: await loadFrame(pool, eventId, id) });
  });

  // Save. `expectedUpdatedAt` protects against two admins overwriting each other.
  app.put("/api/v1/events/:eventId/frames/:frameId", { preHandler: edit, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const { eventId, frameId } = req.params as { eventId: string; frameId: string };
    if (!UUID.test(frameId)) return reply.code(404).send({ error: "not_found" });
    const body = z.object({ expectedUpdatedAt: z.string().optional() }).passthrough().parse(req.body);
    const input = frameInputSchema.parse(body);
    if (input.sponsorId && !(await pool.query("SELECT 1 FROM sponsors WHERE id=$1 AND event_id=$2", [input.sponsorId, eventId])).rowCount) return reply.code(400).send({ error: "sponsor_not_found" });
    const size = dims(input);
    const res = await withTx(pool, async (tx) => {
      const cur = (await tx.query("SELECT updated_at FROM frames WHERE id=$1 AND event_id=$2 FOR UPDATE", [frameId, eventId])).rows[0];
      if (!cur) return "missing" as const;
      if (body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() !== new Date(cur.updated_at).getTime()) return "conflict" as const;
      await tx.query("UPDATE frames SET name=$3,output_format=$4,orientation=$5,width_px=$6,height_px=$7,active=$8,sponsor_id=CASE WHEN $9::boolean THEN $10::uuid ELSE sponsor_id END,updated_at=now() WHERE id=$1 AND event_id=$2",
        [frameId, eventId, input.name, input.format, input.orientation, size.widthPx, size.heightPx, input.active, input.sponsorId !== undefined, input.sponsorId ?? null]);
      await writeLayers(tx, eventId, frameId, input.layers);
      await audit(tx, req.user!.id, "frame_update", { eventId, entity: "frame", entityId: frameId, ip: req.ip });
      return "ok" as const;
    });
    if (res === "missing") return reply.code(404).send({ error: "not_found" });
    if (res === "conflict") return reply.code(409).send({ error: "modified_elsewhere" });
    return { frame: await loadFrame(pool, eventId, frameId) };
  });

  app.post("/api/v1/events/:eventId/frames/:frameId/duplicate", { preHandler: edit }, async (req, reply) => {
    const { eventId, frameId } = req.params as { eventId: string; frameId: string };
    const src = await loadFrame(pool, eventId, frameId);
    if (!src) return reply.code(404).send({ error: "not_found" });
    const id = await withTx(pool, async (tx) => {
      const r = await tx.query("INSERT INTO frames(event_id,name,output_format,orientation,width_px,height_px,dpi,active,created_by,sponsor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [eventId, `${src.name} (copy)`, src.format, src.orientation, src.widthPx, src.heightPx, src.dpi, false, req.user!.id, src.sponsorId]);
      await writeLayers(tx, eventId, r.rows[0].id, src.layers.map((l) => ({ ...l, id: newLayerId() })));
      await audit(tx, req.user!.id, "frame_duplicate", { eventId, entity: "frame", entityId: r.rows[0].id, detail: { from: frameId }, ip: req.ip });
      return r.rows[0].id as string;
    });
    return reply.code(201).send({ frame: await loadFrame(pool, eventId, id) });
  });

  // "Assign frame to events": copy into another event. The caller must be allowed to edit BOTH events; uploaded images are copied too.
  app.post("/api/v1/events/:eventId/frames/:frameId/copy-to/:targetId", { preHandler: edit }, async (req, reply) => {
    const { eventId, frameId, targetId } = req.params as { eventId: string; frameId: string; targetId: string };
    if (!UUID.test(targetId)) return reply.code(404).send({ error: "not_found" });
    if (!can(req.user!, "builder:edit", targetId)) return reply.code(403).send({ error: "forbidden" });
    if (!(await pool.query("SELECT 1 FROM events WHERE id=$1", [targetId])).rowCount) return reply.code(404).send({ error: "not_found" });
    const src = await loadFrame(pool, eventId, frameId);
    if (!src) return reply.code(404).send({ error: "not_found" });
    const copied: string[] = [];
    try {
      const layers: FrameLayer[] = [];
      for (const l of src.layers) {
        const c: any = { ...l, id: newLayerId() };
        if (c.type === "image" && c.src) {
          const data = await getFile(`events/${eventId}/frames/${c.src}`);
          const key = await putFile(`events/${targetId}/frames`, c.src.split(".").pop()!, data);
          copied.push(key); c.src = key.split("/").pop();
        }
        layers.push(c);
      }
      const id = await withTx(pool, async (tx) => {
        const r = await tx.query("INSERT INTO frames(event_id,name,output_format,orientation,width_px,height_px,dpi,active,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING id",
          [targetId, src.name, src.format, src.orientation, src.widthPx, src.heightPx, src.dpi, req.user!.id]);
        await writeLayers(tx, targetId, r.rows[0].id, layers);
        await audit(tx, req.user!.id, "frame_copy", { eventId: targetId, entity: "frame", entityId: r.rows[0].id, detail: { fromEvent: eventId, fromFrame: frameId }, ip: req.ip });
        return r.rows[0].id as string;
      });
      return reply.code(201).send({ frame: await loadFrame(pool, targetId, id) });
    } catch (e) {
      for (const k of copied) await deleteFile(k).catch(() => {});
      throw e;
    }
  });

  // Deleting a frame that photos were made with would delete those photos' records (cascade), so it is refused: deactivate instead.
  app.delete("/api/v1/events/:eventId/frames/:frameId", { preHandler: edit }, async (req, reply) => {
    const { eventId, frameId } = req.params as { eventId: string; frameId: string };
    if (!UUID.test(frameId)) return reply.code(404).send({ error: "not_found" });
    const used = (await pool.query("SELECT count(*)::int c FROM final_compositions WHERE frame_id=$1 AND event_id=$2", [frameId, eventId])).rows[0].c;
    if (used > 0) return reply.code(409).send({ error: "frame_in_use", uses: used });
    const r = await pool.query("DELETE FROM frames WHERE id=$1 AND event_id=$2", [frameId, eventId]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, "frame_delete", { eventId, entity: "frame", entityId: frameId, ip: req.ip });
    return { ok: true };
  });

  // ----- Images used inside frames (transparent PNG overlays, backgrounds, sponsor logos) -----
  app.post("/api/v1/events/:eventId/frame-assets", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(415).send({ error: "image_required" });
    const t = sniffImage(body);
    if (!t) return reply.code(415).send({ error: "unsupported_image" });
    if (t.ext === "svg" && !svgIsSafe(body.toString("utf8"))) return reply.code(422).send({ error: "unsafe_svg" });
    const key = await putFile(`events/${eventId}/frames`, t.ext, body);
    await audit(pool, req.user!.id, "frame_asset", { eventId, entity: "asset", detail: { bytes: body.length, type: t.ext }, ip: req.ip });
    return reply.code(201).send({ name: key.split("/").pop() });
  });

  async function sendAsset(reply: any, eventId: string, name: string) {
    if (!ASSET_RE.test(name)) return reply.code(404).send({ error: "not_found" });
    let data: Buffer;
    try { data = await getFile(`events/${eventId}/frames/${name}`); } catch { return reply.code(404).send({ error: "not_found" }); }
    reply.header("Content-Type", sniffImage(data)!.mime);
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(data);
  }
  app.get("/api/v1/events/:eventId/frame-assets/:name", { preHandler: view }, async (req, reply) => {
    const p = req.params as any; return sendAsset(reply, p.eventId, p.name);
  });

  // ----- Guests: only ACTIVE frames of an ACTIVE event with a published page -----
  async function publicEventId(token: string) {
    if (!/^[0-9a-f]{24}$/.test(token)) return null;
    const r = (await pool.query(
      `SELECT e.id FROM events e WHERE e.guest_token=$1 AND e.status='active'
         AND EXISTS (SELECT 1 FROM guest_experience_pages p WHERE p.event_id=e.id AND p.state='published')`, [token])).rows[0];
    return r?.id as string | undefined;
  }
  app.get("/api/v1/public/g/:token/frames", async (req, reply) => {
    const id = await publicEventId((req.params as any).token);
    if (!id) return reply.code(404).send({ error: "not_available" });
    const rows = (await pool.query("SELECT * FROM frames WHERE event_id=$1 AND active ORDER BY created_at", [id])).rows;
    const layers = (await pool.query("SELECT frame_id,props FROM frame_layers WHERE event_id=$1 ORDER BY frame_id,z_index", [id])).rows;
    return { frames: rows.map((f) => {
      const s = shape(f, layers.filter((l) => l.frame_id === f.id).map((l) => l.props));
      return { id: s.id, name: s.name, format: s.format, widthPx: s.widthPx, heightPx: s.heightPx, sponsorId: s.sponsorId, layers: s.layers };
    }) };
  });
  app.get("/api/v1/public/g/:token/frame-assets/:name", async (req, reply) => {
    const p = req.params as any;
    const id = await publicEventId(p.token);
    if (!id || !ASSET_RE.test(p.name)) return reply.code(404).send({ error: "not_found" });
    // Only files used by an ACTIVE frame are reachable.
    const used = await pool.query("SELECT 1 FROM frame_layers l JOIN frames f ON f.id=l.frame_id WHERE l.event_id=$1 AND f.active AND l.props->>'src'=$2 LIMIT 1", [id, p.name]);
    if (!used.rowCount) return reply.code(404).send({ error: "not_found" });
    return sendAsset(reply, id, p.name);
  });
}
