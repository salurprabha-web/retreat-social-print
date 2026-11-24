import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import sharp from "sharp";
import { presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { claimNext, reportResult, reprint } from "../src/printService";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-rep-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgr: S, viewer: S, op: S, opOnly: S, outsiderMgr: S;
let evA = "", evB = "", tokA = "", f1 = "", f2 = "", qrCode = "", p1 = "", p2 = "", opUserId = "", supUserId = "";
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
  return e as { id: string; guestToken: string };
}
const jpeg = (c: string) => sharp({ create: { width: 1500, height: 2250, channels: 3, background: c } }).jpeg().toBuffer();
const R = (ev: string, name: string, qs = "", s: S | null = sup) => call(s, "GET", `/api/v1/events/${ev}/reports/${name}${qs}`);

const G = () => `/api/v1/public/g/${tokA}`;
async function guest(o: { upload?: boolean; frame?: string; also?: string; finish?: boolean } = {}) {
  const sid = (await app.inject({ method: "POST", url: `${G()}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
  const h = { "x-guest-session": sid }; let up = "", cid = "";
  if (o.upload !== false) up = (await app.inject({ method: "POST", url: `${G()}/photo`, payload: await jpeg("#336699"), headers: { ...h, "content-type": "application/octet-stream" } })).json().uploadId;
  const compose = async (frame: string) => (await app.inject({ method: "POST", url: `${G()}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: h })).json().compositionId as string;
  if (o.frame) cid = await compose(o.frame);
  if (o.also) cid = await compose(o.also);                                   // changed their mind: the first picture is replaced
  if (cid && o.finish !== false) await app.inject({ method: "POST", url: `${G()}/composition/${cid}/finalize`, headers: h });
  return { sid, cid };
}
const share = (g: { sid: string; cid: string }, channel: string) => app.inject({ method: "POST", url: `${G()}/composition/${g.cid}/share`, payload: { channel } as any, headers: { "x-guest-session": g.sid } });
const job = async (cid: string) => (await pool.query("SELECT id FROM print_jobs WHERE composition_id=$1 AND kind='print'", [cid])).rows[0]?.id as string;
const action = (s: S, ev: string, jobId: string, a: string) => call(s, "POST", `/api/v1/events/${ev}/print/jobs/${jobId}/action`, { action: a });
const decodePdfText = (pdf: Buffer) => {                                     // inflate every content stream and read the hex-coded text back
  const out: string[] = []; const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let m: RegExpExecArray | null; const s = pdf.toString("latin1");
  while ((m = re.exec(s))) { try { const t = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); for (const h of t.matchAll(/<([0-9a-f]+)>/g)) out.push(Buffer.from(h[1], "hex").toString("latin1")); out.push("\n"); } catch { /* not a flate stream */ } }
  return out.join("");
};

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  const s = await mkUser("sup16@t.test", "super_admin"); sup = s.s; supUserId = s.id;
  const a = await mkEvent("Report Gala"), b = await mkEvent("Report Zones");
  evA = a.id; tokA = a.guestToken; evB = b.id;
  const photo = presetLayers("single", 1200, 1800).find((l) => l.type === "photo")!;
  const mkFrame = async (name: string) => (await call(sup, "POST", `/api/v1/events/${evA}/frames`, { name, format: "4x6", layers: [{ ...photo, x: 0, y: 0, w: 1, h: 1 }] })).json().frame.id as string;
  f1 = await mkFrame("Classic"); f2 = await mkFrame("Gold");
  mgr = (await mkUser("mgr16@t.test", "event_manager", evA, "event_manager")).s;
  viewer = (await mkUser("view16@t.test", "reporting_viewer", evA, "reporting_viewer")).s;
  const o = await mkUser("op16@t.test", "print_operator", evA, "print_operator"); op = o.s; opUserId = o.id; opOnly = op;
  outsiderMgr = (await mkUser("mgrb16@t.test", "event_manager", evB, "event_manager")).s;
  qrCode = (await call(sup, "GET", `/api/v1/events/${evA}/qr`)).json().qrCodes[0].code;
  const dev = (await pool.query("INSERT INTO devices(event_id,kind,name,token_hash) VALUES ($1,'print_agent','Print PC','h16') RETURNING id", [evA])).rows[0].id;
  p1 = (await pool.query("INSERT INTO printers(event_id,device_id,name,paper_size,enabled,status) VALUES ($1,$2,'Printer One','4x6',true,'ready') RETURNING id", [evA, dev])).rows[0].id;
  p2 = (await pool.query("INSERT INTO printers(event_id,device_id,name,paper_size,enabled,status) VALUES ($1,$2,'Printer Two','4x6',true,'ready') RETURNING id", [evA, dev])).rows[0].id;
  await call(sup, "PATCH", `/api/v1/events/${evA}`, { settings: { printMode: "auto" } });

  // ----- the scripted event -----
  for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: `/api/v1/public/q/${qrCode}` });                       // 3 scans
  const g1 = await guest({ frame: f1 });                                                                                    // prints fine on printer one
  const j1 = await claimNext(pool, evA, p1); await reportResult(pool, evA, j1!.id, true);
  const g2 = await guest({ frame: f2 });                                                                                    // fails on one, retried and printed on two
  const j2 = await claimNext(pool, evA, p1); await reportResult(pool, evA, j2!.id, false, "Paper jam");
  expect((await action(op, evA, j2!.id, "retry")).statusCode).toBe(200);
  const j2b = await claimNext(pool, evA, p2); await reportResult(pool, evA, j2b!.id, true);
  const g3 = await guest({ frame: f1 });                                                                                    // finished, waiting in the queue
  await guest({ upload: true });                                                                                            // g4: photo only
  await guest({ upload: false });                                                                                           // g5: nothing
  const g6 = await guest({ frame: f1, also: f2 });                                                                          // tried two frames, kept the second
  await call(sup, "PATCH", `/api/v1/events/${evA}`, { settings: { printMode: "manual" } });
  const g7 = await guest({ frame: f1 }); const g8 = await guest({ frame: f2 });
  expect((await action(op, evA, await job(g7.cid), "approve")).statusCode).toBe(200);                                       // operator approves for print
  expect((await action(op, evA, await job(g8.cid), "cancel")).statusCode).toBe(200);                                        // operator cancels
  await reprint(pool, evA, g1.cid, opUserId, { requestId: "r1", approveNow: false });                                      // operator asks for a reprint
  // shares
  await share(g1, "instagram"); await share(g1, "whatsapp"); await share(g1, "download"); await share(g1, "download"); await share(g1, "copy_caption"); await share(g2, "native");
  // moderation by the administrator (bulk: counts every picture, not every click)
  await call(sup, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [g1.cid, g2.cid], action: "approve" });
  await call(sup, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [g3.cid], action: "reject" });                  // also cancels g3's waiting print job
  await call(sup, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [g1.cid], action: "hide_wall" });
  await pool.query("INSERT INTO wall_views(composition_id,event_id,shown_count) VALUES ($1,$2,5)", [g1.cid, evA]);
  void g6;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("access", () => {
  it("is for people who may view reports: managers and reporting viewers, not operators, not other events", async () => {
    for (const name of ["summary", "daily", "frames", "operators", "printers"]) {
      expect((await R(evA, name, "", mgr)).statusCode).toBe(200);
      expect((await R(evA, name, "", viewer)).statusCode).toBe(200);
      expect((await R(evA, name, "", opOnly)).statusCode).toBe(403);
      expect((await R(evA, name, "", outsiderMgr)).statusCode).toBe(403);
      expect((await R(evA, name, "", null)).statusCode).toBe(401);
    }
    for (const u of [`/reports/summary/csv`, `/reports/pdf`]) { expect((await call(opOnly, "GET", `/api/v1/events/${evA}${u}`)).statusCode).toBe(403); expect((await call(null, "GET", `/api/v1/events/${evA}${u}`)).statusCode).toBe(401); }
  });
  it("rejects bad dates, ranges, zones and report names", async () => {
    for (const qs of ["?from=2026-02-30", "?to=nope", "?from=2026-03-05&to=2026-03-01", "?tz=Mars/Phobos", "?tz=" + "x".repeat(80)]) {
      const r = await R(evA, "summary", qs); expect(r.statusCode).toBe(400);
    }
    expect((await R(evA, "summary", "?from=2026-02-30")).json().error).toBe("bad_date");
    expect((await R(evA, "summary", "?tz=Mars/Phobos")).json().error).toBe("bad_timezone");
    expect((await R(evA, "summary", "?from=2026-03-05&to=2026-03-01")).json().error).toBe("bad_range");
    expect((await R(evA, "daily", "?from=2024-01-01&to=2026-01-01")).json().error).toBe("range_too_long");
    expect((await call(sup, "GET", `/api/v1/events/${evA}/reports/nothing/csv`)).statusCode).toBe(404);
  });
});

describe("event summary", () => {
  it("counts exactly what the scripted event did", async () => {
    const j = (await R(evA, "summary")).json();
    expect(j.totals).toEqual({
      scans: 3, sessions: 8, uploads: 7, frameSelections: 7, completed: 6,
      instagramAttempts: 1, whatsappAttempts: 1, nativeAttempts: 1, shareAttempts: 3, copies: 1, downloads: 2, uniqueSharers: 2,
      printJobs: 6, reprints: 1, printed: 2, copiesPrinted: 2, failedAttempts: 1, wallAppearances: 5, wallPictures: 1,
    });
    expect(j.qr).toEqual([{ code: qrCode, label: expect.anything(), scans: 3 }]);
  });
  it("the guest journey shows how far guests got", async () => {
    const f = (await R(evA, "summary")).json().funnel;
    expect(f.map((s: any) => [s.key, s.count])).toEqual([["guests", 8], ["uploaded", 7], ["frame", 6], ["finished", 6], ["shared", 2], ["printed", 2]]);
    expect(f.map((s: any) => s.pct)).toEqual([100, 87.5, 75, 75, 25, 25]);
  });
  it("is scoped to its own event", async () => {
    const b = (await R(evB, "summary")).json().totals;
    expect(b).toMatchObject({ sessions: 0, completed: 0, printed: 0, scans: 0 });
  });
});

describe("frame popularity", () => {
  it("counts choices (including a replaced try), completed pictures, prints and shares per frame", async () => {
    const rows = (await R(evA, "frames")).json().rows;
    const c = rows.find((r: any) => r.name === "Classic"), g = rows.find((r: any) => r.name === "Gold");
    expect(c).toMatchObject({ selections: 4, completed: 3, completedPct: 50, printed: 1, shareAttempts: 2, downloads: 2, sharedOrDownloadedPct: 33.3 });
    expect(g).toMatchObject({ selections: 3, completed: 3, completedPct: 50, printed: 1, shareAttempts: 1, downloads: 0, sharedOrDownloadedPct: 33.3 });
    expect(rows.reduce((n: number, r: any) => n + r.selections, 0)).toBe(7);
  });
});

describe("printers", () => {
  it("attributes finished jobs to the printer that finished them, with success rate and timing", async () => {
    const rows = (await R(evA, "printers")).json().rows;
    const one = rows.find((r: any) => r.name === "Printer One"), two = rows.find((r: any) => r.name === "Printer Two");
    expect(one).toMatchObject({ computer: "Print PC", paper: "4x6", printed: 1, copiesPrinted: 1, failed: 0, successPct: 100 });
    expect(two).toMatchObject({ printed: 1, copiesPrinted: 1, failed: 0 });
    expect(one.avgSeconds).not.toBeNull(); expect(rows.find((r: any) => r.printerId === null)).toBeUndefined();
  });
  it("a job nobody printed on shows as not assigned", async () => {
    const jid = (await pool.query("SELECT id FROM print_jobs WHERE event_id=$1 AND status='printed' LIMIT 1", [evA])).rows[0].id;
    await pool.query("UPDATE print_jobs SET printer_id=NULL WHERE id=$1", [jid]);
    const rows = (await R(evA, "printers")).json().rows;
    expect(rows.find((r: any) => r.printerId === null)).toMatchObject({ name: "Not assigned to a printer", printed: 1 });
  });
});

describe("operators", () => {
  it("counts each person's moderation per picture and print actions per job, and not the automatic ones", async () => {
    const j = (await R(evA, "operators")).json();
    const sup1 = j.rows.find((r: any) => r.userId === supUserId), o = j.rows.find((r: any) => r.userId === opUserId);
    expect(sup1).toMatchObject({ approved: 2, rejected: 1, hidden: 1, deleted: 0, cancelled: 1, printApproved: 0, total: 5 });        // 2 pictures approved by ONE bulk click; rejecting g3 cancelled its job
    expect(o).toMatchObject({ approved: 0, printApproved: 1, retried: 1, cancelled: 1, reprintsRequested: 1, held: 0, total: 4 });
    expect(j.rows.every((r: any) => r.userId !== null)).toBe(true); expect(j.note).toMatch(/not attributed/);
    expect(o.name).toBe("op16"); expect(o.firstAt).not.toBeNull();
    expect(j.rows[0].total).toBeGreaterThanOrEqual(j.rows[1].total);                                                                 // busiest first
  });
});

describe("days and time zones", () => {
  beforeAll(async () => {
    const ins = async (code: string, at: string) => pool.query("INSERT INTO guest_sessions(event_id,guest_code,created_at) VALUES ($1,$2,$3)", [evB, code, at]);
    await ins("GTZ001", "2026-03-10T23:30:00Z"); await ins("GTZ002", "2026-03-11T00:30:00Z"); await ins("GTZ003", "2026-03-13T12:00:00Z");
    const qr = (await pool.query("SELECT id FROM qr_tracking WHERE event_id=$1 LIMIT 1", [evB])).rows[0].id;
    await pool.query("INSERT INTO qr_scan_events(event_id,qr_id,at) VALUES ($1,$2,'2026-03-10T23:59:00Z'),($1,$2,'2026-03-11T00:01:00Z')", [evB, qr]);
  });
  const day = (j: any, d: string) => j.rows.find((r: any) => r.day === d);
  it("a calendar day belongs to the chosen time zone", async () => {
    const utc = (await R(evB, "daily", "?from=2026-03-09&to=2026-03-13&tz=UTC")).json();
    expect(utc.rows.map((r: any) => r.day)).toEqual(["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13"]);
    expect([day(utc, "2026-03-10").sessions, day(utc, "2026-03-11").sessions, day(utc, "2026-03-13").sessions]).toEqual([1, 1, 1]);
    expect([day(utc, "2026-03-10").scans, day(utc, "2026-03-11").scans]).toEqual([1, 1]);
    const ist = (await R(evB, "daily", "?from=2026-03-09&to=2026-03-13&tz=Asia/Kolkata")).json();          // UTC+5:30: both late-night visitors are on the 11th
    expect([day(ist, "2026-03-10").sessions, day(ist, "2026-03-11").sessions]).toEqual([0, 2]);
    expect([day(ist, "2026-03-10").scans, day(ist, "2026-03-11").scans]).toEqual([0, 2]);
    const la = (await R(evB, "daily", "?from=2026-03-09&to=2026-03-13&tz=America/Los_Angeles")).json();       // UTC-7: both are on the 10th
    expect([day(la, "2026-03-10").sessions, day(la, "2026-03-11").sessions]).toEqual([2, 0]);
  });
  it("the range is inclusive of both days and empty days are listed with zeros", async () => {
    const one = (await R(evB, "daily", "?from=2026-03-10&to=2026-03-10")).json();
    expect(one.rows).toHaveLength(1); expect(one.rows[0]).toMatchObject({ day: "2026-03-10", sessions: 1, scans: 1 });
    const s = (await R(evB, "summary", "?from=2026-03-10&to=2026-03-11")).json().totals; expect(s).toMatchObject({ sessions: 2, scans: 2 });
    const empty = (await R(evB, "daily", "?from=2026-03-12&to=2026-03-12")).json(); expect(empty.rows[0].sessions).toBe(0);
    expect((await R(evB, "summary", "?from=2026-03-11")).json().totals.sessions).toBe(2);                    // open end
    expect((await R(evB, "summary", "?to=2026-03-10")).json().totals.sessions).toBe(1);                      // open start
  });
  it("without dates the daily report covers the last 30 days at most, ending today, never before the event existed", async () => {
    const j = (await R(evA, "daily")).json();
    const today = new Date().toISOString().slice(0, 10);
    expect(j.rows.at(-1).day).toBe(today); expect(j.rows.length).toBeLessThanOrEqual(30);
    expect(j.rows.reduce((n: number, r: any) => n + r.completed, 0)).toBe(6);
  });
  it("the default start is the first recorded activity when that is more recent than 30 days", async () => {
    const c = await mkEvent("Report Fresh");
    const d3 = new Date(Date.now() - 3 * 86400000).toISOString();
    await pool.query("INSERT INTO guest_sessions(event_id,guest_code,created_at) VALUES ($1,'GFR001',$2)", [c.id, d3]);
    await pool.query("UPDATE events SET created_at=$2 WHERE id=$1", [c.id, new Date(Date.now() - 20 * 86400000).toISOString()]);   // event made earlier than its first guest
    const j = (await R(c.id, "daily")).json();
    expect(j.rows[0].day).toBe(new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10));                       // never later than the event itself
    await pool.query("UPDATE events SET created_at=now() WHERE id=$1", [c.id]);
    await pool.query("UPDATE guest_sessions SET created_at=$2 WHERE event_id=$1", [c.id, new Date(Date.now() - 5 * 86400000).toISOString()]);
    await pool.query("UPDATE events SET created_at=$2 WHERE id=$1", [c.id, new Date(Date.now() - 1 * 86400000).toISOString()]);
    const k = (await R(c.id, "daily")).json();
    expect(k.rows[0].day).toBe(new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10));                         // activity recorded before the event row: start there
    expect(k.rows.find((r: any) => r.sessions === 1)).toBeTruthy();
  });
  it("daily rows add up to the event totals for the same days", async () => {
    const rows = (await R(evA, "daily", `?from=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`)).json().rows;
    const sum = (k: string) => rows.reduce((n: number, r: any) => n + r[k], 0);
    expect([sum("scans"), sum("sessions"), sum("uploads"), sum("frameSelections"), sum("completed"), sum("shareAttempts"), sum("downloads"), sum("printJobs"), sum("reprints"), sum("printed"), sum("failedAttempts")])
      .toEqual([3, 8, 7, 7, 6, 3, 2, 6, 1, 2, 1]);
  });
});

describe("csv", () => {
  it("every report downloads as CSV with a BOM, a header and an audit entry", async () => {
    for (const name of ["summary", "daily", "frames", "operators", "printers", "submissions"]) {
      const r = await call(viewer, "GET", `/api/v1/events/${evA}/reports/${name}/csv`);
      expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(r.headers["content-disposition"]).toBe(`attachment; filename="event-${evA.slice(0, 8)}-${name}.csv"`);
      expect(r.body.startsWith("﻿")).toBe(true); expect(r.body.endsWith("\r\n")).toBe(true);
    }
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='report_export' AND event_id=$1", [evA])).rowCount).toBeGreaterThanOrEqual(6);
  });
  it("the summary CSV matches the screen, line by line", async () => {
    const lines = (await call(sup, "GET", `/api/v1/events/${evA}/reports/summary/csv`)).body.replace("﻿", "").split("\r\n");
    expect(lines[0]).toBe("Metric,Value"); expect(lines).toContain("Guests (unique sessions),8"); expect(lines).toContain("Completed pictures,6"); expect(lines).toContain("Prints completed,2");
    expect(lines).toContain("Guest journey: Shared or downloaded,2");
  });
  it("submissions list every finished picture with its own counts, without contact details", async () => {
    const r = await call(sup, "GET", `/api/v1/events/${evA}/reports/submissions/csv`);
    const lines = r.body.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Guest ID,Created,Finished,Frame,Moderation,Print jobs,Printed,Share attempts,Downloads,Wall appearances");
    expect(lines).toHaveLength(7);                                                         // header + 6 finished pictures
    expect(r.body).not.toMatch(/@t\.test|fields/);
    const g1 = lines.find((l) => l.includes(",Classic,approved,"))!; expect(g1.split(",").slice(5)).toEqual(["2", "1", "2", "2", "5"]);     // two jobs (print + reprint), one printed, 2 shares (instagram + whatsapp), 2 downloads, 5 wall views
  });
  it("text a spreadsheet would run as a formula is neutralised", async () => {
    await call(sup, "PUT", `/api/v1/events/${evA}/frames/${f1}`, { ...(await call(sup, "GET", `/api/v1/events/${evA}/frames/${f1}`)).json().frame, name: "=HYPERLINK(\"http://evil\")" });
    await pool.query("UPDATE users SET name='+cmd|calc' WHERE id=$1", [opUserId]);
    const frames = (await call(sup, "GET", `/api/v1/events/${evA}/reports/frames/csv`)).body;
    expect(frames).toContain("\"'=HYPERLINK(\"\"http://evil\"\")\""); expect(frames).not.toMatch(/\r\n=HYPERLINK/);
    const ops = (await call(sup, "GET", `/api/v1/events/${evA}/reports/operators/csv`)).body; expect(ops).toContain("'+cmd|calc");
    await call(sup, "PUT", `/api/v1/events/${evA}/frames/${f1}`, { ...(await call(sup, "GET", `/api/v1/events/${evA}/frames/${f1}`)).json().frame, name: "Classic" });
    await pool.query("UPDATE users SET name='op16' WHERE id=$1", [opUserId]);
  });
  it("respects the date range", async () => {
    const lines = (await call(sup, "GET", `/api/v1/events/${evA}/reports/daily/csv?from=2020-01-01&to=2020-01-03`)).body.replace("﻿", "").trim().split("\r\n");
    expect(lines).toHaveLength(4); expect(lines[1]).toBe("2020-01-01,0,0,0,0,0,0,0,0,0,0,0,0");
  });
});

describe("pdf", () => {
  it("is a real multi-section PDF with the event's numbers in it", async () => {
    const r = await call(viewer, "GET", `/api/v1/events/${evA}/reports/pdf`);
    expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="event-${evA.slice(0, 8)}-report.pdf"`);
    const pdf = r.rawPayload; expect(pdf.subarray(0, 5).toString()).toBe("%PDF-"); expect(pdf.subarray(-6).toString()).toMatch(/%%EOF/);
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
    const text = decodePdfText(pdf);
    for (const s of ["Report Gala", "Summary", "Guest journey", "Daily activity", "Frame popularity", "Printers", "Operators", "Printer One", "Classic", "Gold", "Guests (unique sessions)", "Page 1 of"]) expect(text).toContain(s);
    expect(text).toMatch(/Guests started/); expect(text).toMatch(/Share attempts are taps/);
  });
  it("prints characters its built-in font cannot draw as a question mark instead of failing", async () => {
    await call(sup, "PATCH", `/api/v1/events/${evA}`, { name: "Gala 你好 é" });
    const r = await call(sup, "GET", `/api/v1/events/${evA}/reports/pdf`);
    expect(r.statusCode).toBe(200); const text = decodePdfText(r.rawPayload);
    expect(text).toContain("Gala ?? é");
    await call(sup, "PATCH", `/api/v1/events/${evA}`, { name: "Report Gala" });
  });
  it("accepts the same range and time zone as the screen", async () => {
    const r = await call(sup, "GET", `/api/v1/events/${evB}/reports/pdf?from=2026-03-09&to=2026-03-13&tz=Asia/Kolkata`);
    expect(r.statusCode).toBe(200); expect(decodePdfText(r.rawPayload)).toContain("2026-03-09");
    expect((await call(sup, "GET", `/api/v1/events/${evB}/reports/pdf?tz=Mars/Phobos`)).statusCode).toBe(400);
  });
});

describe("across events", () => {
  it("the administrator sees every event, others only their own with report access", async () => {
    const all = (await call(sup, "GET", "/api/v1/reports/events")).json().events;
    const a = all.find((e: any) => e.eventId === evA), b = all.find((e: any) => e.eventId === evB);
    expect(a).toMatchObject({ name: "Report Gala", sessions: 8, completed: 6, printed: 2, failedAttempts: 1, shareAttempts: 3, downloads: 2, scans: 3 });
    expect(b).toMatchObject({ sessions: 3, scans: 2 });
    const mine = (await call(viewer, "GET", "/api/v1/reports/events")).json().events; expect(mine.map((e: any) => e.eventId)).toEqual([evA]);
    expect((await call(opOnly, "GET", "/api/v1/reports/events")).json().events).toEqual([]);                    // an operator has no report access anywhere
    expect((await call(null, "GET", "/api/v1/reports/events")).statusCode).toBe(401);
    const ranged = (await call(sup, "GET", "/api/v1/reports/events?from=2026-03-10&to=2026-03-10")).json().events.find((e: any) => e.eventId === evB); expect(ranged.sessions).toBe(1);
  });
  it("the dashboard activity is daily, zero-filled, and limited to the events the person may see", async () => {
    const j = (await call(viewer, "GET", "/api/v1/dashboard/activity?days=7")).json();                         // scoped to this event only
    expect(j.days).toHaveLength(7); expect(j.days.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10), completed: 6, printed: 2 });
    expect(j.days.slice(0, 6).every((d: any) => d.completed === 0 && d.printed === 0)).toBe(true);
    const all = (await call(sup, "GET", "/api/v1/dashboard/activity?days=7")).json().days.at(-1);                 // the administrator sees everything (other suites share this database)
    expect(all.completed).toBeGreaterThanOrEqual(6); expect(all.printed).toBeGreaterThanOrEqual(2);
    expect((await call(outsiderMgr, "GET", "/api/v1/dashboard/activity?days=7")).json().days.at(-1)).toMatchObject({ completed: 0, printed: 0 });
    expect((await call(sup, "GET", "/api/v1/dashboard/activity?days=0")).statusCode).toBe(400);
    expect((await call(sup, "GET", "/api/v1/dashboard/activity?tz=Mars/Phobos")).statusCode).toBe(400);
  });
});
