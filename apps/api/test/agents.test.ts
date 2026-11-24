import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { requeueAllStale } from "../src/printService";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-ag-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, op: S, mgr: S, opB: S; let ev: { id: string; guestToken: string }, evB: { id: string; guestToken: string }; let frame46: string, frame26: string;
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id", [email, await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S | null, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {} });
const G = (t: string) => `/api/v1/public/g/${t}`;
async function mkEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return e as { id: string; guestToken: string };
}
const mkFrame = async (e: string, fmt: string, name = fmt) => (await adm(sup, "POST", `/api/v1/events/${e}/frames`, { name, format: fmt, layers: presetLayers("single", fmt === "2x6" ? 600 : 1200, 1800) })).json().frame.id as string;
const jpeg = (c: string) => sharp({ create: { width: 1500, height: 2250, channels: 3, background: c } }).jpeg().toBuffer();
/** A guest finishes a picture on `frame`; returns the (approved) job id. */
async function approvedJob(e: { id: string; guestToken: string }, frame: string, colour = "#336699") {
  const sid = (await app.inject({ method: "POST", url: `${G(e.guestToken)}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
  const up = (await app.inject({ method: "POST", url: `${G(e.guestToken)}/photo`, payload: await jpeg(colour), headers: { "content-type": "application/octet-stream", "x-guest-session": sid } })).json().uploadId;
  const cid = (await app.inject({ method: "POST", url: `${G(e.guestToken)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
  await app.inject({ method: "POST", url: `${G(e.guestToken)}/composition/${cid}/finalize`, headers: { "x-guest-session": sid } });
  const job = (await pool.query("SELECT id FROM print_jobs WHERE composition_id=$1", [cid])).rows[0].id as string;
  await adm(sup, "POST", `/api/v1/events/${e.id}/print/jobs/${job}/action`, { action: "approve" });
  return { job, cid };
}

/** A paired agent: returns its token and ids. */
async function pairAgent(e: { id: string }, name = "Print desk PC") {
  const c = (await adm(sup, "POST", `/api/v1/events/${e.id}/agents`, { name })).json();
  const r = await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: c.pairingCode, hostName: "DESK-PC", version: "1.0.0" } });
  expect(r.statusCode).toBe(201);
  return { token: r.json().deviceToken as string, deviceId: c.deviceId as string };
}
const ag = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
const beat = (token: string, printers: object[] = [{ name: "DNP DS620", state: "ready", paperSizes: ["4x6", "5x7", "6x8"] }]) =>
  ag(token, "POST", "/api/v1/agent/heartbeat", { version: "1.0.0", hostName: "DESK-PC", printers });
const printerId = async (deviceId: string, name: string) => (await pool.query("SELECT id FROM printers WHERE device_id=$1 AND windows_name=$2", [deviceId, name])).rows[0].id as string;
async function enable(e: { id: string }, deviceId: string, name: string, paper = "4x6") {
  const r = await adm(sup, "PATCH", `/api/v1/events/${e.id}/printers/${await printerId(deviceId, name)}`, { enabled: true, paperSize: paper });
  expect(r.statusCode).toBe(200);
}
const status = async (job: string) => (await pool.query("SELECT status FROM print_jobs WHERE id=$1", [job])).rows[0]?.status as string;
const drain = (e: string) => pool.query("UPDATE print_jobs SET status='cancelled' WHERE event_id=$1 AND status IN ('approved','printing')", [e]);

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup11@t.test", "super_admin");
  ev = await mkEvent("Agent A"); evB = await mkEvent("Agent B");
  frame46 = await mkFrame(ev.id, "4x6"); frame26 = await mkFrame(ev.id, "2x6");
  op = await mkUser("op11@t.test", "print_operator", ev.id, "print_operator");
  mgr = await mkUser("mgr11@t.test", "event_manager", ev.id, "event_manager");
  opB = await mkUser("opb11@t.test", "print_operator", evB.id, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("pairing", () => {
  it("issues a one-time code, stores only its hash, and exchanges it for a device credential stored hashed", async () => {
    const c = (await adm(mgr, "POST", `/api/v1/events/${ev.id}/agents`, { name: "Pairing test" })).json();
    expect(c.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/); expect(c.expiresInMinutes).toBe(30);
    const row = (await pool.query("SELECT pairing_hash,token_hash,paired_at FROM devices WHERE id=$1", [c.deviceId])).rows[0];
    expect(row.pairing_hash).toBe(sha(c.pairingCode.replace("-", ""))); expect(row.paired_at).toBeNull();
    const r = await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: c.pairingCode.toLowerCase().replace("-", " "), hostName: "PC1", version: "1.0.0" } });   // forgiving of case and punctuation
    expect(r.statusCode).toBe(201);
    const j = r.json(); expect(j.deviceToken).toMatch(/^agt_[A-Za-z0-9_-]{40,}$/); expect(j).toMatchObject({ deviceId: c.deviceId, eventId: ev.id, eventName: "Agent A" });
    const after = (await pool.query("SELECT pairing_hash,token_hash,paired_at,host_name FROM devices WHERE id=$1", [c.deviceId])).rows[0];
    expect(after.pairing_hash).toBeNull(); expect(after.token_hash).toBe(sha(j.deviceToken)); expect(after.token_hash).not.toContain(j.deviceToken); expect(after.paired_at).toBeTruthy(); expect(after.host_name).toBe("PC1");
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: c.pairingCode } })).statusCode).toBe(401);   // single use
  });
  it("rejects wrong and expired codes with the same answer, and refuses staff without permission", async () => {
    const c = (await adm(sup, "POST", `/api/v1/events/${ev.id}/agents`, { name: "Expiry test" })).json();
    await pool.query("UPDATE devices SET pairing_expires_at = now() - interval '1 minute' WHERE id=$1", [c.deviceId]);
    const a = await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: c.pairingCode } });
    const b = await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: "ZZZZ-ZZZZ" } });
    expect(a.statusCode).toBe(401); expect(b.statusCode).toBe(401); expect(a.json()).toEqual(b.json());
    expect((await adm(op, "POST", `/api/v1/events/${ev.id}/agents`, { name: "x" })).statusCode).toBe(403);
    expect((await adm(opB, "POST", `/api/v1/events/${ev.id}/agents`, { name: "x" })).statusCode).toBe(403);
    expect((await adm(null, "POST", `/api/v1/events/${ev.id}/agents`, { name: "x" })).statusCode).toBe(401);
  });
  it("limits how fast codes can be guessed", async () => {
    const { config } = await import("../src/config");
    const before = config.agentRegisterLimitPerMin; config.agentRegisterLimitPerMin = 3;
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: "GUESS-" + i + "ABC" }, remoteAddress: "10.9.9.9" })).statusCode);
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]); expect(codes.slice(3).every((c) => c === 429)).toBe(true);
    } finally { config.agentRegisterLimitPerMin = before; }
  });
  it("an unpaired device cannot use its placeholder credential", async () => {
    const c = (await adm(sup, "POST", `/api/v1/events/${ev.id}/agents`, { name: "Never paired" })).json();
    const tok = (await pool.query("SELECT token_hash FROM devices WHERE id=$1", [c.deviceId])).rows[0].token_hash;
    expect((await ag("agt_" + tok.slice(0, 43), "POST", "/api/v1/agent/heartbeat", { printers: [] })).statusCode).toBe(401);
  });
});

describe("device credential", () => {
  let a: Awaited<ReturnType<typeof pairAgent>>;
  beforeAll(async () => { a = await pairAgent(ev, "Credential test"); });
  it("is required, checked, and revocable", async () => {
    expect((await ag(null, "POST", "/api/v1/agent/heartbeat", { printers: [] })).statusCode).toBe(401);
    expect((await ag("agt_wrongwrongwrongwrongwrongwrongwrong", "POST", "/api/v1/agent/heartbeat", { printers: [] })).statusCode).toBe(401);
    expect((await ag("not-a-token", "POST", "/api/v1/agent/heartbeat", { printers: [] })).statusCode).toBe(401);
    expect((await beat(a.token)).statusCode).toBe(200);
    await adm(sup, "PATCH", `/api/v1/events/${ev.id}/agents/${a.deviceId}`, { enabled: false });
    expect((await beat(a.token)).statusCode).toBe(401);                                       // disabled: stops at once
    await adm(sup, "PATCH", `/api/v1/events/${ev.id}/agents/${a.deviceId}`, { enabled: true });
    expect((await beat(a.token)).statusCode).toBe(200);
    const re = (await adm(sup, "POST", `/api/v1/events/${ev.id}/agents/${a.deviceId}/pairing`)).json();
    expect((await beat(a.token)).statusCode).toBe(401);                                       // re-pairing kills the old credential
    const again = await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: re.pairingCode } });
    expect(again.statusCode).toBe(201); expect(again.json().deviceToken).not.toBe(a.token);
    a.token = again.json().deviceToken; expect((await beat(a.token)).statusCode).toBe(200);
  });
});

describe("heartbeat and printer set-up", () => {
  it("records printers (disabled until an admin sets them up), paper sizes and online status", async () => {
    const a = await pairAgent(ev, "Heartbeat test");
    const r = await beat(a.token, [{ name: "DNP DS620", state: "ready", paperSizes: ["4x6", "6x8"] }, { name: "Microsoft Print to PDF", state: "ready", paperSizes: ["A4"] }]);
    expect(r.json()).toMatchObject({ ok: true, event: { name: "Agent A" }, queuePaused: false, pollSeconds: 2 });
    expect(r.json().printers).toEqual(expect.arrayContaining([{ name: "DNP DS620", enabled: false, paperSize: "any", orientation: "auto" }]));
    const list = (await adm(op, "GET", `/api/v1/events/${ev.id}/agents`)).json().agents.find((x: any) => x.id === a.deviceId);
    expect(list).toMatchObject({ online: true, paired: true, version: "1.0.0", hostName: "DESK-PC" });
    expect(list.printers.map((p: any) => p.name).sort()).toEqual(["DNP DS620", "Microsoft Print to PDF"]);
    expect(list.printers.find((p: any) => p.name === "DNP DS620").driverPapers).toEqual(["4x6", "6x8"]);
    // a printer that disappears is flagged, not silently kept "ready"
    await beat(a.token, [{ name: "DNP DS620", state: "offline", detail: "Paper out", paperSizes: [] }]);
    const l2 = (await adm(op, "GET", `/api/v1/events/${ev.id}/agents`)).json().agents.find((x: any) => x.id === a.deviceId);
    expect(l2.printers.find((p: any) => p.name === "Microsoft Print to PDF")).toMatchObject({ status: "missing" });
    expect(l2.printers.find((p: any) => p.name === "DNP DS620")).toMatchObject({ status: "offline", detail: "Paper out" });
  });
  it("accepts what real Windows drivers send: null details and long paper names", async () => {
    const a = await pairAgent(ev, "Real driver shape");
    const long = "A very long driver paper name ".repeat(8) + "(8.27x11.69 in)";
    const r = await beat(a.token, [{ name: "EPSON L8050 Series", state: "ready", detail: null, paperSizes: [long, "10 x 15 cm (4 x 6 in) (4x6 in)"] }]);
    expect(r.statusCode).toBe(200);
    const p = (await adm(op, "GET", `/api/v1/events/${ev.id}/agents`)).json().agents.find((x: any) => x.id === a.deviceId).printers[0];
    expect(p.detail).toBeNull(); expect(p.driverPapers[0].length).toBe(120); expect(p.driverPapers[1]).toBe("10 x 15 cm (4 x 6 in) (4x6 in)");
    expect((await beat(a.token, [{ name: "x", state: "melting", paperSizes: [] }])).statusCode).toBe(400);          // unknown states are still refused
  });
  it("shows offline when the agent has not been heard from", async () => {
    const a = await pairAgent(ev, "Offline test"); await beat(a.token);
    await pool.query("UPDATE devices SET last_seen_at = now() - interval '5 minutes' WHERE id=$1", [a.deviceId]);
    expect((await adm(op, "GET", `/api/v1/events/${ev.id}/agents`)).json().agents.find((x: any) => x.id === a.deviceId).online).toBe(false);
    const summary = (await adm(op, "GET", `/api/v1/events/${ev.id}/print/jobs`)).json().agents.find((x: any) => x.id === a.deviceId);
    expect(summary).toMatchObject({ online: false, name: "Offline test" });
  });
  it("only managers configure printers, and never enable one with unknown paper", async () => {
    const a = await pairAgent(ev, "Config test"); await beat(a.token);
    const id = await printerId(a.deviceId, "DNP DS620"); const url = `/api/v1/events/${ev.id}/printers/${id}`;
    expect((await adm(sup, "PATCH", url, { enabled: true })).json()).toMatchObject({ error: "paper_size_required" });
    expect((await adm(sup, "PATCH", url, { paperSize: "13x19" })).statusCode).toBe(400);
    expect((await adm(op, "PATCH", url, { enabled: true, paperSize: "4x6" })).statusCode).toBe(403);
    expect((await adm(opB, "PATCH", url, { enabled: true, paperSize: "4x6" })).statusCode).toBe(403);
    expect((await adm(mgr, "PATCH", url, { enabled: true, paperSize: "4x6", orientation: "portrait", label: "Photo printer 1" })).statusCode).toBe(200);
    expect((await pool.query("SELECT enabled,paper_size,orientation,name FROM printers WHERE id=$1", [id])).rows[0]).toEqual({ enabled: true, paper_size: "4x6", orientation: "portrait", name: "Photo printer 1" });
    expect((await adm(mgr, "PATCH", `/api/v1/events/${evB.id}/printers/${id}`, { enabled: false })).statusCode).toBe(403);
    expect((await adm(sup, "PATCH", `/api/v1/events/${evB.id}/printers/${id}`, { enabled: false })).statusCode).toBe(404);     // right event URL, other event's printer
  });
});

describe("claiming, downloading and reporting", () => {
  let a: Awaited<ReturnType<typeof pairAgent>>; const P = "DNP DS620";
  beforeAll(async () => { a = await pairAgent(ev, "Claim test"); await beat(a.token); await enable(ev, a.deviceId, P, "4x6"); });

  it("gives nothing for unknown or disabled printers and while the queue is paused", async () => {
    expect((await ag(a.token, "POST", "/api/v1/agent/claim", { printer: "Nope" })).statusCode).toBe(404);
    await beat(a.token, [{ name: P, state: "ready", paperSizes: [] }, { name: "Other", state: "ready", paperSizes: [] }]);
    expect((await ag(a.token, "POST", "/api/v1/agent/claim", { printer: "Other" })).json()).toEqual({ job: null, reason: "printer_disabled" });
    await drain(ev.id); const j = await approvedJob(ev, frame46);
    await adm(op, "POST", `/api/v1/events/${ev.id}/print/queue`, { paused: true });
    expect((await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json()).toEqual({ job: null });
    await adm(op, "POST", `/api/v1/events/${ev.id}/print/queue`, { paused: false });
    expect(await status(j.job)).toBe("approved");
  });
  it("hands out the oldest job that fits the paper, with the exact image to print", async () => {
    await drain(ev.id);
    const strip = await approvedJob(ev, frame26);              // oldest, but on a 2x6 frame: this printer holds 4x6
    const j1 = await approvedJob(ev, frame46, "#aa3333"), j2 = await approvedJob(ev, frame46, "#33aa33");
    const claim = (await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job;
    expect(claim).toMatchObject({ id: j1.job, copies: 1, attempt: 1, format: "4x6", paperSize: "4x6", orientation: "portrait", widthPx: 1200, heightPx: 1800 });
    expect(claim.sha256).toMatch(/^[0-9a-f]{64}$/); expect(claim.guestCode).toMatch(/^G/);
    expect(await status(strip.job)).toBe("approved");           // left for a printer that holds strips
    expect((await pool.query("SELECT printer_id FROM print_jobs WHERE id=$1", [j1.job])).rows[0].printer_id).toBe(await printerId(a.deviceId, P));
    const img = await ag(a.token, "GET", claim.imageUrl);
    expect(img.statusCode).toBe(200); expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(sha(img.rawPayload)).toBe(claim.sha256); expect(img.headers["x-content-sha256"]).toBe(claim.sha256); expect(img.rawPayload.length).toBe(claim.bytes);
    const m = await sharp(img.rawPayload).metadata(); expect([m.width, m.height, m.density]).toEqual([1200, 1800, 300]);
    expect((await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job.id).toBe(j2.job);
    await ag(a.token, "POST", `/api/v1/agent/jobs/${j1.job}/result`, { ok: true }); await ag(a.token, "POST", `/api/v1/agent/jobs/${j2.job}/result`, { ok: true });
    await drain(ev.id);
  });
  it("another device, or a job that is not being printed, cannot download the image", async () => {
    await drain(ev.id); const j = await approvedJob(ev, frame46);
    const other = await pairAgent(ev, "Other PC"); await beat(other.token);
    const claim = (await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job;
    expect(claim.id).toBe(j.job);
    expect((await ag(other.token, "GET", claim.imageUrl)).statusCode).toBe(404);
    expect((await ag(null, "GET", claim.imageUrl)).statusCode).toBe(401);
    await ag(a.token, "POST", `/api/v1/agent/jobs/${j.job}/result`, { ok: true });
    expect((await ag(a.token, "GET", claim.imageUrl)).statusCode).toBe(404);                   // finished: no longer downloadable
    expect((await ag(a.token, "GET", "/api/v1/agent/jobs/not-a-uuid/image")).statusCode).toBe(404);
  });
  it("reports success and failure; repeating a report is harmless; contradicting it is refused", async () => {
    await drain(ev.id); const j = await approvedJob(ev, frame46);
    const claim = (await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job;
    const R = (b: object) => ag(a.token, "POST", `/api/v1/agent/jobs/${claim.id}/result`, b);
    expect((await R({ ok: false, error: "Out of paper" })).json()).toMatchObject({ ok: true, status: "failed" });
    expect((await R({ ok: false, error: "Out of paper" })).json()).toMatchObject({ duplicate: true });
    expect((await R({ ok: true })).json()).toMatchObject({ error: "invalid_state", status: "failed" });
    expect((await pool.query("SELECT status,error FROM print_jobs WHERE id=$1", [j.job])).rows[0]).toEqual({ status: "failed", error: "Out of paper" });
    await adm(op, "POST", `/api/v1/events/${ev.id}/print/jobs/${j.job}/action`, { action: "retry" });
    const again = (await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job; expect(again).toMatchObject({ id: j.job, attempt: 2 });
    expect((await R({ ok: true, error: null, copiesPrinted: null })).json()).toMatchObject({ ok: true, status: "printed" });     // the agent sends nulls on success
    expect((await R({ ok: true })).json()).toMatchObject({ duplicate: true });
    expect((await ag(a.token, "POST", `/api/v1/agent/jobs/${claim.id}/result`, { ok: "yes" })).statusCode).toBe(400);
  });
  it("a late success report after the server gave up still counts, so the picture is not printed twice", async () => {
    await drain(ev.id); const j = await approvedJob(ev, frame46);
    const claim = (await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job;
    await pool.query("UPDATE print_jobs SET started_at = now() - interval '10 minutes' WHERE id=$1", [j.job]);
    expect(await requeueAllStale(pool, 300)).toBeGreaterThanOrEqual(1);
    expect(await status(j.job)).toBe("approved");                                               // back in the queue
    const late = await ag(a.token, "POST", `/api/v1/agent/jobs/${claim.id}/result`, { ok: true });
    expect(late.json()).toMatchObject({ ok: true, late: true, status: "printed" });
    expect(await status(j.job)).toBe("printed");
    expect((await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json()).toEqual({ job: null });      // nothing left to print twice
    // a late FAILURE is ignored: the job is already queued to try again
    const k = await approvedJob(ev, frame46); const c2 = (await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job;
    await pool.query("UPDATE print_jobs SET started_at = now() - interval '10 minutes' WHERE id=$1", [k.job]); await requeueAllStale(pool, 300);
    expect((await ag(a.token, "POST", `/api/v1/agent/jobs/${c2.id}/result`, { ok: false, error: "late" })).json()).toMatchObject({ ignored: true });
    expect(await status(k.job)).toBe("approved");
    await drain(ev.id);
  });
  it("progress pings keep a long print from being requeued", async () => {
    await drain(ev.id); const j = await approvedJob(ev, frame46);
    const claim = (await ag(a.token, "POST", "/api/v1/agent/claim", { printer: P })).json().job;
    await pool.query("UPDATE print_jobs SET started_at = now() - interval '10 minutes' WHERE id=$1", [j.job]);
    expect((await ag(a.token, "POST", `/api/v1/agent/jobs/${claim.id}/progress`)).statusCode).toBe(200);
    expect(await requeueAllStale(pool, 300)).toBe(0); expect(await status(j.job)).toBe("printing");
    await drain(ev.id);
  });
  it("one agent never touches another event's jobs", async () => {
    const b = await pairAgent(evB, "B agent"); await beat(b.token); await enable(evB, b.deviceId, "DNP DS620", "4x6");
    await drain(ev.id); const mine = await approvedJob(ev, frame46);
    expect((await ag(b.token, "POST", "/api/v1/agent/claim", { printer: "DNP DS620" })).json()).toEqual({ job: null });   // A's job is invisible to B
    expect((await ag(b.token, "POST", `/api/v1/agent/jobs/${mine.job}/result`, { ok: true })).statusCode).toBe(404);
    expect(await status(mine.job)).toBe("approved"); await drain(ev.id);
  });
});

describe("operators and removal", () => {
  it("the dashboard counts connected devices; deleting an agent removes it but keeps print history", async () => {
    const a = await pairAgent(ev, "Delete test"); await beat(a.token); await enable(ev, a.deviceId, "DNP DS620", "4x6");
    expect((await adm(sup, "GET", "/api/v1/dashboard/overview")).json().activeDevices).toBeGreaterThanOrEqual(1);
    await drain(ev.id); const j = await approvedJob(ev, frame46);
    await ag(a.token, "POST", "/api/v1/agent/claim", { printer: "DNP DS620" });
    expect((await adm(mgr, "DELETE", `/api/v1/events/${ev.id}/agents/${a.deviceId}`)).statusCode).toBe(200);
    expect((await beat(a.token)).statusCode).toBe(401);
    expect((await pool.query("SELECT 1 FROM printers WHERE device_id=$1", [a.deviceId])).rowCount).toBe(0);
    expect((await pool.query("SELECT status,printer_id FROM print_jobs WHERE id=$1", [j.job])).rows[0]).toEqual({ status: "printing", printer_id: null });
    expect((await adm(op, "DELETE", `/api/v1/events/${ev.id}/agents/${a.deviceId}`)).statusCode).toBe(403);
    expect((await adm(mgr, "DELETE", `/api/v1/events/${ev.id}/agents/${a.deviceId}`)).statusCode).toBe(404);
    await drain(ev.id);
  });
  it("audits pairing and configuration", async () => {
    const actions = (await pool.query("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'agent_%' OR action='printer_update'")).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["agent_create", "agent_paired", "agent_repair", "agent_delete", "printer_update"]));
  });
});
