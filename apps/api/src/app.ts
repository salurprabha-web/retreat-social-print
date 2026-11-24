import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { loginSchema } from "@rsp/shared";
import { config } from "./config";
import type { Pool } from "./db";
import { audit } from "./audit";
import {
  COOKIE_NAME, LOCK_MINUTES, MAX_FAILED_LOGINS, createSession, destroySession, loadUser, requireUser, verifyPassword,
} from "./auth";
import { dashboardRoutes } from "./routes/dashboard";

export async function buildApp(pool: Pool) {
  const app = Fastify({ logger: false, trustProxy: true, forceCloseConnections: true, bodyLimit: 256 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: () => config.globalRateLimitPerMin, timeWindow: "1 minute" });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation", issues: err.issues });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
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
      await pool.query("UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1", [u.id]);
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
  return app;
}
