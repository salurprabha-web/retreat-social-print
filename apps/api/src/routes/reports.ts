import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DAILY_COLUMNS, FRAME_COLUMNS, OPERATOR_COLUMNS, PRINTER_COLUMNS, REPORT_NAMES, SUBMISSION_COLUMNS, SUMMARY_COLUMNS, TOTAL_LABELS, toCsv,
  type ReportName,
} from "@rsp/shared";
import type { Pool } from "../db";
import { audit } from "../audit";
import { can, requirePermission, requireUser } from "../auth";
import { ReportError, activity, daily, eventsOverview, frames, operators, printers, resolveBounds, submissions, summary, type Bounds } from "../reports";
import { eventReportPdf } from "../reportPdf";

export async function reportRoutes(app: FastifyInstance, pool: Pool) {
  const view = requirePermission(pool, "report:view", { eventParam: "eventId" });
  const bounds = (req: FastifyRequest): Promise<Bounds> => resolveBounds(pool, req.query as any);

  for (const name of ["summary", "daily", "frames", "operators", "printers"] as const) {
    const fn = { summary, daily, frames, operators, printers }[name];
    app.get(`/api/v1/events/:eventId/reports/${name}`, { preHandler: view }, async (req) => fn(pool, (req.params as any).eventId, await bounds(req)));
  }

  async function csvOf(eventId: string, name: ReportName, b: Bounds): Promise<{ csv: string; truncated?: boolean }> {
    switch (name) {
      case "summary": {
        const s = await summary(pool, eventId, b);
        const rows = [...TOTAL_LABELS.map(([k, label]) => ({ metric: label, value: s.totals[k] })), ...s.funnel.map((f) => ({ metric: `Guest journey: ${f.label}`, value: f.count })), ...s.qr.map((q) => ({ metric: `QR code scans: ${q.label ?? q.code}`, value: q.scans }))];
        return { csv: toCsv(SUMMARY_COLUMNS, rows) };
      }
      case "daily": return { csv: toCsv(DAILY_COLUMNS, (await daily(pool, eventId, b)).rows) };
      case "frames": return { csv: toCsv(FRAME_COLUMNS, (await frames(pool, eventId, b)).rows) };
      case "operators": return { csv: toCsv(OPERATOR_COLUMNS, (await operators(pool, eventId, b)).rows) };
      case "printers": return { csv: toCsv(PRINTER_COLUMNS, (await printers(pool, eventId, b)).rows) };
      case "submissions": { const s = await submissions(pool, eventId, b); return { csv: toCsv(SUBMISSION_COLUMNS, s.rows), truncated: s.truncated }; }
    }
  }

  app.get("/api/v1/events/:eventId/reports/:name/csv", { preHandler: view }, async (req, reply) => {
    const { eventId, name } = req.params as { eventId: string; name: string };
    if (!(REPORT_NAMES as readonly string[]).includes(name)) return reply.code(404).send({ error: "not_found" });
    const b = await bounds(req);
    const out = await csvOf(eventId, name as ReportName, b);
    await audit(pool, req.user!.id, "report_export", { eventId, entity: "report", detail: { report: name, format: "csv", from: b.range.from, to: b.range.to }, ip: req.ip });
    reply.header("Content-Disposition", `attachment; filename="event-${eventId.slice(0, 8)}-${name}.csv"`);
    if (out.truncated) reply.header("X-Report-Truncated", "true");
    return reply.type("text/csv; charset=utf-8").send(out.csv);
  });

  app.get("/api/v1/events/:eventId/reports/pdf", { preHandler: view }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const b = await bounds(req);
    const ev = (await pool.query("SELECT name,hashtag FROM events WHERE id=$1", [eventId])).rows[0];
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const [s, d, f, o, p] = await Promise.all([summary(pool, eventId, b), daily(pool, eventId, b), frames(pool, eventId, b), operators(pool, eventId, b), printers(pool, eventId, b)]);
    const pdf = await eventReportPdf({ eventName: ev.name, hashtag: ev.hashtag, summary: s, daily: d, frames: f, operators: o, printers: p });
    await audit(pool, req.user!.id, "report_export", { eventId, entity: "report", detail: { report: "event", format: "pdf", from: b.range.from, to: b.range.to }, ip: req.ip });
    reply.header("Content-Disposition", `attachment; filename="event-${eventId.slice(0, 8)}-report.pdf"`);
    return reply.type("application/pdf").send(pdf);
  });

  // ----- Across events: what the signed-in person may see -----
  const visibleEvents = (u: NonNullable<FastifyRequest["user"]>, perm: "report:view" | "event:view"): string[] | null =>
    u.globalRole === "super_admin" ? null : Object.keys(u.eventRoles).filter((id) => can(u, perm, id));

  app.get("/api/v1/reports/events", { preHandler: requireUser(pool) }, async (req) => {
    const ids = visibleEvents(req.user!, "report:view");
    const b = await bounds(req);
    return { range: b.range, events: ids && !ids.length ? [] : await eventsOverview(pool, ids, b) };
  });

  app.get("/api/v1/dashboard/activity", { preHandler: requireUser(pool) }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(14), tz: z.string().max(64).default("UTC") }).parse(req.query);
    if (!(await pool.query("SELECT 1 FROM pg_timezone_names WHERE name=$1", [q.tz])).rowCount) throw new ReportError("bad_timezone");
    const ids = visibleEvents(req.user!, "event:view");
    return { days: ids && !ids.length ? [] : await activity(pool, ids, q.days, q.tz) };
  });
  void (null as unknown as FastifyReply);
}
