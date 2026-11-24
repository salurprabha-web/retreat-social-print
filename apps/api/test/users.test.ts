import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-usr-"));
const { buildApp } = await import("../src/app");

let pool: Pool, admin: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
const PW = "correct horse battery";
let sup: S, supId = "", evA = "", evB = "";
const call = (s: S | null, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {} });
const login = async (email: string, password: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
const session = async (email: string, password: string): Promise<S> => { const r = await login(email, password); return { cookie: (r.headers["set-cookie"] as string).split(";")[0], csrf: r.json().csrf }; };
const mkEvent = async (name: string) => (await call(sup, "POST", "/api/v1/events", { name })).json().event.id as string;

beforeAll(async () => {
  admin = createPool(process.env.TEST_DATABASE_URL!);
  await admin.query("CREATE DATABASE rsp_users17");
  pool = createPool(process.env.TEST_DATABASE_URL!.replace(/\/rsp_test$/, "/rsp_users17"));
  await migrate(pool);
  app = await buildApp(pool);
  supId = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ('root17@t.test','Root',$1,'super_admin') RETURNING id", [await hashPassword(PW)])).rows[0].id;
  sup = await session("root17@t.test", PW);
  evA = await mkEvent("Users A"); evB = await mkEvent("Users B");
});
afterAll(async () => { await app.close(); await pool.end(); await admin.end(); });

describe("who can manage accounts", () => {
  it("only the super administrator, and never without sign-in or CSRF", async () => {
    const m = (await call(sup, "POST", "/api/v1/users", { email: "mgr@t.test", name: "Mgr" })).json();
    await call(sup, "PUT", `/api/v1/users/${m.user.id}/event-roles`, { eventId: evA, role: "event_manager" });
    const mgr = await session("mgr@t.test", m.temporaryPassword);
    for (const [method, url, body] of [["GET", "/api/v1/users", undefined], ["POST", "/api/v1/users", { email: "x@t.test", name: "X" }], ["PATCH", `/api/v1/users/${supId}`, { active: false }], ["POST", `/api/v1/users/${supId}/password`, {}], ["PUT", `/api/v1/users/${supId}/event-roles`, { eventId: evA, role: "print_operator" }]] as [string, string, unknown][]) {
      expect((await call(mgr, method, url, body)).statusCode, `${method} ${url}`).toBe(403);
      expect((await call(null, method, url, body)).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/api/v1/users", headers: { cookie: sup.cookie }, payload: { email: "nocsrf@t.test", name: "N" } })).statusCode).toBe(403);
  });
});

describe("creating accounts", () => {
  it("generates a one-time password when none is given, which works once and is never stored or listed", async () => {
    const r = await call(sup, "POST", "/api/v1/users", { email: "  New.Person@T.test ", name: "New Person" });
    expect(r.statusCode).toBe(201);
    const { user, temporaryPassword } = r.json();
    expect(user).toMatchObject({ email: "new.person@t.test", name: "New Person", superAdmin: false, active: true, eventRoles: [] });
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{18}$/);
    expect((await login("new.person@t.test", temporaryPassword)).statusCode).toBe(200);
    expect(JSON.stringify((await call(sup, "GET", "/api/v1/users")).json())).not.toMatch(/password_hash|argon2|passwordHash|temporaryPassword/);
    const stored = (await pool.query("SELECT password_hash FROM users WHERE email='new.person@t.test'")).rows[0].password_hash as string;
    expect(stored).toMatch(/^\$argon2id\$/); expect(stored).not.toContain(temporaryPassword);
  });
  it("a chosen password is not echoed back, weak ones are refused with a reason, and emails are unique whatever the case", async () => {
    const ok = await call(sup, "POST", "/api/v1/users", { email: "chosen@t.test", name: "Chosen", password: "a-fine-passphrase-2026" });
    expect(ok.statusCode).toBe(201); expect(ok.json().temporaryPassword).toBeUndefined(); expect(ok.body).not.toContain("a-fine-passphrase-2026");
    for (const [pw, reason] of [["short1!", "too_short"], ["password1234", "too_common"], ["my-wcontains_identity-pass", "contains_identity"], ["aaaaaaaaaaaaaa", "repetitive"]] as const) {
      const r = await call(sup, "POST", "/api/v1/users", { email: `w${reason}@t.test`, name: "W", password: pw });
      expect(r.statusCode, pw).toBe(400); expect(r.json()).toMatchObject({ error: "weak_password", reason });
    }
    expect((await call(sup, "POST", "/api/v1/users", { email: "CHOSEN@t.test", name: "Dup", password: "another-fine-passphrase-1" })).statusCode).toBe(409);
    for (const b of [{ email: "not-an-email", name: "X" }, { email: "x@t.test", name: "" }, { email: "x@t.test" }, { email: "x@t.test", name: "X", superAdmin: "yes" }]) expect((await call(sup, "POST", "/api/v1/users", b)).statusCode).toBe(400);
  });
  it("a new account can do nothing until it is given a role on an event", async () => {
    const r = (await call(sup, "POST", "/api/v1/users", { email: "fresh@t.test", name: "Fresh" })).json();
    const s = await session("fresh@t.test", r.temporaryPassword);
    expect((await call(s, "GET", `/api/v1/events/${evA}/frames`)).statusCode).toBe(403);
    expect((await call(s, "GET", "/api/v1/users")).statusCode).toBe(403);
    await call(sup, "PUT", `/api/v1/users/${r.user.id}/event-roles`, { eventId: evA, role: "print_operator" });
    expect((await call(s, "GET", `/api/v1/events/${evA}/print/jobs`)).statusCode).toBe(200);                 // the role takes effect on the next request
    expect((await call(s, "GET", `/api/v1/events/${evB}/print/jobs`)).statusCode).toBe(403);                 // and only for that event
    expect((await call(s, "POST", `/api/v1/events/${evA}/frames`, { name: "x", format: "4x6" })).statusCode).toBe(403);   // an operator can look but not design
    await call(sup, "PUT", `/api/v1/users/${r.user.id}/event-roles`, { eventId: evA, role: "reporting_viewer" });
    expect((await call(s, "GET", `/api/v1/events/${evA}/print/jobs`)).statusCode).toBe(403);
    expect((await call(s, "GET", `/api/v1/events/${evA}/reports/summary`)).statusCode).toBe(200);
    await call(sup, "PUT", `/api/v1/users/${r.user.id}/event-roles`, { eventId: evA, role: null });
    expect((await call(s, "GET", `/api/v1/events/${evA}/reports/summary`)).statusCode).toBe(403);
  });
  it("roles are validated: no super administrator through an event role, unknown events and users are not found", async () => {
    const u = (await call(sup, "POST", "/api/v1/users", { email: "roles@t.test", name: "R" })).json().user.id;
    expect((await call(sup, "PUT", `/api/v1/users/${u}/event-roles`, { eventId: evA, role: "super_admin" })).statusCode).toBe(400);
    expect((await call(sup, "PUT", `/api/v1/users/${u}/event-roles`, { eventId: evA, role: "owner" })).statusCode).toBe(400);
    expect((await call(sup, "PUT", `/api/v1/users/${u}/event-roles`, { eventId: "00000000-0000-4000-8000-000000000000", role: "event_manager" })).statusCode).toBe(404);
    expect((await call(sup, "PUT", `/api/v1/users/00000000-0000-4000-8000-000000000000/event-roles`, { eventId: evA, role: "event_manager" })).statusCode).toBe(404);
    const r = await call(sup, "PUT", `/api/v1/users/${u}/event-roles`, { eventId: evA, role: "event_manager" });
    expect(r.json().user.eventRoles).toEqual([{ eventId: evA, eventName: "Users A", role: "event_manager" }]);
  });
});

describe("changing and ending access", () => {
  it("deactivating signs the person out immediately and blocks sign-in; reactivating restores sign-in", async () => {
    const c = (await call(sup, "POST", "/api/v1/users", { email: "leaver@t.test", name: "Leaver" })).json();
    await call(sup, "PUT", `/api/v1/users/${c.user.id}/event-roles`, { eventId: evA, role: "event_manager" });
    const s = await session("leaver@t.test", c.temporaryPassword);
    expect((await call(s, "GET", `/api/v1/events/${evA}/frames`)).statusCode).toBe(200);
    expect((await call(sup, "PATCH", `/api/v1/users/${c.user.id}`, { active: false })).json().user.active).toBe(false);
    expect((await call(s, "GET", `/api/v1/events/${evA}/frames`)).statusCode).toBe(401);
    expect((await pool.query("SELECT count(*)::int n FROM sessions WHERE user_id=$1", [c.user.id])).rows[0].n).toBe(0);
    expect((await login("leaver@t.test", c.temporaryPassword)).statusCode).toBe(401);
    await call(sup, "PATCH", `/api/v1/users/${c.user.id}`, { active: true });
    expect((await login("leaver@t.test", c.temporaryPassword)).statusCode).toBe(200);
  });
  it("nobody can lock the platform out: not themselves, and two administrators cannot remove each other at the same moment", async () => {
    expect((await call(sup, "PATCH", `/api/v1/users/${supId}`, { active: false })).json().error).toBe("cannot_deactivate_self");
    expect((await call(sup, "PATCH", `/api/v1/users/${supId}`, { superAdmin: false })).json().error).toBe("cannot_demote_self");
    const second = (await call(sup, "POST", "/api/v1/users", { email: "root2@t.test", name: "Root Two", superAdmin: true })).json();
    const s2 = await session("root2@t.test", second.temporaryPassword);
    const [r1, r2] = await Promise.all([call(sup, "PATCH", `/api/v1/users/${second.user.id}`, { active: false }), call(s2, "PATCH", `/api/v1/users/${supId}`, { active: false })]);
    const codes = [r1.statusCode, r2.statusCode];
    expect(codes.filter((c) => c === 200)).toHaveLength(1);                                                        // exactly one of them wins
    expect([401, 403, 409]).toContain(codes.find((c) => c !== 200));                                                // the other is refused (its session ended, or the guard stopped it)
    expect((await pool.query("SELECT count(*)::int n FROM users WHERE global_role='super_admin' AND active")).rows[0].n).toBe(1);   // somebody can still administer
    await pool.query("UPDATE users SET active=true WHERE global_role='super_admin'");                              // back to normal for the other tests
    sup = await session("root17@t.test", PW);
    expect((await call(sup, "PATCH", `/api/v1/users/${second.user.id}`, { superAdmin: false })).statusCode).toBe(200);   // with two active administrators one may be demoted
    expect((await call(sup, "GET", "/api/v1/users")).json().users.find((u: any) => u.email === "root2@t.test").superAdmin).toBe(false);
  });
  it("renaming works, unknown accounts are not found, and every change is audited", async () => {
    const u = (await call(sup, "POST", "/api/v1/users", { email: "rename@t.test", name: "Before" })).json().user.id;
    expect((await call(sup, "PATCH", `/api/v1/users/${u}`, { name: "After" })).json().user.name).toBe("After");
    expect((await call(sup, "PATCH", `/api/v1/users/00000000-0000-4000-8000-000000000000`, { name: "x" })).statusCode).toBe(404);
    expect((await call(sup, "PATCH", `/api/v1/users/${u}`, { superAdmin: "x" })).statusCode).toBe(400);
    const actions = (await pool.query("SELECT action FROM audit_logs WHERE entity='user' AND entity_id=$1", [u])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["user_create", "user_update"]));
  });
});

describe("passwords", () => {
  it("an administrator reset signs the person out everywhere, clears a lock and gives a one-time password", async () => {
    const c = (await call(sup, "POST", "/api/v1/users", { email: "forgot@t.test", name: "Forgot" })).json();
    const s = await session("forgot@t.test", c.temporaryPassword);
    for (let i = 0; i < 6; i++) await login("forgot@t.test", "wrong-wrong-wrong");
    expect((await login("forgot@t.test", c.temporaryPassword)).statusCode).toBe(429);                      // locked after repeated failures
    expect((await call(sup, "GET", "/api/v1/users")).json().users.find((u: any) => u.email === "forgot@t.test").locked).toBe(true);
    const r = await call(sup, "POST", `/api/v1/users/${c.user.id}/password`, {});
    expect(r.statusCode).toBe(200); const fresh = r.json().temporaryPassword; expect(fresh).toMatch(/^[A-Za-z0-9]{18}$/); expect(fresh).not.toBe(c.temporaryPassword);
    expect((await call(s, "GET", "/api/v1/auth/me")).statusCode).toBe(401);                                // the old session is gone
    expect((await login("forgot@t.test", c.temporaryPassword)).statusCode).toBe(401);                       // the old password is gone
    expect((await login("forgot@t.test", fresh)).statusCode).toBe(200);                                     // and the lock too
    expect((await call(sup, "POST", `/api/v1/users/${c.user.id}/password`, { password: "short" })).json().reason).toBe("too_short");
    const detail = JSON.stringify((await pool.query("SELECT detail FROM audit_logs WHERE entity_id=$1 AND action='user_password_reset'", [c.user.id])).rows);
    expect(detail).not.toContain(fresh);                                                                    // the audit log never holds a password
  });
  it("a person can change their own password: current one required, policy applied, other sessions ended, this one kept", async () => {
    const c = (await call(sup, "POST", "/api/v1/users", { email: "self@t.test", name: "Selfie" })).json();
    const a = await session("self@t.test", c.temporaryPassword), b = await session("self@t.test", c.temporaryPassword);
    expect((await call(a, "POST", "/api/v1/auth/password", { current: "not-my-password", next: "a-brand-new-passphrase-1" })).statusCode).toBe(403);
    expect((await call(a, "POST", "/api/v1/auth/password", { current: c.temporaryPassword, next: "short" })).json().reason).toBe("too_short");
    expect((await call(a, "POST", "/api/v1/auth/password", { current: c.temporaryPassword, next: "selfie-and-more-letters" })).json().reason).toBe("contains_identity");
    expect((await call(a, "POST", "/api/v1/auth/password", { current: c.temporaryPassword, next: c.temporaryPassword })).json().error).toBe("same_password");
    expect((await call(null, "POST", "/api/v1/auth/password", { current: "x", next: "y" })).statusCode).toBe(401);
    expect((await call(a, "POST", "/api/v1/auth/password", { current: c.temporaryPassword, next: "a-brand-new-passphrase-1" })).statusCode).toBe(200);
    expect((await call(a, "GET", "/api/v1/auth/me")).statusCode).toBe(200);                                 // this session continues
    expect((await call(b, "GET", "/api/v1/auth/me")).statusCode).toBe(401);                                 // any other does not
    expect((await login("self@t.test", c.temporaryPassword)).statusCode).toBe(401);
    expect((await login("self@t.test", "a-brand-new-passphrase-1")).statusCode).toBe(200);
  });
  it("records when someone last signed in and when their password last changed", async () => {
    const u = (await call(sup, "GET", "/api/v1/users")).json().users.find((x: any) => x.email === "self@t.test");
    expect(u.lastLoginAt).not.toBeNull(); expect(u.passwordChangedAt).not.toBeNull();
  });
});
