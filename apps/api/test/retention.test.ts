import { exists, readStored, listStored } from "./helpers/store";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-ret-"));
process.env.STORAGE_DIR = STORE;
const { buildApp } = await import("../src/app");
const { claimNext, reportResult } = await import("../src/printService");
const { purgeEvent, retentionStatus, runRetention } = await import("../src/retention");

let pool: Pool, admin: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgr: S, viewer: S; let supId = "";
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$2,$3,$4) RETURNING id", [email, email.split("@")[0], await hashPassword(PW), role])).rows[0].id as string;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { s: { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S, id };
}
const call = (s: S | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { ...(s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {}), ...headers } });
async function mkEvent(name: string) {
  const e = (await call(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await call(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await call(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await call(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await call(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  await call(sup, "PATCH", `/api/v1/events/${e.id}`, { settings: { printMode: "auto" } });
  const photo = presetLayers("single", 1200, 1800).find((l) => l.type === "photo")!;
  const frame = (await call(sup, "POST", `/api/v1/events/${e.id}/frames`, { name: "F", format: "4x6", layers: [{ ...photo, x: 0, y: 0, w: 1, h: 1 }] })).json().frame.id as string;
  await call(sup, "POST", `/api/v1/events/${e.id}/logo/event`, await sharp({ create: { width: 200, height: 100, channels: 3, background: "#0a0" } }).png().toBuffer(), { "content-type": "application/octet-stream" });
  return { id: e.id as string, tok: e.guestToken as string, frame };
}
async function guests(ev: { id: string; tok: string; frame: string }, n: number) {
  const G = `/api/v1/public/g/${ev.tok}`; const out: { sid: string; cid: string }[] = [];
  for (let i = 0; i < n; i++) {
    const sres = await app.inject({ method: "POST", url: `${G}/session`, payload: { consent: true, fields: {} } }); if (sres.statusCode !== 201) throw new Error("session " + sres.statusCode + " " + sres.body); const sid = sres.json().sessionId as string; await pool.query("UPDATE guest_sessions SET fields=$2 WHERE id=$1", [sid, JSON.stringify({ email: `guest${i}@example.test`, name: `Guest ${i}` })]);
    const up = (await app.inject({ method: "POST", url: `${G}/photo`, payload: await sharp({ create: { width: 900, height: 1200, channels: 3, background: i % 2 ? "#a33" : "#33a" } }).jpeg().toBuffer(), headers: { "content-type": "application/octet-stream", "x-guest-session": sid } })).json().uploadId;
    const cid = (await app.inject({ method: "POST", url: `${G}/compose`, payload: { frameId: ev.frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
    await app.inject({ method: "POST", url: `${G}/composition/${cid}/finalize`, headers: { "x-guest-session": sid } });
    await app.inject({ method: "POST", url: `${G}/composition/${cid}/share`, payload: { channel: i % 2 ? "instagram" : "download" } as any, headers: { "x-guest-session": sid } });
    out.push({ sid, cid });
  }
  return out;
}
const n = async (table: string, ev: string) => (await pool.query(`SELECT count(*)::int c FROM ${table} WHERE event_id=$1`, [ev])).rows[0].c as number;
const files = async (ev: string, sub: string) => (await listStored(`events/${ev}/${sub}`)).length;
const archive = (ev: string) => call(sup, "POST", `/api/v1/events/${ev}/status`, { status: "archived" });
const daysFromNow = (d: number) => new Date(Date.now() + d * 86400_000 + 3600_000);

beforeAll(async () => {
  admin = createPool(process.env.TEST_DATABASE_URL!);
  await admin.query("CREATE DATABASE rsp_ret17");
  pool = createPool(process.env.TEST_DATABASE_URL!.replace(/\/rsp_test$/, "/rsp_ret17"));
  await migrate(pool);
  app = await buildApp(pool);
  const s = await mkUser("sup17r@t.test", "super_admin"); sup = s.s; supId = s.id;
});
afterAll(async () => { await app.close(); await pool.end(); await admin.end(); });

describe("the retention clock", () => {
  it("starts when an event is archived, and an active event is never purged", async () => {
    const ev = await mkEvent("Clock Event");
    const live = (await call(sup, "GET", `/api/v1/events/${ev.id}/retention`)).json();
    expect(live).toMatchObject({ status: "active", archivedAt: null, purgeAt: null, daysLeft: null, due: false, hold: false, purgedAt: null, retentionDays: 30 });
    await expect(purgeEvent(pool, ev.id, { userId: null, reason: "automatic" })).rejects.toMatchObject({ code: "not_archived" });
    expect((await runRetention(pool, { now: daysFromNow(400) })).purged).not.toContain(ev.id);                 // active events are out of reach however late it is
    await archive(ev.id);
    const s = (await call(sup, "GET", `/api/v1/events/${ev.id}/retention`)).json();
    expect(s.status).toBe("archived"); expect(s.daysLeft).toBe(30); expect(s.due).toBe(false);
    expect(Math.round((Date.parse(s.purgeAt) - Date.parse(s.archivedAt)) / 86400_000)).toBe(30);
    await call(sup, "POST", `/api/v1/events/${ev.id}/status`, { status: "inactive" });                          // restoring stops the clock
    expect((await call(sup, "GET", `/api/v1/events/${ev.id}/retention`)).json()).toMatchObject({ archivedAt: null, purgeAt: null });
    expect((await runRetention(pool, { now: daysFromNow(400) })).purged).not.toContain(ev.id);
  });
  it("each event follows its own retention period, to the day", async () => {
    const a = await mkEvent("Short"), b = await mkEvent("Long");
    await call(sup, "PATCH", `/api/v1/events/${a.id}`, { settings: { retentionDays: 7 } }); await call(sup, "PATCH", `/api/v1/events/${b.id}`, { settings: { retentionDays: 90 } });
    await archive(a.id); await archive(b.id);
    const arch = (await pool.query("SELECT archived_at FROM events WHERE id=$1", [a.id])).rows[0].archived_at as Date;
    const at = (days: number, h = 0) => new Date(arch.getTime() + days * 86400_000 + h * 3600_000);
    expect((await runRetention(pool, { now: at(7, -1) })).purged).toEqual([]);                                // one hour early: nothing
    const r = await runRetention(pool, { now: at(7, 1) });
    expect(r.purged).toContain(a.id); expect(r.purged).not.toContain(b.id);
    expect((await retentionStatus(pool, b.id, at(89, 1)))!.daysLeft).toBe(1);
    expect((await runRetention(pool, { now: at(91) })).purged).toContain(b.id);
  });
});

describe("what the purge deletes and what it keeps", () => {
  let ev: { id: string; tok: string; frame: string }; let before: any; const g: { sid: string; cid: string }[] = [];
  beforeAll(async () => {
    ev = await mkEvent("Purge Gala");
    g.push(...(await guests(ev, 6)));
    const j1 = await claimNext(pool, ev.id); await reportResult(pool, ev.id, j1!.id, true);
    const j2 = await claimNext(pool, ev.id); await reportResult(pool, ev.id, j2!.id, false, "Paper jam");
    const qr = (await call(sup, "GET", `/api/v1/events/${ev.id}/qr`)).json().qrCodes[0].code;
    for (let i = 0; i < 4; i++) await app.inject({ method: "GET", url: `/api/v1/public/q/${qr}` });
    await call(sup, "POST", `/api/v1/events/${ev.id}/compositions/bulk`, { ids: g.map((x) => x.cid), action: "approve" });
    await call(sup, "GET", `/api/v1/events/${ev.id}/compositions/${g[0].cid}/thumb`);                          // makes a cached thumbnail
    await pool.query("INSERT INTO wall_views(composition_id,event_id,shown_count) VALUES ($1,$2,3)", [g[0].cid, ev.id]);
    const wt = (await call(sup, "GET", `/api/v1/events/${ev.id}/wall`)).json().token;
    await call(sup, "PUT", `/api/v1/events/${ev.id}/wall`, { enabled: true, moderationRequired: false, displaySeconds: 6, mode: "slideshow", style: (await call(sup, "GET", `/api/v1/events/${ev.id}/wall`)).json().settings.style });
    await app.inject({ method: "GET", url: `/api/v1/public/w/${wt}/img/${g[0].cid}?w=800` });                  // cached wall image
    before = { summary: (await call(sup, "GET", `/api/v1/events/${ev.id}/reports/summary`)).json(), frames: (await call(sup, "GET", `/api/v1/events/${ev.id}/reports/frames`)).json(), printers: (await call(sup, "GET", `/api/v1/events/${ev.id}/reports/printers`)).json() };
    await archive(ev.id);
  });
  it("has something to delete before the purge", async () => {
    expect(await n("guest_sessions", ev.id)).toBe(6); expect(await n("final_compositions", ev.id)).toBe(6); expect(await n("photo_uploads", ev.id)).toBe(6);
    expect(await n("print_jobs", ev.id)).toBe(6); expect(await n("share_events", ev.id)).toBe(6); expect(await n("qr_scan_events", ev.id)).toBe(4); expect(await n("frame_selections", ev.id)).toBe(6);
    for (const d of ["originals", "finals", "thumbs", "wall"]) expect((await files(ev.id, d)), d).toBeGreaterThan(0);
    expect(before.summary.totals).toMatchObject({ sessions: 6, completed: 6, printed: 1, failedAttempts: 1, scans: 4, downloads: 3, wallAppearances: 3 });
  });
  it("manual deletion is for the super administrator, needs the event's name, and shows what would go", async () => {
    mgr = (await mkUser("mgr17r@t.test", "event_manager", ev.id, "event_manager")).s; viewer = (await mkUser("view17r@t.test", "reporting_viewer", ev.id, "reporting_viewer")).s;
    expect((await call(viewer, "GET", `/api/v1/events/${ev.id}/retention`)).json().counts).toEqual({ guests: 6, pictures: 6, photos: 6, printJobs: 6 });
    expect((await call(mgr, "POST", `/api/v1/events/${ev.id}/retention/purge`, { confirmName: "Purge Gala" })).statusCode).toBe(403);
    expect((await call(viewer, "PUT", `/api/v1/events/${ev.id}/retention`, { hold: true })).statusCode).toBe(403);
    expect((await call(sup, "POST", `/api/v1/events/${ev.id}/retention/purge`, { confirmName: "purge gala" })).statusCode).toBe(400);
    expect(await n("guest_sessions", ev.id)).toBe(6);
  });
  it("a legal hold stops the automatic purge, and lifting it lets it proceed", async () => {
    expect((await call(mgr, "PUT", `/api/v1/events/${ev.id}/retention`, { hold: true })).json().hold).toBe(true);
    const r = await runRetention(pool, { now: daysFromNow(60) });
    expect(r.purged).not.toContain(ev.id); expect(await n("guest_sessions", ev.id)).toBe(6);
    await call(mgr, "PUT", `/api/v1/events/${ev.id}/retention`, { hold: false });
    expect((await retentionStatus(pool, ev.id, daysFromNow(60)))!.due).toBe(true);
  });
  it("a venue server waits while anything has not been delivered", async () => {
    const r = await runRetention(pool, { now: daysFromNow(60), safe: async () => false });
    expect(r.purged).toEqual([]); expect(r.skipped).toContainEqual({ eventId: ev.id, reason: "undelivered_data" });
    expect(await n("final_compositions", ev.id)).toBe(6);
  });
  it("deletes guests, photos, pictures, print jobs, shares, scans and every file, and keeps the event itself", async () => {
    const r = await runRetention(pool, { now: daysFromNow(60) });
    expect(r.purged).toContain(ev.id);
    for (const t of ["guest_sessions", "photo_uploads", "final_compositions", "composition_photos", "print_jobs", "print_job_events", "share_events", "wall_views", "frame_selections", "qr_scan_events"]) expect(await n(t, ev.id), t).toBe(0);
    for (const d of ["originals", "finals", "thumbs", "wall"]) expect((await files(ev.id, d)), d).toBe(0);
    expect((await files(ev.id, "branding"))).toBeGreaterThan(0);                                                        // configuration stays
    expect((await pool.query("SELECT count(*)::int c FROM frames WHERE event_id=$1", [ev.id])).rows[0].c).toBe(1);
    const e = (await pool.query("SELECT status, purged_at, retention_snapshot FROM events WHERE id=$1", [ev.id])).rows[0];
    expect(e.status).toBe("archived"); expect(e.purged_at).not.toBeNull(); expect(e.retention_snapshot.version).toBe(1);
    expect(JSON.stringify(e.retention_snapshot)).not.toMatch(/example\.test|guest\d@/);                          // the snapshot holds figures, never personal data
    const a = (await pool.query("SELECT user_id, detail FROM audit_logs WHERE event_id=$1 AND action='retention_purge'", [ev.id])).rows[0];
    expect(a.user_id).toBeNull(); expect(a.detail).toMatchObject({ reason: "automatic", guests: 6, pictures: 6 });
  });
  it("reports keep working from the frozen figures, and say so", async () => {
    const s = (await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/summary?from=2000-01-01&to=2000-01-02`)).json();      // any period: the figures are for the whole event
    expect(s.archived).toBe(true); expect(s.totals).toEqual(before.summary.totals); expect(s.funnel).toEqual(before.summary.funnel);
    const f = (await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/frames`)).json(); expect(f.archived).toBe(true); expect(f.rows).toEqual(before.frames.rows);
    expect((await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/printers`)).json().rows).toEqual(before.printers.rows);
    const d = (await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/daily`)).json(); expect(d.archived).toBe(true);
    expect(d.rows.reduce((x: number, r: any) => x + r.completed, 0)).toBe(6);
    expect((await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/operators`)).json().archived).toBe(true);
    const csv = await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/summary/csv`); expect(csv.body).toContain("Guests (unique sessions),6");
    expect((await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/submissions/csv`)).body.trim().split("\r\n")).toHaveLength(1);       // header only: the pictures are gone
    const pdf = await call(viewer, "GET", `/api/v1/events/${ev.id}/reports/pdf`); expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await call(sup, "GET", "/api/v1/reports/events")).json().events.find((e: any) => e.eventId === ev.id)).toBeUndefined();     // archived events are not listed
    await call(sup, "POST", `/api/v1/events/${ev.id}/status`, { status: "inactive" });                                           // restored after the purge: listed, with its frozen figures
    const all = (await call(sup, "GET", "/api/v1/reports/events")).json().events.find((e: any) => e.eventId === ev.id);
    expect(all).toMatchObject({ sessions: 6, completed: 6, printed: 1, failedAttempts: 1, scans: 4 });
  });
  it("cannot be purged twice, by hand or by the timer", async () => {
    expect((await call(sup, "POST", `/api/v1/events/${ev.id}/retention/purge`, { confirmName: "Purge Gala" })).json().error).toBe("already_purged");
    expect((await runRetention(pool, { now: daysFromNow(900) })).purged).not.toContain(ev.id);
    expect((await call(mgr, "PUT", `/api/v1/events/${ev.id}/retention`, { hold: true })).json().error).toBe("already_purged");
    expect((await retentionStatus(pool, ev.id))!.purgedAt).not.toBeNull();
  });
});

describe("deleting by hand", () => {
  it("works on an archived event the moment it is confirmed, and refuses anything else", async () => {
    const ev = await mkEvent("Manual Purge"); await guests(ev, 2);
    expect((await call(sup, "POST", `/api/v1/events/${ev.id}/retention/purge`, { confirmName: "Manual Purge" })).json().error).toBe("not_archived");
    expect(await n("guest_sessions", ev.id)).toBe(2);
    await archive(ev.id);
    const r = await call(sup, "POST", `/api/v1/events/${ev.id}/retention/purge`, { confirmName: "Manual Purge" });
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ purged: true, counts: { guests: 2, pictures: 2 } });
    expect(await n("guest_sessions", ev.id)).toBe(0); expect((await files(ev.id, "finals"))).toBe(0);
    expect((await pool.query("SELECT detail FROM audit_logs WHERE event_id=$1 AND action='retention_purge'", [ev.id])).rows[0].detail.reason).toBe("manual");
  });
  it("a hold does not stop a deliberate manual deletion (a person decided)", async () => {
    const ev = await mkEvent("Hold Then Delete"); await guests(ev, 1); await archive(ev.id);
    await call(sup, "PUT", `/api/v1/events/${ev.id}/retention`, { hold: true });
    expect((await call(sup, "POST", `/api/v1/events/${ev.id}/retention/purge`, { confirmName: "Hold Then Delete" })).statusCode).toBe(200);
  });
  it("another event's data is untouched by a purge", async () => {
    const a = await mkEvent("Keeper"), b = await mkEvent("Goner"); await guests(a, 2); await guests(b, 2); await archive(b.id);
    await call(sup, "POST", `/api/v1/events/${b.id}/retention/purge`, { confirmName: "Goner" });
    expect(await n("guest_sessions", a.id)).toBe(2); expect(await n("final_compositions", a.id)).toBe(2); expect((await files(a.id, "finals"))).toBe(2); expect((await files(b.id, "finals"))).toBe(0);
  });
});
