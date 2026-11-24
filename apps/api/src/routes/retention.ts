import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Pool } from "../db";
import { audit } from "../audit";
import { requirePermission } from "../auth";
import { RetentionError, purgeEvent, retentionStatus } from "../retention";
import { countPending } from "../syncService";

export async function retentionRoutes(app: FastifyInstance, pool: Pool) {
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });
  const edit = requirePermission(pool, "event:edit", { eventParam: "eventId" });
  const destroy = requirePermission(pool, "event:delete", { eventParam: "eventId" });      // irreversible: super administrator only

  app.get("/api/v1/events/:eventId/retention", { preHandler: view }, async (req, reply) => {
    const s = await retentionStatus(pool, (req.params as any).eventId);
    return s ?? reply.code(404).send({ error: "not_found" });
  });

  app.put("/api/v1/events/:eventId/retention", { preHandler: edit }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const { hold } = z.object({ hold: z.boolean() }).parse(req.body);
    const r = await pool.query("UPDATE events SET retention_hold=$2, updated_at=now() WHERE id=$1 AND purged_at IS NULL", [eventId, hold]);
    if (!r.rowCount) return reply.code(409).send({ error: "already_purged" });
    await audit(pool, req.user!.id, hold ? "retention_hold_on" : "retention_hold_off", { eventId, entity: "event", entityId: eventId, ip: req.ip });
    return retentionStatus(pool, eventId);
  });

  /** Deletes the guest data of an ARCHIVED event now, instead of waiting for the retention period. Typed confirmation required. */
  app.post("/api/v1/events/:eventId/retention/purge", { preHandler: destroy }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
    const e = (await pool.query("SELECT name FROM events WHERE id=$1", [eventId])).rows[0];
    if (!e) return reply.code(404).send({ error: "not_found" });
    if (e.name !== confirmName) return reply.code(400).send({ error: "confirmation_mismatch" });
    const safe = app.rspMode === "local" && app.rspSync ? async (id: string) => (await countPending(pool, id)) === 0 : undefined;
    try { return await purgeEvent(pool, eventId, { userId: req.user!.id, reason: "manual", ip: req.ip, safe }); }
    catch (e: any) { if (e instanceof RetentionError) return reply.code(e.status).send({ error: e.code }); throw e; }
  });
}
