import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
const PW = "correct horse battery";
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, op: S, viewer: S; let evA: string, evB: string;

async function mkUser(email: string, role: string, event?: string, eventRole?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id",
    [email, await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, eventRole]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const call = (s: S, method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: s.cookie, "x-rsp-csrf": s.csrf, ...extra } });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup3@t.test", "super_admin");
  evA = (await call(sup, "POST", "/api/v1/events", { name: "Wedding A", hashtag: "WedA" })).json().event.id;
  evB = (await call(sup, "POST", "/api/v1/events", { name: "Expo B" })).json().event.id;
  mgrA = await mkUser("mgr3@t.test", "event_manager", evA, "event_manager");
  op = await mkUser("op3@t.test", "print_operator", evA, "print_operator");
  viewer = await mkUser("view3@t.test", "reporting_viewer", evA, "reporting_viewer");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("event CRUD", () => {
  it("creates an event with defaults, unique slug and an unguessable token", async () => {
    const r = await call(sup, "POST", "/api/v1/events", { name: "Wedding A" });
    expect(r.statusCode).toBe(201);
    const e = r.json().event;
    expect(e.status).toBe("draft"); expect(e.guestToken).toMatch(/^[0-9a-f]{24}$/);
    expect(e.slug).not.toBe((await call(sup, "GET", `/api/v1/events/${evA}`)).json().event.slug);
    expect(e.settings.printMode).toBe("manual");
  });
  it("validates input", async () => {
    expect((await call(sup, "POST", "/api/v1/events", { name: "x" })).statusCode).toBe(400);
    expect((await call(sup, "POST", "/api/v1/events", { name: "Ok name", hashtag: "bad tag!" })).statusCode).toBe(400);
  });
  it("edits event and settings", async () => {
    const r = await call(mgrA, "PATCH", `/api/v1/events/${evA}`, { clientName: "Acme", settings: { printMode: "auto", retentionDays: 7, primaryColor: "#112233" } });
    expect(r.statusCode).toBe(200);
    const e = r.json().event;
    expect(e.clientName).toBe("Acme"); expect(e.settings.printMode).toBe("auto"); expect(e.settings.retentionDays).toBe(7);
    expect(e.settings.branding.primaryColor).toBe("#112233");
    expect((await call(mgrA, "PATCH", `/api/v1/events/${evA}`, { settings: { retentionDays: 0 } })).statusCode).toBe(400);
  });
  it("walks the status lifecycle and refuses invalid transitions", async () => {
    expect((await call(sup, "POST", `/api/v1/events/${evB}/status`, { status: "active" })).json().event.status).toBe("active");
    expect((await call(sup, "POST", `/api/v1/events/${evB}/status`, { status: "archived" })).json().event.archivedAt).toBeTruthy();
    expect((await call(sup, "POST", `/api/v1/events/${evB}/status`, { status: "active" })).statusCode).toBe(409);
    expect((await call(sup, "POST", `/api/v1/events/${evB}/status`, { status: "inactive" })).json().event.archivedAt).toBeNull();
  });
  it("duplicates configuration but not data, with a fresh token and without logos", async () => {
    await call(sup, "POST", `/api/v1/events/${evA}/logo/client`, PNG, { "content-type": "image/png" });
    const d = (await call(sup, "POST", `/api/v1/events/${evA}/duplicate`)).json().event;
    expect(d.id).not.toBe(evA); expect(d.name).toBe("Wedding A (copy)");
    expect(d.settings.printMode).toBe("auto"); expect(d.settings.branding.clientLogo).toBeUndefined();
    expect(d.settings.branding.primaryColor).toBe("#112233");
    const o = (await call(sup, "GET", `/api/v1/events/${evA}`)).json().event;
    expect(d.guestToken).not.toBe(o.guestToken);
  });
  it("deletes only after the name is confirmed", async () => {
    const id = (await call(sup, "POST", "/api/v1/events", { name: "Temp Event" })).json().event.id;
    expect((await call(sup, "DELETE", `/api/v1/events/${id}`, { confirmName: "nope" })).statusCode).toBe(400);
    expect((await call(sup, "DELETE", `/api/v1/events/${id}`, { confirmName: "Temp Event" })).statusCode).toBe(200);
    expect((await call(sup, "GET", `/api/v1/events/${id}`)).statusCode).toBe(404);
  });
  it("audits mutations", async () => {
    const n = await pool.query("SELECT count(*)::int c FROM audit_logs WHERE action LIKE 'event_%'");
    expect(n.rows[0].c).toBeGreaterThan(5);
  });
});

describe("permissions and isolation", () => {
  it("lists only the events a user may see; filters work", async () => {
    const m = (await call(mgrA, "GET", "/api/v1/events")).json().events;
    expect(m.map((e: any) => e.id)).toEqual(expect.arrayContaining([evA]));
    expect(m.some((e: any) => e.id === evB)).toBe(false);
    const f = (await call(sup, "GET", "/api/v1/events?status=inactive&q=expo")).json().events;
    expect(f.map((e: any) => e.id)).toEqual([evB]);
  });
  it("blocks access to other events (403) and enforces role limits", async () => {
    expect((await call(mgrA, "GET", `/api/v1/events/${evB}`)).statusCode).toBe(403);
    expect((await call(mgrA, "PATCH", `/api/v1/events/${evB}`, { name: "Hacked" })).statusCode).toBe(403);
    expect((await call(op, "PATCH", `/api/v1/events/${evA}`, { name: "Nope" })).statusCode).toBe(403);
    expect((await call(viewer, "POST", `/api/v1/events/${evA}/status`, { status: "active" })).statusCode).toBe(403);
    expect((await call(op, "GET", `/api/v1/events/${evA}`)).statusCode).toBe(200);
    expect((await call(mgrA, "POST", "/api/v1/events", { name: "Mine now" })).statusCode).toBe(403);
    expect((await call(mgrA, "DELETE", `/api/v1/events/${evA}`, { confirmName: "Wedding A" })).statusCode).toBe(403);
  });
  it("requires CSRF on mutations", async () => {
    const r = await app.inject({ method: "PATCH", url: `/api/v1/events/${evA}`, payload: { name: "Csrf test" }, headers: { cookie: sup.cookie } });
    expect(r.statusCode).toBe(403);
  });
});

describe("logo upload", () => {
  it("accepts a real PNG, stores under a random key and serves it to authorised users only", async () => {
    const r = await call(sup, "POST", `/api/v1/events/${evA}/logo/event`, PNG, { "content-type": "image/png" });
    expect(r.statusCode).toBe(201);
    const key = r.json().event.settings.branding.eventLogo as string;
    expect(key).toMatch(new RegExp(`^events/${evA}/branding/[0-9a-f]{32}\\.png$`));
    const g = await call(op, "GET", `/api/v1/events/${evA}/logo/event`);
    expect(g.statusCode).toBe(200); expect(g.headers["content-type"]).toBe("image/png");
    expect((await call(mgrA, "GET", `/api/v1/events/${evB}/logo/event`)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/v1/events/${evA}/logo/event` })).statusCode).toBe(401);
  });
  it("trusts the bytes, not the declared type", async () => {
    const r = await call(sup, "POST", `/api/v1/events/${evA}/logo/event`, Buffer.from("MZ-not-an-image"), { "content-type": "image/png" });
    expect(r.statusCode).toBe(415);
  });
  it("rejects active SVG and accepts a plain one", async () => {
    const bad = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const bad2 = '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect/></svg>';
    const good = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#c00"/></svg>';
    expect((await call(sup, "POST", `/api/v1/events/${evA}/logo/client`, Buffer.from(bad), { "content-type": "image/svg+xml" })).statusCode).toBe(422);
    expect((await call(sup, "POST", `/api/v1/events/${evA}/logo/client`, Buffer.from(bad2), { "content-type": "image/svg+xml" })).statusCode).toBe(422);
    expect((await call(sup, "POST", `/api/v1/events/${evA}/logo/client`, Buffer.from(good), { "content-type": "image/svg+xml" })).statusCode).toBe(201);
  });
  it("replacing a logo removes the old file; deleting the event removes its files", async () => {
    const first = (await call(sup, "POST", `/api/v1/events/${evA}/logo/event`, PNG, { "content-type": "image/png" })).json().event.settings.branding.eventLogo;
    const second = (await call(sup, "POST", `/api/v1/events/${evA}/logo/event`, PNG, { "content-type": "image/png" })).json().event.settings.branding.eventLogo;
    const root = process.env.STORAGE_DIR!;
    expect(fs.existsSync(path.join(root, first))).toBe(false);
    expect(fs.existsSync(path.join(root, second))).toBe(true);
    const id = (await call(sup, "POST", "/api/v1/events", { name: "Files Gone" })).json().event.id;
    await call(sup, "POST", `/api/v1/events/${id}/logo/event`, PNG, { "content-type": "image/png" });
    expect(fs.existsSync(path.join(root, "events", id))).toBe(true);
    await call(sup, "DELETE", `/api/v1/events/${id}`, { confirmName: "Files Gone" });
    expect(fs.existsSync(path.join(root, "events", id))).toBe(false);
  });
});
