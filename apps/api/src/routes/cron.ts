import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual, createHash } from "node:crypto";
import type { Pool } from "../db";
import { config } from "../config";
import { tagAuth } from "../auth";
import { requeueAllStale } from "../printService";
import { runRetention } from "../retention";
import { purgeRateLimits } from "../rateLimitStore";

/**
 * Scheduled jobs for hosts that have no long-running process (Vercel Cron calls these paths on a schedule and sends
 * `Authorization: Bearer <CRON_SECRET>`). On a server that does keep running, the same work is done by timers in index.ts and these
 * routes are simply switched off (no CRON_SECRET set => 503).
 * Every job is safe to run as often as wanted and safe to run twice at once.
 */
const sha = (s: string) => createHash("sha256").update(s).digest();

export async function cronRoutes(app: FastifyInstance, pool: Pool) {
  const auth = tagAuth(async (req: FastifyRequest, reply: FastifyReply) => {
    const secret = config.cronSecret;
    if (secret.length < 32) return reply.code(503).send({ error: "cron_not_configured" });
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
    // compare hashes so the comparison time never depends on how much of the secret was right
    if (!m || !timingSafeEqual(sha(m[1]), sha(secret))) return reply.code(401).send({ error: "invalid_credential" });
  }, { kind: "cron" });

  /** Print jobs stuck in "printing" (agent crashed or lost connection) go back to the queue. Run every minute. */
  app.get("/api/v1/cron/print-requeue", { preHandler: auth }, async () => ({ ok: true, requeued: await requeueAllStale(pool, config.printStaleSeconds) }));

  /** Archived events lose their guest data when their retention period ends. Run hourly. */
  app.get("/api/v1/cron/retention", { preHandler: auth }, async () => {
    const r = await runRetention(pool);
    return { ok: true, purged: r.purged.length, skipped: r.skipped.length };
  });

  /** Housekeeping: old rate-limit counters. Run hourly. */
  app.get("/api/v1/cron/maintenance", { preHandler: auth }, async () => ({ ok: true, rateLimitsRemoved: await purgeRateLimits(pool) }));
}
