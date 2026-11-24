import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PASSWORD_MESSAGE, ROLES, passwordProblem } from "@rsp/shared";
import type { Pool } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { COOKIE_NAME, destroySession, hashPassword, requirePermission, requireUser, sha256, verifyPassword } from "../auth";

const EVENT_ROLES = ROLES.filter((r) => r !== "super_admin");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** A strong one-time password (no look-alike characters) for when the administrator does not choose one. */
export const generatePassword = () => Array.from(randomBytes(18), (b) => ALPHABET[b % ALPHABET.length]).join("");

export async function userRoutes(app: FastifyInstance, pool: Pool) {
  const admin = requirePermission(pool, "event:create");               // global permission: super administrator only

  const shape = (u: any, roles: any[]) => ({
    id: u.id, email: u.email, name: u.name, superAdmin: u.global_role === "super_admin", active: u.active, createdAt: u.created_at, lastLoginAt: u.last_login_at, passwordChangedAt: u.password_changed_at,
    locked: !!u.locked_until && new Date(u.locked_until) > new Date(), eventRoles: roles.filter((r) => r.user_id === u.id).map((r) => ({ eventId: r.event_id, eventName: r.name, role: r.role })),
  });
  async function load(id?: string) {
    const users = (await pool.query(`SELECT id,email,name,global_role,active,created_at,last_login_at,password_changed_at,locked_until FROM users ${id ? "WHERE id=$1" : ""} ORDER BY lower(email)`, id ? [id] : [])).rows;
    const roles = (await pool.query("SELECT r.user_id,r.event_id,r.role,e.name FROM user_event_roles r JOIN events e ON e.id=r.event_id ORDER BY e.name")).rows;
    return users.map((u) => shape(u, roles));
  }
  const superCount = async (tx: Pool | import("../db").Tx) => (await tx.query("SELECT count(*)::int n FROM users WHERE global_role='super_admin' AND active")).rows[0].n as number;
  const bad = (reply: any, p: NonNullable<ReturnType<typeof passwordProblem>>) => reply.code(400).send({ error: "weak_password", reason: p, message: PASSWORD_MESSAGE[p] });

  app.get("/api/v1/users", { preHandler: admin }, async () => ({ users: await load() }));

  app.post("/api/v1/users", { preHandler: admin }, async (req, reply) => {
    const b = z.object({ email: z.string().trim().toLowerCase().email().max(200), name: z.string().trim().min(1).max(120), superAdmin: z.boolean().default(false), password: z.string().max(200).optional() }).parse(req.body);
    const password = b.password ?? generatePassword();
    const p = passwordProblem(password, b); if (p) return bad(reply, p);
    if ((await pool.query("SELECT 1 FROM users WHERE lower(email)=$1", [b.email])).rowCount) return reply.code(409).send({ error: "email_in_use" });
    const r = (await pool.query("INSERT INTO users(email,name,password_hash,global_role,password_changed_at) VALUES ($1,$2,$3,$4,now()) RETURNING id",
      [b.email, b.name, await hashPassword(password), b.superAdmin ? "super_admin" : "reporting_viewer"])).rows[0];    // staff without a global role can do nothing until given an event role
    await audit(pool, req.user!.id, "user_create", { entity: "user", entityId: r.id, detail: { email: b.email, superAdmin: b.superAdmin }, ip: req.ip });
    return reply.code(201).send({ user: (await load(r.id))[0], ...(b.password ? {} : { temporaryPassword: password }) });
  });

  app.patch("/api/v1/users/:id", { preHandler: admin }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), active: z.boolean().optional(), superAdmin: z.boolean().optional(), unlock: z.literal(true).optional() }).parse(req.body);
    const out = await withTx(pool, async (tx) => {
      // Every administrator row is locked first, so two administrators cannot remove each other at the same moment and leave nobody.
      await tx.query("SELECT id FROM users WHERE global_role='super_admin' ORDER BY id FOR UPDATE");
      const actor = (await tx.query("SELECT active, global_role FROM users WHERE id=$1", [req.user!.id])).rows[0];
      if (!actor?.active || actor.global_role !== "super_admin") return "forbidden" as const;       // the actor lost their rights while this request was waiting
      const u = (await tx.query("SELECT id,global_role,active FROM users WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!u) return "not_found" as const;
      if (id === req.user!.id && b.active === false) return "cannot_deactivate_self" as const;
      if (id === req.user!.id && b.superAdmin === false) return "cannot_demote_self" as const;
      const loseSuper = u.global_role === "super_admin" && u.active && ((b.superAdmin === false) || (b.active === false));
      if (loseSuper && (await superCount(tx)) <= 1) return "last_super_admin" as const;          // nobody may lock the platform out of its own administration
      if (b.name !== undefined) await tx.query("UPDATE users SET name=$2 WHERE id=$1", [id, b.name]);
      if (b.active !== undefined) await tx.query("UPDATE users SET active=$2 WHERE id=$1", [id, b.active]);
      if (b.superAdmin !== undefined) await tx.query("UPDATE users SET global_role=$2 WHERE id=$1", [id, b.superAdmin ? "super_admin" : "reporting_viewer"]);
      if (b.unlock) await tx.query("UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1", [id]);
      if (b.active === false || b.superAdmin !== undefined) await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);            // access changes take effect now
      await audit(tx, req.user!.id, "user_update", { entity: "user", entityId: id, detail: { ...b }, ip: req.ip });
      return "ok" as const;
    });
    if (out === "not_found") return reply.code(404).send({ error: "not_found" });
    if (out !== "ok") return reply.code(409).send({ error: out });
    return { user: (await load(id))[0] };
  });

  app.post("/api/v1/users/:id/password", { preHandler: admin }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const b = z.object({ password: z.string().max(200).optional() }).parse(req.body ?? {});
    const u = (await pool.query("SELECT email,name FROM users WHERE id=$1", [id])).rows[0];
    if (!u) return reply.code(404).send({ error: "not_found" });
    const password = b.password ?? generatePassword();
    const p = passwordProblem(password, u); if (p) return bad(reply, p);
    await withTx(pool, async (tx) => {
      await tx.query("UPDATE users SET password_hash=$2, password_changed_at=now(), failed_logins=0, locked_until=NULL WHERE id=$1", [id, await hashPassword(password)]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);                          // anyone holding an old session is signed out
      await audit(tx, req.user!.id, "user_password_reset", { entity: "user", entityId: id, ip: req.ip });
    });
    return b.password ? { ok: true } : { ok: true, temporaryPassword: password };
  });

  app.put("/api/v1/users/:id/event-roles", { preHandler: admin }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const b = z.object({ eventId: z.string().uuid(), role: z.enum(EVENT_ROLES as unknown as [string, ...string[]]).nullable() }).parse(req.body);
    if (!(await pool.query("SELECT 1 FROM users WHERE id=$1", [id])).rowCount) return reply.code(404).send({ error: "not_found" });
    if (!(await pool.query("SELECT 1 FROM events WHERE id=$1", [b.eventId])).rowCount) return reply.code(404).send({ error: "event_not_found" });
    if (b.role) await pool.query("INSERT INTO user_event_roles(user_id,event_id,role) VALUES ($1,$2,$3) ON CONFLICT (user_id,event_id) DO UPDATE SET role=EXCLUDED.role", [id, b.eventId, b.role]);
    else await pool.query("DELETE FROM user_event_roles WHERE user_id=$1 AND event_id=$2", [id, b.eventId]);
    await audit(pool, req.user!.id, "user_event_role", { eventId: b.eventId, entity: "user", entityId: id, detail: { role: b.role }, ip: req.ip });
    return { user: (await load(id))[0] };
  });

  /** Anyone signed in may change their own password. Their other sessions end; this one stays. */
  app.post("/api/v1/auth/password", { preHandler: requireUser(pool), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(req.body);
    const u = (await pool.query("SELECT password_hash,email,name FROM users WHERE id=$1", [req.user!.id])).rows[0];
    if (!(await verifyPassword(u.password_hash, b.current))) return reply.code(403).send({ error: "wrong_password" });
    const p = passwordProblem(b.next, u); if (p) return bad(reply, p);
    if (b.next === b.current) return reply.code(400).send({ error: "same_password" });
    await withTx(pool, async (tx) => {
      await tx.query("UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1", [req.user!.id, await hashPassword(b.next)]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [req.user!.id, sha256(req.cookies[COOKIE_NAME]!)]);
      await audit(tx, req.user!.id, "password_change", { entity: "user", entityId: req.user!.id, ip: req.ip });
    });
    void destroySession;
    return { ok: true };
  });
}
