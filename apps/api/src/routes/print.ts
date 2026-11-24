import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MAX_COPIES, PRINT_MODES, PRINT_STATUSES, REPRINTABLE } from "@rsp/shared";
import type { Pool } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { PrintError, applyAction, printBus, notifyPrint, reprint, setCopies, setPaused, type StaffAction } from "../printService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function printRoutes(app: FastifyInstance, pool: Pool) {
  const operate = requirePermission(pool, "print:operate", { eventParam: "eventId" });

  async function queueState(eventId: string) {
    const s = (await pool.query("SELECT print_mode,print_paused,default_copies FROM event_settings WHERE event_id=$1", [eventId])).rows[0];
    return { mode: s?.print_mode ?? "manual", paused: !!s?.print_paused, defaultCopies: s?.default_copies ?? 1 };
  }

  app.get("/api/v1/events/:eventId/print/jobs", { preHandler: operate }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const q = z.object({
      status: z.string().optional().transform((s) => (s ? s.split(",") : null)).refine((a) => !a || a.every((x) => (PRINT_STATUSES as readonly string[]).includes(x))),
      limit: z.coerce.number().int().min(1).max(300).default(120),
    }).parse(req.query);
    const rows = (await pool.query(
      `SELECT j.id,j.status,j.kind,j.copies,j.attempt,j.error,j.note,j.created_at,j.approved_at,j.started_at,j.finished_at,
              c.id AS cid,c.width_px,c.height_px,c.moderation,c.created_at AS c_created,s.guest_code,f.name AS frame_name,
              (SELECT COALESCE(json_agg(cp.upload_id ORDER BY cp.slot),'[]'::json) FROM composition_photos cp WHERE cp.composition_id=c.id) AS uploads
         FROM print_jobs j JOIN final_compositions c ON c.id=j.composition_id AND c.event_id=j.event_id
         LEFT JOIN guest_sessions s ON s.id=c.session_id AND s.event_id=c.event_id
         JOIN frames f ON f.id=c.frame_id AND f.event_id=c.event_id
        WHERE j.event_id=$1 AND ($2::text[] IS NULL OR j.status = ANY($2)) ORDER BY j.created_at DESC LIMIT $3`, [eventId, q.status, q.limit])).rows;
    const cnt = (await pool.query("SELECT status,count(*)::int n FROM print_jobs WHERE event_id=$1 GROUP BY status", [eventId])).rows;
    const counts = Object.fromEntries(PRINT_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of cnt) counts[r.status] = r.n;
    const devs = (await pool.query("SELECT id,name,last_seen_at,paired_at,enabled FROM devices WHERE event_id=$1 AND kind='print_agent' ORDER BY created_at", [eventId])).rows;
    const prs = (await pool.query("SELECT device_id,windows_name,enabled,status,detail,paper_size FROM printers WHERE event_id=$1 AND device_id IS NOT NULL ORDER BY windows_name", [eventId])).rows;
    const agents = devs.map((d) => ({
      id: d.id, name: d.name, paired: !!d.paired_at, enabled: d.enabled,
      online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 45_000,
      printers: prs.filter((p) => p.device_id === d.id).map((p) => ({ name: p.windows_name, enabled: p.enabled, status: p.status, detail: p.detail, paperSize: p.paper_size })),
    }));
    return {
      queue: await queueState(eventId), counts, serverTime: new Date().toISOString(), agents,
      jobs: rows.map((r) => ({
        id: r.id, status: r.status, kind: r.kind, copies: r.copies, attempt: r.attempt, error: r.error, note: r.note,
        createdAt: r.created_at, approvedAt: r.approved_at, startedAt: r.started_at, finishedAt: r.finished_at,
        composition: { id: r.cid, guestCode: r.guest_code, frameName: r.frame_name, widthPx: r.width_px, heightPx: r.height_px, moderation: r.moderation, createdAt: r.c_created, uploadIds: r.uploads },
      })),
    };
  });

  const actionSchema = z.object({
    action: z.enum(["approve", "reject", "cancel", "hold", "retry", "reprint", "copies"]),
    note: z.string().trim().max(300).optional(), copies: z.number().int().min(1).max(MAX_COPIES).optional(),
    requestId: z.string().uuid().optional(), approveNow: z.boolean().default(true),
  });
  app.post("/api/v1/events/:eventId/print/jobs/:jobId/action", { preHandler: operate }, async (req, reply) => {
    const { eventId, jobId } = req.params as { eventId: string; jobId: string };
    if (!UUID.test(jobId)) return reply.code(404).send({ error: "not_found" });
    const b = actionSchema.parse(req.body); const userId = req.user!.id;
    if (b.action === "copies") {
      if (!b.copies) return reply.code(400).send({ error: "bad_copies" });
      await setCopies(pool, eventId, jobId, b.copies, userId);
      await audit(pool, userId, "print_copies", { eventId, entity: "print_job", entityId: jobId, detail: { copies: b.copies }, ip: req.ip });
      return { ok: true };
    }
    if (b.action === "reprint") {
      const j = (await pool.query("SELECT composition_id,status FROM print_jobs WHERE id=$1 AND event_id=$2", [jobId, eventId])).rows[0];
      if (!j) return reply.code(404).send({ error: "not_found" });
      if (!(REPRINTABLE as readonly string[]).includes(j.status)) return reply.code(409).send({ error: "invalid_state", status: j.status });
      if (!b.requestId) return reply.code(400).send({ error: "request_id_required" });
      const r = await reprint(pool, eventId, j.composition_id, userId, { requestId: b.requestId, copies: b.copies, approveNow: b.approveNow });
      await audit(pool, userId, "print_reprint", { eventId, entity: "print_job", entityId: r.job.id, detail: { from: jobId, created: r.created, approveNow: b.approveNow }, ip: req.ip });
      return reply.code(r.created ? 201 : 200).send({ job: r.job, created: r.created });
    }
    await applyAction(pool, eventId, jobId, b.action as StaffAction, userId, b.note);
    await audit(pool, userId, `print_${b.action}`, { eventId, entity: "print_job", entityId: jobId, detail: { note: b.note ?? null }, ip: req.ip });
    return { ok: true };
  });

  // Bulk: each job is handled on its own, so one that cannot move (for example already printing) never blocks the rest.
  app.post("/api/v1/events/:eventId/print/jobs/bulk", { preHandler: operate }, async (req) => {
    const eventId = (req.params as any).eventId as string; const userId = req.user!.id;
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(200), action: z.enum(["approve", "cancel", "hold", "retry"]), note: z.string().trim().max(300).optional() }).parse(req.body);
    const done: string[] = []; const skipped: { id: string; reason: string }[] = [];
    for (const id of [...new Set(b.ids)]) {
      try { await applyAction(pool, eventId, id, b.action, userId, b.note); done.push(id); }
      catch (e) { if (e instanceof PrintError) skipped.push({ id, reason: e.code }); else throw e; }
    }
    await audit(pool, userId, `print_bulk_${b.action}`, { eventId, entity: "print_job", detail: { done: done.length, skipped: skipped.length }, ip: req.ip });
    return { done, skipped };
  });

  app.post("/api/v1/events/:eventId/print/queue", { preHandler: operate }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await setPaused(pool, eventId, paused, req.user!.id);
    return { queue: await queueState(eventId) };
  });

  app.post("/api/v1/events/:eventId/print/mode", { preHandler: operate }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const { mode } = z.object({ mode: z.enum(PRINT_MODES) }).parse(req.body);
    const before = (await queueState(eventId)).mode;
    await pool.query("UPDATE event_settings SET print_mode=$2, updated_at=now() WHERE event_id=$1", [eventId, mode]);
    await audit(pool, req.user!.id, "print_mode", { eventId, detail: { from: before, to: mode }, ip: req.ip });
    notifyPrint(eventId);
    return { queue: await queueState(eventId) };   // existing jobs are not touched: only pictures finished from now on follow the new mode
  });

  app.get("/api/v1/events/:eventId/print/history", { preHandler: operate }, async (req) => {
    const eventId = (req.params as any).eventId as string;
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse((req.query as any).limit);
    const rows = (await pool.query(
      `SELECT e.id,e.at,e.from_status,e.to_status,e.note,u.name AS who,j.id AS job_id,j.kind,s.guest_code
         FROM print_job_events e JOIN print_jobs j ON j.id=e.job_id AND j.event_id=e.event_id
         JOIN final_compositions c ON c.id=j.composition_id AND c.event_id=j.event_id
         LEFT JOIN guest_sessions s ON s.id=c.session_id AND s.event_id=c.event_id
         LEFT JOIN users u ON u.id=e.user_id WHERE e.event_id=$1 ORDER BY e.at DESC, e.id DESC LIMIT $2`, [eventId, limit])).rows;
    const queueEvents = (await pool.query(
      `SELECT a.at,a.action,a.detail,u.name AS who FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
        WHERE a.event_id=$1 AND a.action IN ('print_pause','print_resume','print_mode') ORDER BY a.at DESC LIMIT 50`, [eventId])).rows;
    return {
      history: rows.map((r) => ({ id: Number(r.id), at: r.at, from: r.from_status, to: r.to_status, note: r.note, by: r.who ?? (["printing", "printed", "failed"].includes(r.to_status) ? "Printer" : "System"), jobId: r.job_id, kind: r.kind, guestCode: r.guest_code })),
      queueEvents: queueEvents.map((r) => ({ at: r.at, action: r.action, by: r.who, detail: r.detail })),
    };
  });

  // Live updates for the operator screen (Server-Sent Events). The screen also re-checks every few seconds, so a dropped stream never leaves it stale.
  app.get("/api/v1/events/:eventId/print/stream", { preHandler: operate }, (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    res.write("retry: 3000\n\nevent: hello\ndata: {}\n\n");
    const tick = () => res.write("event: tick\ndata: {}\n\n");
    printBus.on(eventId, tick);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    const done = () => { clearInterval(ping); printBus.off(eventId, tick); };
    req.raw.on("close", done); res.on("error", done);
  });
  void notifyPrint;
}
