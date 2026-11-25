import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import { roleHas, type Permission, type Role } from "@rsp/shared";
import type { Pool } from "./db";

/** How a route is protected. Attached to the preHandler so the route registry can read it: documentation and tests are derived from the code. */
export type AuthMeta =
  | { kind: "user" }
  | { kind: "permission"; permission: Permission; eventScoped: boolean }
  | { kind: "agent" }
  | { kind: "sync" }
  | { kind: "cron" };
export const tagAuth = <T extends object>(fn: T, meta: AuthMeta): T => Object.assign(fn, { rspAuth: meta });

export const COOKIE_NAME = "rsp_session";
export const CSRF_HEADER = "x-rsp-csrf";
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export interface AuthUser {
  id: string; email: string; name: string; globalRole: Role;
  eventRoles: Record<string, Role>;   // event_id -> role (non-super-admin users)
}

declare module "fastify" {
  interface FastifyRequest { user?: AuthUser }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashPassword = (pw: string) => hash(pw);

let dummyHash: Promise<string> | undefined;
/** Verifies against a dummy hash when the email is unknown so timing does not reveal valid emails. */
export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  dummyHash ??= hashPassword("not-a-real-password");
  const ok = await verify(stored ?? (await dummyHash), pw).catch(() => false);
  return stored ? ok : false;
}

export async function createSession(pool: Pool, userId: string, ttlHours: number) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(16).toString("base64url");
  const expires = new Date(Date.now() + ttlHours * 3600_000);
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,$4)",
    [sha256(token), userId, csrf, expires]);
  return { token, csrf, expires };
}

export const destroySession = (pool: Pool, token: string) =>
  pool.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);

export async function loadUser(pool: Pool, token: string): Promise<(AuthUser & { csrf: string }) | null> {
  const { rows } = await pool.query(
    `SELECT u.id,u.email,u.name,u.global_role,s.csrf_token FROM sessions s
       JOIN users u ON u.id=s.user_id AND u.active
      WHERE s.token_hash=$1 AND s.expires_at>now()`, [sha256(token)]);
  const r = rows[0];
  if (!r) return null;
  const er = await pool.query("SELECT event_id,role FROM user_event_roles WHERE user_id=$1", [r.id]);
  const eventRoles: Record<string, Role> = {};
  for (const x of er.rows) eventRoles[x.event_id] = x.role;
  return { id: r.id, email: r.email, name: r.name, globalRole: r.global_role, eventRoles, csrf: r.csrf_token };
}

/** Role this user holds for an event (super_admin holds it everywhere). */
export function roleForEvent(u: AuthUser, eventId: string): Role | null {
  if (u.globalRole === "super_admin") return "super_admin";
  return u.eventRoles[eventId] ?? null;
}

export function can(u: AuthUser, perm: Permission, eventId?: string): boolean {
  if (u.globalRole === "super_admin") return true;
  if (!eventId) return false;                    // global-scope permissions are super_admin only
  const r = u.eventRoles[eventId];
  return !!r && roleHas(r, perm);
}

/**
 * preHandler factory. Without eventParam the permission is global (super_admin only); with it, the user's role on that event
 * is checked. Mutations must carry the per-session CSRF header.
 */
export function requirePermission(pool: Pool, perm: Permission, opts: { eventParam?: string } = {}) {
  return tagAuth(async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const user = token ? await loadUser(pool, token) : null;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !csrfOk(req.headers[CSRF_HEADER], user.csrf)) {
      return reply.code(403).send({ error: "csrf" });
    }
    const eventId = opts.eventParam ? (req.params as Record<string, string>)[opts.eventParam] : undefined;
    if (!can(user, perm, eventId)) return reply.code(403).send({ error: "forbidden" });
    req.user = user;
  }, { kind: "permission", permission: perm, eventScoped: !!opts.eventParam });
}

/** Constant-time comparison of the per-session CSRF token. */
function csrfOk(sent: unknown, expected: string): boolean {
  if (typeof sent !== "string" || sent.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

/** Any signed-in user (used for /me and the dashboard, which scope their own data). */
export function requireUser(pool: Pool) {
  return tagAuth(async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const user = token ? await loadUser(pool, token) : null;
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !csrfOk(req.headers[CSRF_HEADER], user.csrf)) {
      return reply.code(403).send({ error: "csrf" });
    }
    req.user = user;
  }, { kind: "user" });
}
