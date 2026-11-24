import type { FastifyInstance } from "fastify";
import type { Pool } from "../db";
import { requireUser } from "../auth";

/** Dashboard totals. Scoped to the events the user may see; real counts only (zeros when empty). */
export async function dashboardRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/api/v1/dashboard/overview", { preHandler: requireUser(pool) }, async (req) => {
    const u = req.user!;
    const isSuper = u.globalRole === "super_admin";
    const ids = isSuper ? null : Object.keys(u.eventRoles);
    // $1 = null means "all events"; otherwise restrict to the user's events.
    const scope = ids;
    const q = async (sql: string) => (await pool.query(sql, [scope])).rows[0];
    const ev = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE status='active')::int active
                          FROM events WHERE status<>'archived' AND ($1::uuid[] IS NULL OR id = ANY($1))`);
    const photos = await q(`SELECT count(*)::int submissions,
                               count(*) FILTER (WHERE moderation='pending')::int pending,
                               count(*) FILTER (WHERE moderation='approved')::int approved
                          FROM final_compositions WHERE deleted_at IS NULL AND ($1::uuid[] IS NULL OR event_id = ANY($1))`);
    const prints = await q(`SELECT count(*) FILTER (WHERE status='printed')::int printed,
                               count(*) FILTER (WHERE status='failed')::int failed
                          FROM print_jobs WHERE ($1::uuid[] IS NULL OR event_id = ANY($1))`);
    const shares = await q(`SELECT count(*) FILTER (WHERE channel='download')::int downloads,
                               count(*) FILTER (WHERE channel<>'download')::int share_attempts
                          FROM share_events WHERE ($1::uuid[] IS NULL OR event_id = ANY($1))`);
    const dev = await q(`SELECT count(*) FILTER (WHERE last_seen_at > now() - interval '2 minutes')::int active_devices,
                               count(*)::int total_devices
                          FROM devices WHERE enabled AND ($1::uuid[] IS NULL OR event_id = ANY($1))`);
    return {
      totalEvents: ev.total, activeEvents: ev.active,
      totalSubmissions: photos.submissions, photosPending: photos.pending, photosApproved: photos.approved,
      photosPrinted: prints.printed, failedPrints: prints.failed,
      totalDownloads: shares.downloads, shareAttempts: shares.share_attempts,
      activeDevices: dev.active_devices, totalDevices: dev.total_devices,
    };
  });
}
