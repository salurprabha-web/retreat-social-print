import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { claimNext, reportResult, requeueStale } from "../src/printService";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-pr-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, op: S, viewer: S, opB: S, mgrA: S; let evA: string, evB: string, tokA: string, tokB: string, frameA: string, frameB: string;
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$2,$3,$4) RETURNING id", [email, email.split("@")[0], await hashPassword(PW), role])).rows[0].id;
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
const setMode = (ev: string, mode: string) => adm(sup, "PATCH", `/api/v1/events/${ev}`, { settings: { printMode: mode } });
const jpeg = (c: string) => sharp({ create: { width: 1500, height: 2250, channels: 3, background: c } }).jpeg().toBuffer();

/** A guest who has composed (but not yet tapped Finish). */
async function compose(tok: string, frame: string, colour = "#336699") {
  const sid = (await app.inject({ method: "POST", url: `${G(tok)}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
  const up = (await app.inject({ method: "POST", url: `${G(tok)}/photo`, payload: await jpeg(colour), headers: { "content-type": "application/octet-stream", "x-guest-session": sid } })).json().uploadId;
  const cid = (await app.inject({ method: "POST", url: `${G(tok)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
  return { sid, cid };
}
const finalize = (tok: string, sid: string, cid: string) => app.inject({ method: "POST", url: `${G(tok)}/composition/${cid}/finalize`, headers: { "x-guest-session": sid } });
/** compose + finish -> returns the job id */
async function finished(tok: string, frame: string, ev: string, colour?: string) {
  const c = await compose(tok, frame, colour); const f = await finalize(tok, c.sid, c.cid);
  const job = (await pool.query("SELECT id FROM print_jobs WHERE composition_id=$1 AND event_id=$2", [c.cid, ev])).rows[0]?.id as string | undefined;
  return { ...c, job: job!, res: f };
}
const jobs = async (ev: string, qs = "", s = op) => (await adm(s, "GET", `/api/v1/events/${ev}/print/jobs${qs}`)).json();
const act = (ev: string, job: string, body: object, s = op) => adm(s, "POST", `/api/v1/events/${ev}/print/jobs/${job}/action`, body);
const status = async (job: string) => (await pool.query("SELECT status FROM print_jobs WHERE id=$1", [job])).rows[0]?.status as string;
/** Tests that act as the printer take the OLDEST approved job, so they clear the queue of leftovers first. */
const drain = (ev: string) => pool.query("UPDATE print_jobs SET status='cancelled' WHERE event_id=$1 AND status IN ('approved','printing')", [ev]);
const moderation = async (cid: string) => (await pool.query("SELECT moderation FROM final_compositions WHERE id=$1", [cid])).rows[0]?.moderation as string;

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup10@t.test", "super_admin");
  const a = await mkEvent("Print A"), b = await mkEvent("Print B");
  evA = a.id; tokA = a.guestToken; evB = b.id; tokB = b.guestToken;
  const mk = async (ev: string) => (await adm(sup, "POST", `/api/v1/events/${ev}/frames`, { name: "Single", format: "4x6", layers: presetLayers("single", 1200, 1800) })).json().frame.id as string;
  frameA = await mk(evA); frameB = await mk(evB);
  op = await mkUser("op10@t.test", "print_operator", evA, "print_operator");
  mgrA = await mkUser("mgr10@t.test", "event_manager", evA, "event_manager");
  viewer = await mkUser("view10@t.test", "reporting_viewer", evA, "reporting_viewer");
  opB = await mkUser("opb10@t.test", "print_operator", evB, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("finishing a picture creates the print job", () => {
  it("manual mode: waits for approval; nothing exists before the guest taps Finish", async () => {
    await setMode(evA, "manual");
    const c = await compose(tokA, frameA);
    expect((await pool.query("SELECT 1 FROM print_jobs WHERE composition_id=$1", [c.cid])).rowCount).toBe(0);     // still editing: not printable
    const r = await finalize(tokA, c.sid, c.cid);
    expect(r.statusCode).toBe(201); expect(r.json()).toMatchObject({ finalized: true, queued: true, status: "pending" });
    const j = (await pool.query("SELECT status,copies,kind,approved_at FROM print_jobs WHERE composition_id=$1", [c.cid])).rows[0];
    expect(j).toMatchObject({ status: "pending", copies: 1, kind: "print" }); expect(j.approved_at).toBeNull();
    expect(await moderation(c.cid)).toBe("pending");
  });
  it("automatic mode: approved straight away, and the picture counts as approved", async () => {
    await setMode(evA, "auto");
    const f = await finished(tokA, frameA, evA);
    expect(await status(f.job)).toBe("approved"); expect(await moderation(f.cid)).toBe("approved");
    expect((await pool.query("SELECT approved_at FROM print_jobs WHERE id=$1", [f.job])).rows[0].approved_at).toBeTruthy();
    await setMode(evA, "manual");
  });
  it("batch mode waits like manual; default copies come from the event settings", async () => {
    await setMode(evA, "batch"); await adm(sup, "PATCH", `/api/v1/events/${evA}`, { settings: { defaultCopies: 3 } });
    const f = await finished(tokA, frameA, evA);
    expect((await pool.query("SELECT status,copies FROM print_jobs WHERE id=$1", [f.job])).rows[0]).toEqual({ status: "pending", copies: 3 });
    await setMode(evA, "manual"); await adm(sup, "PATCH", `/api/v1/events/${evA}`, { settings: { defaultCopies: 1 } });
  });
  it("is idempotent, even when tapped repeatedly at once", async () => {
    const c = await compose(tokA, frameA);
    const rs = await Promise.all([1, 2, 3, 4].map(() => finalize(tokA, c.sid, c.cid)));
    expect(rs.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect((await pool.query("SELECT count(*)::int n FROM print_jobs WHERE composition_id=$1", [c.cid])).rows[0].n).toBe(1);
    expect((await finalize(tokA, c.sid, c.cid)).json()).toMatchObject({ queued: true, status: "pending" });
  });
  it("never queues a picture staff already rejected", async () => {
    const c = await compose(tokA, frameA);
    await pool.query("UPDATE final_compositions SET moderation='rejected' WHERE id=$1", [c.cid]);
    expect((await finalize(tokA, c.sid, c.cid)).json()).toMatchObject({ finalized: true, queued: false });
    expect((await pool.query("SELECT 1 FROM print_jobs WHERE composition_id=$1", [c.cid])).rowCount).toBe(0);
  });
  it("only the owner of the picture can finish it", async () => {
    const c = await compose(tokA, frameA); const other = (await compose(tokA, frameA)).sid;
    expect((await finalize(tokA, other, c.cid)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${G(tokA)}/composition/${c.cid}/finalize` })).statusCode).toBe(401);
    expect((await finalize(tokB, c.sid, c.cid)).statusCode).toBe(401);
  });
  it("the gallery can tell finished pictures from abandoned drafts", async () => {
    const c = await compose(tokA, frameA);
    const all = await adm(op, "GET", `/api/v1/events/${evA}/compositions?finalized=false&limit=100`);
    expect(all.json().compositions.map((x: any) => x.id)).toContain(c.cid);
    expect(all.json().compositions.every((x: any) => x.finalized === false)).toBe(true);
    await finalize(tokA, c.sid, c.cid);
    expect((await adm(op, "GET", `/api/v1/events/${evA}/compositions?finalized=false&limit=100`)).json().compositions.map((x: any) => x.id)).not.toContain(c.cid);
  });
});

describe("operator view", () => {
  it("lists jobs with counts, queue state and guest details, scoped to the event", async () => {
    const b = await finished(tokB, frameB, evB);
    const r = await jobs(evA);
    expect(r.queue).toEqual({ mode: "manual", paused: false, defaultCopies: 1 });
    expect(r.counts.pending).toBeGreaterThan(0); expect(Object.keys(r.counts).sort()).toEqual(["approved", "cancelled", "failed", "pending", "printed", "printing", "received", "reprint_requested"]);
    const first = r.jobs[0];
    expect(first).toMatchObject({ status: expect.any(String), copies: expect.any(Number), composition: { frameName: "Single", widthPx: 1200, heightPx: 1800 } });
    expect(first.composition.guestCode).toMatch(/^G/); expect(first.composition.uploadIds).toHaveLength(1);
    expect(r.jobs.map((j: any) => j.id)).not.toContain(b.job);
    expect((await jobs(evA, "?status=approved")).jobs.every((j: any) => j.status === "approved")).toBe(true);
    expect((await adm(op, "GET", `/api/v1/events/${evA}/print/jobs?status=nonsense`)).statusCode).toBe(400);
  });
  it("is for staff of this event only", async () => {
    expect((await adm(viewer, "GET", `/api/v1/events/${evA}/print/jobs`)).statusCode).toBe(403);
    expect((await adm(opB, "GET", `/api/v1/events/${evA}/print/jobs`)).statusCode).toBe(403);
    expect((await adm(null, "GET", `/api/v1/events/${evA}/print/jobs`)).statusCode).toBe(401);
    const b = await finished(tokB, frameB, evB);
    expect((await act(evA, b.job, { action: "approve" })).statusCode).toBe(404);          // B's job through A's URL
    expect((await act(evB, b.job, { action: "approve" }, op)).statusCode).toBe(403);
    expect(await status(b.job)).toBe("pending");
  });
});

describe("operator actions", () => {
  it("approve releases the job and approves the picture; history shows who", async () => {
    const f = await finished(tokA, frameA, evA);
    expect((await act(evA, f.job, { action: "approve" })).statusCode).toBe(200);
    expect(await status(f.job)).toBe("approved"); expect(await moderation(f.cid)).toBe("approved");
    const h = (await adm(op, "GET", `/api/v1/events/${evA}/print/history`)).json().history.filter((x: any) => x.jobId === f.job);
    expect(h[0]).toMatchObject({ from: "pending", to: "approved", by: "op10", guestCode: expect.any(String) });
    expect(h[h.length - 1]).toMatchObject({ from: null, to: "pending" });
  });
  it("reject cancels the job and rejects the picture with the reason", async () => {
    const f = await finished(tokA, frameA, evA);
    expect((await act(evA, f.job, { action: "reject", note: "eyes closed" })).statusCode).toBe(200);
    expect(await status(f.job)).toBe("cancelled"); expect(await moderation(f.cid)).toBe("rejected");
    expect((await pool.query("SELECT moderation_note FROM final_compositions WHERE id=$1", [f.cid])).rows[0].moderation_note).toBe("eyes closed");
  });
  it("cancel, hold and the refusal of impossible moves", async () => {
    const f = await finished(tokA, frameA, evA);
    await act(evA, f.job, { action: "approve" });
    expect((await act(evA, f.job, { action: "hold" })).statusCode).toBe(200); expect(await status(f.job)).toBe("pending");
    expect((await act(evA, f.job, { action: "hold" })).json()).toMatchObject({ error: "invalid_state", status: "pending" });
    expect((await act(evA, f.job, { action: "retry" })).statusCode).toBe(409);
    expect((await act(evA, f.job, { action: "cancel" })).statusCode).toBe(200);
    expect((await act(evA, f.job, { action: "approve" })).statusCode).toBe(409);                 // cancelled is final
    expect((await act(evA, "00000000-0000-4000-8000-000000000000", { action: "cancel" })).statusCode).toBe(404);
    expect((await act(evA, f.job, { action: "explode" })).statusCode).toBe(400);
  });
  it("changes copies only while the job can still change, within limits", async () => {
    const f = await finished(tokA, frameA, evA);
    expect((await act(evA, f.job, { action: "copies", copies: 4 })).statusCode).toBe(200);
    expect((await pool.query("SELECT copies FROM print_jobs WHERE id=$1", [f.job])).rows[0].copies).toBe(4);
    expect((await act(evA, f.job, { action: "copies", copies: 0 })).statusCode).toBe(400);
    expect((await act(evA, f.job, { action: "copies", copies: 51 })).statusCode).toBe(400);
    expect((await act(evA, f.job, { action: "copies" })).statusCode).toBe(400);
    await drain(evA); await act(evA, f.job, { action: "approve" }); await claimNext(pool, evA); await reportResult(pool, evA, f.job, true);
    expect((await act(evA, f.job, { action: "copies", copies: 2 })).json()).toMatchObject({ error: "invalid_state", status: "printed" });
  });
  it("bulk actions handle each job on its own and say what was skipped", async () => {
    const a = await finished(tokA, frameA, evA), b = await finished(tokA, frameA, evA), c = await finished(tokA, frameA, evA);
    await act(evA, c.job, { action: "cancel" });
    const r = await adm(op, "POST", `/api/v1/events/${evA}/print/jobs/bulk`, { ids: [a.job, b.job, c.job, "00000000-0000-4000-8000-000000000000"], action: "approve" });
    expect(r.json().done.sort()).toEqual([a.job, b.job].sort());
    expect(r.json().skipped).toEqual(expect.arrayContaining([{ id: c.job, reason: "invalid_state" }, { id: "00000000-0000-4000-8000-000000000000", reason: "not_found" }]));
    expect(await status(a.job)).toBe("approved"); expect(await status(c.job)).toBe("cancelled");
  });
});

describe("queue, printer hand-off and failures (simulated printer)", () => {
  it("prints oldest approved first, never pending ones, and not while paused", async () => {
    const ev = await mkEvent("Print Queue"); const fr = (await adm(sup, "POST", `/api/v1/events/${ev.id}/frames`, { name: "S", format: "4x6", layers: presetLayers("single", 1200, 1800) })).json().frame.id;
    const j1 = await finished(ev.guestToken, fr, ev.id), j2 = await finished(ev.guestToken, fr, ev.id), j3 = await finished(ev.guestToken, fr, ev.id);
    expect(await claimNext(pool, ev.id)).toBeNull();                                   // all pending
    await adm(sup, "POST", `/api/v1/events/${ev.id}/print/jobs/bulk`, { ids: [j2.job, j1.job], action: "approve" });   // j2 approved first
    await adm(sup, "POST", `/api/v1/events/${ev.id}/print/queue`, { paused: true });
    expect(await claimNext(pool, ev.id)).toBeNull();                                   // paused
    await adm(sup, "POST", `/api/v1/events/${ev.id}/print/queue`, { paused: false });
    const first = await claimNext(pool, ev.id);
    expect(first!.id).toBe(j2.job); expect(first!.attempt).toBe(1);
    expect((await claimNext(pool, ev.id))!.id).toBe(j1.job);
    expect(await claimNext(pool, ev.id)).toBeNull();                                   // j3 still pending
    expect(await status(j3.job)).toBe("pending");
  });
  it("two printers asking at once never get the same job", async () => {
    const ev = await mkEvent("Print Race"); const fr = (await adm(sup, "POST", `/api/v1/events/${ev.id}/frames`, { name: "S", format: "4x6", layers: presetLayers("single", 1200, 1800) })).json().frame.id;
    await setMode(ev.id, "auto");
    const made = await Promise.all([1, 2, 3, 4].map(() => finished(ev.guestToken, fr, ev.id)));
    const got = await Promise.all([1, 2, 3, 4, 5, 6].map(() => claimNext(pool, ev.id)));
    const ids = got.filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(4); expect(new Set(ids).size).toBe(4); expect(new Set(ids)).toEqual(new Set(made.map((m) => m.job)));
  });
  it("records success and failure; failed jobs can be retried; a job already printing cannot be cancelled", async () => {
    await drain(evA);
    const f = await finished(tokA, frameA, evA); await act(evA, f.job, { action: "approve" });
    const claimed = await claimNext(pool, evA); expect(claimed!.id).toBe(f.job);
    expect((await act(evA, f.job, { action: "cancel" })).json()).toMatchObject({ error: "invalid_state", status: "printing" });
    await reportResult(pool, evA, f.job, false, "Out of paper");
    expect((await pool.query("SELECT status,error,finished_at FROM print_jobs WHERE id=$1", [f.job])).rows[0]).toMatchObject({ status: "failed", error: "Out of paper" });
    expect((await jobs(evA, "?status=failed")).jobs.find((j: any) => j.id === f.job).error).toBe("Out of paper");
    expect((await act(evA, f.job, { action: "retry" })).statusCode).toBe(200);
    expect((await pool.query("SELECT status,error FROM print_jobs WHERE id=$1", [f.job])).rows[0]).toEqual({ status: "approved", error: null });
    const again = await claimNext(pool, evA); expect(again!.id).toBe(f.job); expect(again!.attempt).toBe(2);
    await reportResult(pool, evA, f.job, true);
    expect((await pool.query("SELECT status,finished_at FROM print_jobs WHERE id=$1", [f.job])).rows[0].status).toBe("printed");
    await expect(reportResult(pool, evA, f.job, true)).rejects.toMatchObject({ code: "invalid_state" });               // cannot report twice
    const hist = (await adm(op, "GET", `/api/v1/events/${evA}/print/history?limit=500`)).json().history.filter((h: any) => h.jobId === f.job).map((h: any) => h.to).reverse();
    expect(hist).toEqual(["pending", "approved", "printing", "failed", "approved", "printing", "printed"]);
  });
  it("puts a job back in the queue when the printer stops answering", async () => {
    await drain(evA);
    const f = await finished(tokA, frameA, evA); await act(evA, f.job, { action: "approve" }); await claimNext(pool, evA);
    expect(await requeueStale(pool, evA, 60)).toBe(0);
    await pool.query("UPDATE print_jobs SET started_at = now() - interval '5 minutes' WHERE id=$1", [f.job]);
    expect(await requeueStale(pool, evA, 60)).toBe(1);
    expect(await status(f.job)).toBe("approved");
  });
  it("does not print a picture that was rejected after approval", async () => {
    const ev = await mkEvent("Print Reject"); const fr = (await adm(sup, "POST", `/api/v1/events/${ev.id}/frames`, { name: "S", format: "4x6", layers: presetLayers("single", 1200, 1800) })).json().frame.id;
    await setMode(ev.id, "auto");
    const f = await finished(ev.guestToken, fr, ev.id);
    await pool.query("UPDATE final_compositions SET moderation='rejected' WHERE id=$1", [f.cid]);      // e.g. changed behind the job's back
    expect(await claimNext(pool, ev.id)).toBeNull();
  });
});

describe("reprints and duplicate protection", () => {
  async function printedJob() {
    await drain(evA);
    const f = await finished(tokA, frameA, evA); await act(evA, f.job, { action: "approve" });
    await claimNext(pool, evA); await reportResult(pool, evA, f.job, true); return f;
  }
  it("reprint creates a new approved job; the same tap twice makes only one", async () => {
    const f = await printedJob(); const requestId = randomUUID();
    const a = await act(evA, f.job, { action: "reprint", requestId, copies: 2 });
    expect(a.statusCode).toBe(201); expect(a.json()).toMatchObject({ created: true, job: { status: "approved" } });
    const b = await act(evA, f.job, { action: "reprint", requestId, copies: 2 });
    expect(b.statusCode).toBe(200); expect(b.json()).toMatchObject({ created: false, job: { id: a.json().job.id } });
    expect((await pool.query("SELECT count(*)::int n FROM print_jobs WHERE composition_id=$1", [f.cid])).rows[0].n).toBe(2);
    expect((await pool.query("SELECT kind,copies FROM print_jobs WHERE id=$1", [a.json().job.id])).rows[0]).toEqual({ kind: "reprint", copies: 2 });
  });
  it("a different tap while the first reprint is still waiting is refused", async () => {
    const f = await printedJob();
    expect((await act(evA, f.job, { action: "reprint", requestId: randomUUID() })).statusCode).toBe(201);
    expect((await act(evA, f.job, { action: "reprint", requestId: randomUUID() })).json()).toMatchObject({ error: "job_in_progress" });
    await claimNext(pool, evA); // take it
  });
  it("can be queued as a request that needs approval", async () => {
    const f = await printedJob();
    const r = await act(evA, f.job, { action: "reprint", requestId: randomUUID(), approveNow: false });
    expect(r.json().job.status).toBe("reprint_requested");
    expect((await jobs(evA, "?status=reprint_requested")).counts.reprint_requested).toBeGreaterThan(0);
    expect((await act(evA, r.json().job.id, { action: "approve" })).statusCode).toBe(200);
    expect(await status(r.json().job.id)).toBe("approved");
  });
  it("needs a finished job, a request id, and a picture that is not rejected", async () => {
    const f = await finished(tokA, frameA, evA);
    expect((await act(evA, f.job, { action: "reprint", requestId: randomUUID() })).json()).toMatchObject({ error: "invalid_state", status: "pending" });
    const p = await printedJob();
    expect((await act(evA, p.job, { action: "reprint" })).statusCode).toBe(400);
    await pool.query("UPDATE final_compositions SET moderation='rejected' WHERE id=$1", [p.cid]);
    expect((await act(evA, p.job, { action: "reprint", requestId: randomUUID() })).json()).toMatchObject({ error: "picture_rejected" });
  });
  it("rejecting or deleting a picture in the gallery takes its jobs with it", async () => {
    const f = await finished(tokA, frameA, evA);
    await adm(op, "POST", `/api/v1/events/${evA}/compositions/${f.cid}/moderation`, { status: "rejected" });
    expect(await status(f.job)).toBe("cancelled");
    const g = await finished(tokA, frameA, evA);
    await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [g.cid], action: "reject" });
    expect(await status(g.job)).toBe("cancelled");
    const h = await finished(tokA, frameA, evA);
    const blocked = await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [h.cid], action: "delete" });
    expect(blocked.json()).toMatchObject({ deleted: 0, blocked: [h.cid] });                            // a queued job protects the picture until confirmed
    await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [h.cid], action: "delete", confirmPrinted: true });
    expect(await status(h.job)).toBeUndefined();
    expect((await pool.query("SELECT 1 FROM print_job_events WHERE job_id=$1", [h.job])).rowCount).toBe(0);
  });
});

describe("queue control, mode and history", () => {
  it("pause and resume are recorded", async () => {
    expect((await adm(op, "POST", `/api/v1/events/${evA}/print/queue`, { paused: true })).json().queue.paused).toBe(true);
    expect((await jobs(evA)).queue.paused).toBe(true);
    await adm(op, "POST", `/api/v1/events/${evA}/print/queue`, { paused: false });
    const q = (await adm(op, "GET", `/api/v1/events/${evA}/print/history`)).json().queueEvents.map((e: any) => e.action);
    expect(q).toEqual(expect.arrayContaining(["print_pause", "print_resume"]));
    expect((await adm(viewer, "POST", `/api/v1/events/${evA}/print/queue`, { paused: true })).statusCode).toBe(403);
    expect((await adm(opB, "POST", `/api/v1/events/${evA}/print/queue`, { paused: true })).statusCode).toBe(403);
  });
  it("switching mode affects only pictures finished afterwards", async () => {
    await setMode(evA, "manual");
    const before = await finished(tokA, frameA, evA);
    const r = await adm(op, "POST", `/api/v1/events/${evA}/print/mode`, { mode: "auto" });
    expect(r.json().queue.mode).toBe("auto");
    expect(await status(before.job)).toBe("pending");                                   // untouched
    expect(await status((await finished(tokA, frameA, evA)).job)).toBe("approved");
    await adm(op, "POST", `/api/v1/events/${evA}/print/mode`, { mode: "manual" });
    expect((await adm(op, "POST", `/api/v1/events/${evA}/print/mode`, { mode: "turbo" })).statusCode).toBe(400);
    expect((await pool.query("SELECT detail FROM audit_logs WHERE action='print_mode' AND event_id=$1 ORDER BY id", [evA])).rows[0].detail).toMatchObject({ from: "manual", to: "auto" });
  });
  it("history lists the newest first with names", async () => {
    const h = (await adm(mgrA, "GET", `/api/v1/events/${evA}/print/history?limit=5`)).json().history;
    expect(h).toHaveLength(5);
    expect(new Date(h[0].at).getTime()).toBeGreaterThanOrEqual(new Date(h[4].at).getTime());
    expect(h.every((e: any) => typeof e.by === "string")).toBe(true);
  });
  it("the dashboard counts printed and failed jobs", async () => {
    await drain(evA);
    const f = await finished(tokA, frameA, evA); await act(evA, f.job, { action: "approve" }); await claimNext(pool, evA); await reportResult(pool, evA, f.job, false, "Jam");
    const d = (await adm(sup, "GET", "/api/v1/dashboard/overview")).json();
    expect(d.failedPrints).toBeGreaterThanOrEqual(1); expect(d.photosPrinted).toBeGreaterThanOrEqual(1);
  });
});

describe("live updates", () => {
  it("tells an open operator screen when something changes, only for its own event", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const open = async (ev: string, s: S) => {
      const ctl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/events/${ev}/print/stream`, { headers: { cookie: s.cookie }, signal: ctl.signal });
      return { res, ctl, reader: res.body!.getReader(), buf: "" };
    };
    const read = async (c: Awaited<ReturnType<typeof open>>, until: string, ms = 4000) => {
      const dec = new TextDecoder(); const end = Date.now() + ms;
      while (!c.buf.includes(until) && Date.now() < end) {
        const r = await Promise.race([c.reader.read(), new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), 500))]);
        if (r.value) c.buf += dec.decode(r.value);
      }
      return c.buf.includes(until);
    };
    const a = await open(evA, op); const b = await open(evB, opB);
    expect(a.res.status).toBe(200); expect(a.res.headers.get("content-type")).toContain("text/event-stream");
    expect(await read(a, "event: hello")).toBe(true); expect(await read(b, "event: hello")).toBe(true);
    const c = await compose(tokA, frameA);
    await finalize(tokA, c.sid, c.cid);
    expect(await read(a, "event: tick")).toBe(true);
    expect(b.buf.includes("event: tick")).toBe(false);                                    // B's screen heard nothing
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/events/${evA}/print/stream`, { headers: { cookie: viewer.cookie } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/events/${evA}/print/stream`)).status).toBe(401);
    a.ctl.abort(); b.ctl.abort();
  });
});
