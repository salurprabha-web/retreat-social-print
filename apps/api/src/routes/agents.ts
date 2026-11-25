import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { FRAME_FORMATS } from "@rsp/shared";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { config } from "../config";
import { requirePermission, tagAuth } from "../auth";
import { getFile } from "../storage";
import { PrintError, claimNext, reportResult, transition } from "../printService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_MINUTES = 30;
export const AGENT_ONLINE_SECONDS = 45;
export const MIN_AGENT_VERSION = "1.0.0";
const PAPER_KEYS = [...Object.keys(FRAME_FORMATS).filter((k) => k !== "custom"), "any"] as const;

const newPairingCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
const pretty = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

interface Device { id: string; event_id: string; name: string }
declare module "fastify" { interface FastifyRequest { device?: Device } }

export async function agentRoutes(app: FastifyInstance, pool: Pool) {
  /** Device credential: `Authorization: Bearer agt_...`. Only its hash is stored; a revoked or disabled device stops working at once. */
  const requireDevice = tagAuth(async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Bearer (agt_[A-Za-z0-9_-]{20,80})$/.exec(String(req.headers.authorization ?? ""));
    if (!m) return reply.code(401).send({ error: "unauthenticated" });
    const d = (await pool.query("SELECT id,event_id,name FROM devices WHERE token_hash=$1 AND kind='print_agent' AND enabled AND paired_at IS NOT NULL AND event_id IS NOT NULL", [sha(m[1])])).rows[0];
    if (!d) return reply.code(401).send({ error: "unauthenticated" });
    req.device = d;
  }, { kind: "agent" });
  const limit = { config: { rateLimit: { max: () => config.agentRateLimitPerMin, timeWindow: "1 minute" } } };

  /* ------------------------- Agent -> server ------------------------- */

  app.post("/api/v1/agent/register", { config: { rateLimit: { max: () => config.agentRegisterLimitPerMin, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = z.object({ code: z.string().min(6).max(20), hostName: z.string().trim().max(120).default(""), version: z.string().max(40).default("") }).parse(req.body);
    const code = normalizeCode(b.code);
    const d = (await pool.query("SELECT d.id,d.event_id,d.name,e.name AS event_name FROM devices d JOIN events e ON e.id=d.event_id WHERE d.pairing_hash=$1 AND d.pairing_expires_at > now() AND d.enabled AND d.kind='print_agent'", [sha(code)])).rows[0];
    if (!d) return reply.code(401).send({ error: "invalid_code" });                     // same answer for wrong, used and expired codes
    const token = "agt_" + randomBytes(32).toString("base64url");
    await pool.query("UPDATE devices SET token_hash=$2, pairing_hash=NULL, pairing_expires_at=NULL, paired_at=now(), host_name=$3, version=$4, last_seen_at=now(), last_ip=$5 WHERE id=$1",
      [d.id, sha(token), b.hostName, b.version, req.ip]);
    await audit(pool, null, "agent_paired", { eventId: d.event_id, entity: "device", entityId: d.id, detail: { host: b.hostName, version: b.version }, ip: req.ip });
    return reply.code(201).send({ deviceToken: token, deviceId: d.id, deviceName: d.name, eventId: d.event_id, eventName: d.event_name });
  });

  app.post("/api/v1/agent/heartbeat", { preHandler: requireDevice, ...limit }, async (req) => {
    const dev = req.device!;
    const b = z.object({
      version: z.string().max(40).default(""), hostName: z.string().max(120).default(""),
      printers: z.array(z.object({
        name: z.string().min(1).max(200), state: z.enum(["ready", "busy", "offline", "error", "paused", "unknown"]),
        // Real drivers send null for "nothing to report" and paper names of any length: accept both, trim instead of refusing.
        detail: z.string().nullish().transform((s) => (s ?? undefined)?.slice(0, 200)),
        paperSizes: z.array(z.string().transform((s) => s.slice(0, 120))).max(200).default([]),
      })).max(40),
    }).parse(req.body);
    await withTx(pool, async (tx) => {
      await tx.query("UPDATE devices SET last_seen_at=now(), version=$2, host_name=$3, last_ip=$4 WHERE id=$1", [dev.id, b.version, b.hostName, req.ip]);
      for (const p of b.printers)
        await tx.query(
          `INSERT INTO printers(event_id,device_id,name,windows_name,status,detail,driver_papers,last_seen_at) VALUES ($1,$2,$3,$3,$4,$5,$6,now())
           ON CONFLICT (device_id, windows_name) WHERE device_id IS NOT NULL DO UPDATE SET status=EXCLUDED.status, detail=EXCLUDED.detail, driver_papers=EXCLUDED.driver_papers, last_seen_at=now()`,
          [dev.event_id, dev.id, p.name, p.state, p.detail ?? null, JSON.stringify(p.paperSizes)]);
      await tx.query("UPDATE printers SET status='missing', detail='Not found on that computer' WHERE device_id=$1 AND windows_name <> ALL($2::text[])", [dev.id, b.printers.map((p) => p.name)]);
    });
    const ev = (await pool.query("SELECT e.name,s.print_paused FROM events e JOIN event_settings s ON s.event_id=e.id WHERE e.id=$1", [dev.event_id])).rows[0];
    const printers = (await pool.query("SELECT windows_name,enabled,paper_size,orientation FROM printers WHERE device_id=$1", [dev.id])).rows;
    return {
      ok: true, serverTime: new Date().toISOString(), event: { id: dev.event_id, name: ev.name }, deviceName: dev.name, queuePaused: ev.print_paused,
      pollSeconds: 2, minAgentVersion: MIN_AGENT_VERSION,
      printers: printers.map((p) => ({ name: p.windows_name, enabled: p.enabled, paperSize: p.paper_size, orientation: p.orientation })),
    };
  });

  app.post("/api/v1/agent/claim", { preHandler: requireDevice, ...limit }, async (req, reply) => {
    const dev = req.device!;
    const { printer } = z.object({ printer: z.string().min(1).max(200) }).parse(req.body);
    const p = (await pool.query("SELECT id,enabled,paper_size,orientation FROM printers WHERE device_id=$1 AND windows_name=$2", [dev.id, printer])).rows[0];
    if (!p) return reply.code(404).send({ error: "unknown_printer" });
    await pool.query("UPDATE devices SET last_seen_at=now() WHERE id=$1", [dev.id]);
    if (!p.enabled) return { job: null, reason: "printer_disabled" };
    const j = await claimNext(pool, dev.event_id, p.id, p.paper_size);
    if (!j) return { job: null };
    const d = (await pool.query(
      `SELECT c.width_px,c.height_px,c.sha256,c.bytes,f.output_format,f.orientation,s.guest_code FROM final_compositions c
         JOIN frames f ON f.id=c.frame_id AND f.event_id=c.event_id LEFT JOIN guest_sessions s ON s.id=c.session_id AND s.event_id=c.event_id WHERE c.id=$1`, [j.composition_id])).rows[0];
    return {
      job: {
        id: j.id, copies: j.copies, attempt: j.attempt, widthPx: d.width_px, heightPx: d.height_px, format: d.output_format,
        orientation: p.orientation === "auto" ? d.orientation : p.orientation, paperSize: p.paper_size === "any" ? d.output_format : p.paper_size,
        sha256: d.sha256, bytes: Number(d.bytes), guestCode: d.guest_code, imageUrl: `/api/v1/agent/jobs/${j.id}/image`,
      },
    };
  });

  /** A job this device may touch: it was claimed by one of THIS device's printers. */
  async function ownJob(dev: Device, jobId: string) {
    if (!UUID.test(jobId)) return null;
    return (await pool.query(
      `SELECT j.id,j.status,j.composition_id,j.printer_id FROM print_jobs j JOIN printers p ON p.id=j.printer_id
        WHERE j.id=$1 AND j.event_id=$2 AND p.device_id=$3`, [jobId, dev.event_id, dev.id])).rows[0] as { id: string; status: string; composition_id: string; printer_id: string } | null;
  }

  app.get("/api/v1/agent/jobs/:jobId/image", { preHandler: requireDevice, ...limit }, async (req, reply) => {
    const j = await ownJob(req.device!, (req.params as any).jobId);
    if (!j || j.status !== "printing") return reply.code(404).send({ error: "not_found" });
    const c = (await pool.query("SELECT storage_key,mime,sha256 FROM final_compositions WHERE id=$1 AND deleted_at IS NULL", [j.composition_id])).rows[0];
    if (!c) return reply.code(404).send({ error: "not_found" });
    reply.header("X-Content-Sha256", c.sha256);
    return reply.type(c.mime).send(await getFile(c.storage_key));
  });

  // Tells the server the printer is still working on a long job, so it is not put back in the queue.
  app.post("/api/v1/agent/jobs/:jobId/progress", { preHandler: requireDevice, ...limit }, async (req, reply) => {
    const j = await ownJob(req.device!, (req.params as any).jobId);
    if (!j) return reply.code(404).send({ error: "not_found" });
    await pool.query("UPDATE print_jobs SET started_at=now() WHERE id=$1 AND status='printing'", [j.id]);
    return { ok: true };
  });

  app.post("/api/v1/agent/jobs/:jobId/result", { preHandler: requireDevice, ...limit }, async (req, reply) => {
    const dev = req.device!;
    const b = z.object({ ok: z.boolean(), error: z.string().trim().max(500).nullish(), copiesPrinted: z.number().int().min(0).max(50).nullish() }).parse(req.body);
    const j = await ownJob(dev, (req.params as any).jobId);
    if (!j) return reply.code(404).send({ error: "not_found" });
    const note = b.ok ? "Printed" : (b.error ?? "Print failed");
    // Repeating a report is harmless: the agent retries until it hears back.
    if ((j.status === "printed" && b.ok) || (j.status === "failed" && !b.ok)) return { ok: true, duplicate: true, status: j.status };
    if (j.status === "approved") {
      // The server already put the job back in the queue (the agent took too long). If the agent in fact printed it, record that, or it would print twice.
      if (!b.ok) return { ok: true, ignored: true, status: j.status };
      await withTx(pool, async (tx) => {
        await transition(tx, dev.event_id, j.id, "printing", { printerId: j.printer_id, note: "Late report from the printer agent" });
        await transition(tx, dev.event_id, j.id, "printed", { note });
      });
      return { ok: true, late: true, status: "printed" };
    }
    if (j.status !== "printing") return reply.code(409).send({ error: "invalid_state", status: j.status });
    await reportResult(pool, dev.event_id, j.id, b.ok, b.ok ? undefined : note);
    return { ok: true, status: b.ok ? "printed" : "failed" };
  });

  /* ------------------------- Admin: devices and printers ------------------------- */
  const view = requirePermission(pool, "print:operate", { eventParam: "eventId" });
  const manage = requirePermission(pool, "builder:edit", { eventParam: "eventId" });

  const deviceView = (d: any, printers: any[]) => ({
    id: d.id, name: d.name, enabled: d.enabled, paired: !!d.paired_at, pairedAt: d.paired_at, version: d.version, hostName: d.host_name, lastSeenAt: d.last_seen_at,
    online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < AGENT_ONLINE_SECONDS * 1000,
    pairingExpiresAt: d.pairing_hash && new Date(d.pairing_expires_at) > new Date() ? d.pairing_expires_at : null,
    printers: printers.filter((p) => p.device_id === d.id).map((p) => ({
      id: p.id, name: p.windows_name, label: p.name, enabled: p.enabled, status: p.status, detail: p.detail, paperSize: p.paper_size, orientation: p.orientation,
      driverPapers: p.driver_papers, lastSeenAt: p.last_seen_at,
    })),
  });
  /** Used by the operator dashboard: who is connected and which printers are ready. */
  app.get("/api/v1/events/:eventId/agents", { preHandler: view }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const devs = (await pool.query("SELECT * FROM devices WHERE event_id=$1 AND kind='print_agent' ORDER BY created_at", [eventId])).rows;
    const printers = (await pool.query("SELECT * FROM printers WHERE event_id=$1 AND device_id IS NOT NULL ORDER BY windows_name", [eventId])).rows;
    return { agents: devs.map((d) => deviceView(d, printers)), minAgentVersion: MIN_AGENT_VERSION };
  });

  async function issueCode(deviceId: string) {
    const code = newPairingCode();
    await pool.query("UPDATE devices SET pairing_hash=$2, pairing_expires_at=now() + make_interval(mins => $3) WHERE id=$1", [deviceId, sha(code), PAIRING_MINUTES]);
    return { pairingCode: pretty(code), expiresInMinutes: PAIRING_MINUTES };
  }
  app.post("/api/v1/events/:eventId/agents", { preHandler: manage }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    if ((await pool.query("SELECT count(*)::int c FROM devices WHERE event_id=$1 AND kind='print_agent'", [eventId])).rows[0].c >= 25) return reply.code(409).send({ error: "too_many_agents" });
    const id = (await pool.query("INSERT INTO devices(event_id,kind,name,token_hash) VALUES ($1,'print_agent',$2,$3) RETURNING id", [eventId, name, sha(randomBytes(32).toString("hex"))])).rows[0].id;
    await audit(pool, req.user!.id, "agent_create", { eventId, entity: "device", entityId: id, detail: { name }, ip: req.ip });
    return reply.code(201).send({ deviceId: id, ...(await issueCode(id)) });
  });
  app.post("/api/v1/events/:eventId/agents/:deviceId/pairing", { preHandler: manage }, async (req, reply) => {
    const { eventId, deviceId } = req.params as { eventId: string; deviceId: string };
    if (!UUID.test(deviceId) || !(await pool.query("SELECT 1 FROM devices WHERE id=$1 AND event_id=$2 AND kind='print_agent'", [deviceId, eventId])).rowCount) return reply.code(404).send({ error: "not_found" });
    // Re-pairing invalidates the old credential straight away: a lost or copied computer stops printing.
    await pool.query("UPDATE devices SET token_hash=$2, paired_at=NULL WHERE id=$1", [deviceId, sha(randomBytes(32).toString("hex"))]);
    await audit(pool, req.user!.id, "agent_repair", { eventId, entity: "device", entityId: deviceId, ip: req.ip });
    return reply.send({ deviceId, ...(await issueCode(deviceId)) });
  });
  app.patch("/api/v1/events/:eventId/agents/:deviceId", { preHandler: manage }, async (req, reply) => {
    const { eventId, deviceId } = req.params as { eventId: string; deviceId: string };
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional() }).parse(req.body);
    if (!UUID.test(deviceId)) return reply.code(404).send({ error: "not_found" });
    const r = await pool.query("UPDATE devices SET name=COALESCE($3,name), enabled=COALESCE($4,enabled) WHERE id=$1 AND event_id=$2 AND kind='print_agent'", [deviceId, eventId, b.name ?? null, b.enabled ?? null]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, "agent_update", { eventId, entity: "device", entityId: deviceId, detail: b as object, ip: req.ip });
    return { ok: true };
  });
  app.delete("/api/v1/events/:eventId/agents/:deviceId", { preHandler: manage }, async (req, reply) => {
    const { eventId, deviceId } = req.params as { eventId: string; deviceId: string };
    if (!UUID.test(deviceId)) return reply.code(404).send({ error: "not_found" });
    const res = await withTx(pool, async (tx) => {
      if (!(await tx.query("SELECT 1 FROM devices WHERE id=$1 AND event_id=$2 AND kind='print_agent'", [deviceId, eventId])).rowCount) return false;
      await tx.query("UPDATE print_jobs SET printer_id=NULL WHERE printer_id IN (SELECT id FROM printers WHERE device_id=$1)", [deviceId]);   // keep the history, drop the link
      await tx.query("DELETE FROM printers WHERE device_id=$1", [deviceId]);
      await tx.query("DELETE FROM devices WHERE id=$1", [deviceId]);
      return true;
    });
    if (!res) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, "agent_delete", { eventId, entity: "device", entityId: deviceId, ip: req.ip });
    return { ok: true };
  });
  app.patch("/api/v1/events/:eventId/printers/:printerId", { preHandler: manage }, async (req, reply) => {
    const { eventId, printerId } = req.params as { eventId: string; printerId: string };
    const b = z.object({ enabled: z.boolean().optional(), paperSize: z.enum(PAPER_KEYS).optional(), orientation: z.enum(["auto", "portrait", "landscape"]).optional(), label: z.string().trim().min(1).max(120).optional() }).parse(req.body);
    if (!UUID.test(printerId)) return reply.code(404).send({ error: "not_found" });
    const cur = (await pool.query("SELECT paper_size FROM printers WHERE id=$1 AND event_id=$2", [printerId, eventId])).rows[0];
    if (!cur) return reply.code(404).send({ error: "not_found" });
    const paper = b.paperSize ?? cur.paper_size;
    if (b.enabled && paper === "any") return reply.code(400).send({ error: "paper_size_required" });      // never send photos to a printer whose paper is unknown
    await pool.query("UPDATE printers SET enabled=COALESCE($3,enabled), paper_size=$4, orientation=COALESCE($5,orientation), name=COALESCE($6,name) WHERE id=$1 AND event_id=$2",
      [printerId, eventId, b.enabled ?? null, paper, b.orientation ?? null, b.label ?? null]);
    await audit(pool, req.user!.id, "printer_update", { eventId, entity: "printer", entityId: printerId, detail: b as object, ip: req.ip });
    return { ok: true };
  });
  void PrintError;
}
