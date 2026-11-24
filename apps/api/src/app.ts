import Fastify, { type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { loginSchema } from "@rsp/shared";
import { config } from "./config";
import type { Pool } from "./db";
import { audit } from "./audit";
import {
  COOKIE_NAME, LOCK_MINUTES, MAX_FAILED_LOGINS, createSession, destroySession, loadUser, requirePermission, requireUser, verifyPassword,
} from "./auth";
import { dashboardRoutes } from "./routes/dashboard";
import { eventRoutes } from "./routes/events";
import { guestPageRoutes } from "./routes/guestPage";
import { guestFlowRoutes } from "./routes/guestFlow";
import { frameRoutes } from "./routes/frames";
import { qrRoutes } from "./routes/qr";
import { photoRoutes } from "./routes/photos";
import { printRoutes } from "./routes/print";
import { agentRoutes } from "./routes/agents";
import { wallRoutes } from "./routes/wall";
import { sponsorRoutes } from "./routes/sponsors";
import { mosaicRoutes } from "./routes/mosaic";
import { syncRoutes } from "./routes/sync";
import { reportRoutes } from "./routes/reports";
import { userRoutes } from "./routes/users";
import { retentionRoutes } from "./routes/retention";
import { ReportError } from "./reports";
import { storageContext } from "./storage";
import type { SyncConfig } from "./syncService";
import { buildOpenApi, type RouteInfo } from "./openapi";
import { PrintError } from "./printService";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PARAMS = ["eventId", "cid", "id", "qrId", "frameId", "jobId", "deviceId", "uploadId", "uid", "targetId", "printerId"] as const;
export type RspMode = "cloud" | "local";
declare module "fastify" { interface FastifyInstance { rspMode: RspMode; rspStorageDir: string | null; rspSync: SyncConfig | null; rspRoutes: RouteInfo[] } }

/** `storageDir` and `mode` let one process host several servers (offline-mode tests); normally both come from the environment. */
export async function buildApp(pool: Pool, opts: { storageDir?: string; mode?: RspMode; sync?: SyncConfig | null; logger?: boolean } = {}) {
  // Request logs never carry credentials: cookies, tokens and guest session headers are redacted, and addresses that ARE credentials
  // (guest, wall and mosaic links, signed photo links) are masked, query strings dropped.
  const mask = (u: string) => u.split("?")[0].replace(/\/(g|w|m)\/[0-9a-f]{24}/g, "/$1/:token").replace(/\/public\/c\/[0-9a-f-]{36}/g, "/public/c/:id").replace(/\/q\/[A-Za-z0-9]{4,}/g, "/q/:code");
  const logger: FastifyServerOptions["logger"] = opts.logger
    ? { level: config.logLevel === "silent" ? "info" : config.logLevel, redact: ["req.headers.cookie", "req.headers.authorization", 'req.headers["x-guest-session"]', 'req.headers["x-rsp-csrf"]', 'req.headers["x-sha256"]'],
        serializers: { req: (r: any) => ({ method: r.method, url: mask(r.url), remoteAddress: r.ip ?? r.socket?.remoteAddress }) } }
    : false;
  const app = Fastify({ logger, trustProxy: config.trustProxy as FastifyServerOptions["trustProxy"], forceCloseConnections: true, bodyLimit: 256 * 1024 });
  app.decorate("rspMode", opts.mode ?? config.mode);
  app.decorate("rspStorageDir", opts.storageDir ?? null);
  // Route registry: every route with how it is protected. Feeds the generated API document and the automated security tests.
  app.decorate("rspRoutes", [] as RouteInfo[]);
  // A malformed identifier in the address is simply "not found": it must never reach the database (where it would become a 500).
  app.addHook("onRequest", async (req, reply) => {
    const p = req.params as Record<string, string> | undefined;
    if (p) for (const n of UUID_PARAMS) if (p[n] !== undefined && !UUID_RE.test(p[n])) return reply.code(404).send({ error: "not_found" });
  });
  app.addHook("onRoute", (r) => {
    const pre = [r.preHandler, r.onRequest].flat().filter(Boolean) as unknown as { rspAuth?: RouteInfo["auth"] }[];
    const auth = pre.map((f) => f.rspAuth).find(Boolean) ?? null;
    for (const m of ([] as string[]).concat(r.method as any)) if (m !== "HEAD" && m !== "OPTIONS") app.rspRoutes.push({ method: m, url: r.url, auth, rateLimited: !!(r.config as any)?.rateLimit });
  });
  app.decorate("rspSync", opts.sync !== undefined ? opts.sync : (config.cloudUrl && config.syncTokens.length ? { cloudUrl: config.cloudUrl, tokens: config.syncTokens } : null));
  if (opts.storageDir) app.addHook("onRequest", (_req, _reply, done) => { storageContext.run({ root: opts.storageDir! }, done); });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: () => config.globalRateLimitPerMin, timeWindow: "1 minute" });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");   // routes that opt in to caching (wall images) keep theirs
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation", issues: err.issues });
    if (err instanceof ReportError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof PrintError) return reply.code(err.statusCode).send({ error: err.code, ...err.extra });   // expected refusals from the print queue
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    // A stored file that is not on the disk (lost volume, wrong STORAGE_DIR) is reported as exactly that, and logged, not as a mystery 500.
    if (err.code === "ENOENT") { app.log.warn({ path: String(err.path ?? "").split(/[\\/]events[\\/]/)[1] ?? "?" }, "stored file missing"); return reply.code(404).send({ error: "file_missing" }); }
    console.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  app.get("/api/v1/health", async () => { await pool.query("SELECT 1"); return { ok: true }; });

  app.post("/api/v1/auth/login",
    { config: { rateLimit: { max: () => config.loginRateLimitPerMin, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { email, password } = loginSchema.parse(req.body);
      const { rows } = await pool.query(
        "SELECT id,password_hash,active,locked_until FROM users WHERE lower(email)=lower($1)", [email]);
      const u = rows[0];
      if (u?.locked_until && new Date(u.locked_until) > new Date()) {
        return reply.code(429).send({ error: "account_locked" });
      }
      const ok = await verifyPassword(u?.password_hash ?? null, password);
      if (!u || !u.active || !ok) {
        if (u) {
          await pool.query(
            `UPDATE users SET failed_logins=failed_logins+1,
               locked_until = CASE WHEN failed_logins+1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
             WHERE id=$1`, [u.id, MAX_FAILED_LOGINS, LOCK_MINUTES]);
        }
        await audit(pool, u?.id, "login_failed", { detail: { email }, ip: req.ip });
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      await pool.query("UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [u.id]);
      const s = await createSession(pool, u.id, config.sessionTtlHours);
      reply.setCookie(COOKIE_NAME, s.token, {
        httpOnly: true, sameSite: "strict", secure: config.cookieSecure, path: "/", expires: s.expires,
      });
      await audit(pool, u.id, "login", { ip: req.ip });
      const me = await loadUser(pool, s.token);
      return { user: { id: me!.id, email: me!.email, name: me!.name, globalRole: me!.globalRole, eventRoles: me!.eventRoles }, csrf: s.csrf };
    });

  app.post("/api/v1/auth/logout", { preHandler: requireUser(pool) }, async (req, reply) => {
    await destroySession(pool, req.cookies[COOKIE_NAME]!);
    await audit(pool, req.user!.id, "logout", { ip: req.ip });
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/auth/me", { preHandler: requireUser(pool) }, async (req) => {
    const u = await loadUser(pool, req.cookies[COOKIE_NAME]!);
    return { user: { id: u!.id, email: u!.email, name: u!.name, globalRole: u!.globalRole, eventRoles: u!.eventRoles }, csrf: u!.csrf };
  });

  await dashboardRoutes(app, pool);
  await eventRoutes(app, pool);
  await guestPageRoutes(app, pool);
  await guestFlowRoutes(app, pool);
  await frameRoutes(app, pool);
  await qrRoutes(app, pool);
  await photoRoutes(app, pool);
  await printRoutes(app, pool);
  await agentRoutes(app, pool);
  await wallRoutes(app, pool);
  await sponsorRoutes(app, pool);
  await mosaicRoutes(app, pool);
  await syncRoutes(app, pool);
  await reportRoutes(app, pool);
  await userRoutes(app, pool);
  await retentionRoutes(app, pool);
  app.get("/api/v1/openapi.json", { preHandler: requirePermission(pool, "event:create") }, async () => buildOpenApi(app.rspRoutes, "0.1.0"));
  return app;
}
