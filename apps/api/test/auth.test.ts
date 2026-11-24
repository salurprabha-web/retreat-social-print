import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { roleHas, ROLES, PERMISSIONS } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
const PW = "correct horse battery";
let eventA: string, eventB: string;

async function mkUser(email: string, role: string) {
  return (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id",
    [email, await hashPassword(PW), role])).rows[0].id as string;
}
async function login(email: string, password = PW) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  const cookie = (res.headers["set-cookie"] as string | undefined)?.split(";")[0];
  return { res, cookie, csrf: res.statusCode === 200 ? res.json().csrf as string : "" };
}
const get = (url: string, cookie?: string) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  eventA = (await pool.query("INSERT INTO events(name,slug,status) VALUES ('A','auth-a','active') RETURNING id")).rows[0].id;
  eventB = (await pool.query("INSERT INTO events(name,slug,status) VALUES ('B','auth-b','active') RETURNING id")).rows[0].id;
  await mkUser("super@t.test", "super_admin");
  const mgr = await mkUser("mgr@t.test", "event_manager");
  await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,'event_manager')", [mgr, eventA]);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("permission matrix", () => {
  it("super_admin has everything; viewers cannot operate prints", () => {
    for (const p of PERMISSIONS) expect(roleHas("super_admin", p)).toBe(true);
    expect(roleHas("reporting_viewer", "print:operate")).toBe(false);
    expect(roleHas("print_operator", "event:edit")).toBe(false);
    expect(roleHas("event_manager", "event:delete")).toBe(false);
    expect(ROLES.length).toBe(4);
  });
});

describe("auth", () => {
  it("rejects unauthenticated access", async () => {
    expect((await get("/api/v1/dashboard/overview")).statusCode).toBe(401);
  });
  it("logs in, sets an httpOnly cookie and never stores the raw token", async () => {
    const { res, cookie } = await login("super@t.test");
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly/i);
    const token = cookie!.split("=")[1];
    const stored = await pool.query("SELECT token_hash FROM sessions");
    expect(stored.rows.some((r) => r.token_hash === token)).toBe(false);
    expect((await get("/api/v1/auth/me", cookie)).json().user.email).toBe("super@t.test");
  });
  it("gives the same error for unknown email and wrong password", async () => {
    const a = await login("nobody@t.test", "x"), b = await login("super@t.test", "wrong");
    expect(a.res.statusCode).toBe(401); expect(b.res.statusCode).toBe(401);
    expect(a.res.json()).toEqual(b.res.json());
  });
  it("requires the CSRF header on mutations", async () => {
    const { cookie, csrf } = await login("super@t.test");
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: cookie! } });
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: cookie!, "x-rsp-csrf": csrf } });
    expect(good.statusCode).toBe(200);
    expect((await get("/api/v1/auth/me", cookie)).statusCode).toBe(401);
  });
  it("locks the account after repeated failures, even for the right password", async () => {
    await mkUser("lock@t.test", "reporting_viewer");
    for (let i = 0; i < 5; i++) await login("lock@t.test", "bad");
    const r = await login("lock@t.test");
    expect(r.res.statusCode).toBe(429);
  });
  it("audits logins", async () => {
    const n = await pool.query("SELECT count(*)::int c FROM audit_logs WHERE action IN ('login','login_failed')");
    expect(n.rows[0].c).toBeGreaterThan(0);
  });
});

describe("dashboard scoping", () => {
  it("event manager sees only their own events; super admin sees all", async () => {
    const sup = await login("super@t.test"), mgr = await login("mgr@t.test");
    const s = (await get("/api/v1/dashboard/overview", sup.cookie)).json();
    const m = (await get("/api/v1/dashboard/overview", mgr.cookie)).json();
    expect(s.totalEvents).toBeGreaterThanOrEqual(2);
    expect(m.totalEvents).toBe(1);
    expect(s.photosPrinted).toBe(0);
  });
});
