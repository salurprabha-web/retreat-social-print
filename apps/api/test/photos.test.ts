import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { unzipSync } from "fflate";
import { presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-p-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, op: S, viewer: S, mgrB: S, opB: S;
let evA: string, evB: string, tokA: string, tokB: string; let frameA: string, frameA2: string, frameB: string;
const PW = "correct horse battery"; const STORE = () => process.env.STORAGE_DIR!;
const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id", [email, await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {} });
const G = (t: string) => `/api/v1/public/g/${t}`;
async function mkEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return e as { id: string; guestToken: string };
}
const mkFrame = async (ev: string, name: string, preset: string) => (await adm(sup, "POST", `/api/v1/events/${ev}/frames`, { name, format: "4x6", layers: presetLayers(preset as any, 1200, 1800) })).json().frame.id as string;
const jpeg = (c: string) => sharp({ create: { width: 2000, height: 3000, channels: 3, background: c } }).jpeg().toBuffer();

/** A complete guest submission: session -> upload -> compose. */
async function submit(tok: string, frame: string, colour: string, opts: { fields?: Record<string, string> } = {}) {
  const sid = (await app.inject({ method: "POST", url: `${G(tok)}/session`, payload: { consent: true, fields: opts.fields ?? {} } })).json();
  const sessionId = sid.sessionId as string;
  const up = (await app.inject({ method: "POST", url: `${G(tok)}/photo`, payload: await jpeg(colour), headers: { "content-type": "application/octet-stream", "x-guest-session": sessionId } })).json().uploadId as string;
  const c = (await app.inject({ method: "POST", url: `${G(tok)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sessionId } })).json();
  return { sessionId, guestCode: sid.guestCode as string, uploadId: up, cid: c.compositionId as string };
}
const list = async (ev: string, qs = "", s = sup) => (await adm(s, "GET", `/api/v1/events/${ev}/compositions${qs}`)).json();
const exists = (key: string) => fs.existsSync(path.join(STORE(), key));
const keyOf = async (table: "final_compositions" | "photo_uploads", id: string) => (await pool.query(`SELECT storage_key FROM ${table} WHERE id=$1`, [id])).rows[0]?.storage_key as string | undefined;

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup9@t.test", "super_admin");
  const a = await mkEvent("Photos A"), b = await mkEvent("Photos B");
  evA = a.id; tokA = a.guestToken; evB = b.id; tokB = b.guestToken;
  frameA = await mkFrame(evA, "Single", "single"); frameA2 = await mkFrame(evA, "Collage", "collage2"); frameB = await mkFrame(evB, "B single", "single");
  mgrA = await mkUser("mgr9@t.test", "event_manager", evA, "event_manager");
  op = await mkUser("op9@t.test", "print_operator", evA, "print_operator");
  viewer = await mkUser("view9@t.test", "reporting_viewer", evA, "reporting_viewer");
  mgrB = await mkUser("mgrb9@t.test", "event_manager", evB, "event_manager");
  opB = await mkUser("opb9@t.test", "print_operator", evB, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("listing, filters and counts", () => {
  const subs: Awaited<ReturnType<typeof submit>>[] = [];
  beforeAll(async () => {
    for (const c of ["#aa0000", "#00aa00", "#0000aa", "#aaaa00", "#00aaaa"]) subs.push(await submit(tokA, frameA, c));
    subs.push(await submit(tokB, frameB, "#555555"));
  });
  it("lists newest first with guest, frame, slots and counters; pages work", async () => {
    const r = await list(evA, "?limit=3");
    expect(r.total).toBe(5); expect(r.compositions).toHaveLength(3);
    expect(r.compositions[0].id).toBe(subs[4].cid);                 // newest first
    expect(r.compositions[0]).toMatchObject({ guestCode: subs[4].guestCode, moderation: "pending", showOnWall: true, frame: { name: "Single" }, downloads: 0, shareAttempts: 0, printJobs: 0 });
    expect(r.compositions[0].slots).toEqual([expect.objectContaining({ slot: 1, uploadId: subs[4].uploadId, width: 2000, height: 3000 })]);
    const page2 = await list(evA, "?limit=3&offset=3");
    expect(page2.compositions.map((c: any) => c.id)).toEqual([subs[1].cid, subs[0].cid]);
    expect((await list(evA, "?sort=oldest&limit=1")).compositions[0].id).toBe(subs[0].cid);
  });
  it("never shows another event's pictures", async () => {
    const ids = (await list(evA)).compositions.map((c: any) => c.id);
    expect(ids).not.toContain(subs[5].cid);
    expect((await list(evB)).compositions.map((c: any) => c.id)).toEqual([subs[5].cid]);
  });
  it("filters by guest ID, frame, date and status, and counts per status ignore the status filter", async () => {
    expect((await list(evA, `?q=${subs[2].guestCode.slice(0, 4)}`)).compositions.map((c: any) => c.id)).toContain(subs[2].cid);
    expect((await list(evA, `?q=${subs[2].guestCode}`)).total).toBe(1);
    expect((await list(evA, "?q=ZZZZZZ")).total).toBe(0);
    expect((await list(evA, "?q=%25")).total).toBe(0);                         // wildcards are escaped, not interpreted
    expect((await list(evA, `?frameId=${frameA2}`)).total).toBe(0);
    expect((await list(evA, `?frameId=${frameA}`)).total).toBe(5);
    expect((await list(evA, `?from=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`)).total).toBe(0);
    expect((await list(evA, `?to=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`)).total).toBe(5);
    const r = await list(evA, "?status=approved");
    expect(r.total).toBe(0); expect(r.counts).toEqual({ pending: 5, approved: 0, rejected: 0, all: 5 });
  });
  it("validates query parameters", async () => {
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/compositions?status=bogus`)).statusCode).toBe(400);
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/compositions?limit=9999`)).statusCode).toBe(400);
  });
  it("detail shows the guest; contact details only for managers", async () => {
    const s = await submit(tokA, frameA, "#123123");
    await pool.query("UPDATE guest_sessions SET fields=$2 WHERE id=$1", [s.sessionId, JSON.stringify({ nm: "Asha", em: "asha@example.com" })]);
    const asManager = (await adm(mgrA, "GET", `/api/v1/events/${evA}/compositions/${s.cid}`)).json();
    expect(asManager.guest.fields).toEqual({ nm: "Asha", em: "asha@example.com" });
    const asOperator = (await adm(op, "GET", `/api/v1/events/${evA}/compositions/${s.cid}`)).json();
    expect(asOperator.guest).toMatchObject({ code: s.guestCode, fieldsHidden: true }); expect(asOperator.guest.fields).toBeUndefined();
    expect(JSON.stringify(asOperator)).not.toContain("asha@example.com");
    expect((await adm(op, "GET", `/api/v1/events/${evA}/compositions/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
  });
});

describe("thumbnails", () => {
  it("makes small cached JPEGs of finals and originals, only for allowed sizes", async () => {
    const s = await submit(tokA, frameA, "#808080");
    const t = await adm(op, "GET", `/api/v1/events/${evA}/compositions/${s.cid}/thumb?size=400`);
    expect(t.statusCode).toBe(200); expect(t.headers["content-type"]).toBe("image/jpeg");
    const m = await sharp(t.rawPayload).metadata(); expect([m.format, m.width]).toEqual(["jpeg", 400]);
    expect(t.rawPayload.length).toBeLessThan(60_000);
    expect(exists(`events/${evA}/thumbs/c-${s.cid}-400.jpg`)).toBe(true);
    const u = await adm(op, "GET", `/api/v1/events/${evA}/uploads/${s.uploadId}/thumb?size=200`);
    expect((await sharp(u.rawPayload).metadata()).width).toBe(200);
    expect((await adm(op, "GET", `/api/v1/events/${evA}/compositions/${s.cid}/thumb?size=999`)).statusCode).toBe(404);
  });
  it("respects roles and event isolation", async () => {
    const s = await submit(tokA, frameA, "#909090");
    expect((await adm(viewer, "GET", `/api/v1/events/${evA}/compositions/${s.cid}/thumb`)).statusCode).toBe(403);
    expect((await adm(opB, "GET", `/api/v1/events/${evA}/compositions/${s.cid}/thumb`)).statusCode).toBe(403);
    expect((await adm(opB, "GET", `/api/v1/events/${evB}/compositions/${s.cid}/thumb`)).statusCode).toBe(404);      // B's URL, A's picture
    expect((await adm(null, "GET", `/api/v1/events/${evA}/compositions/${s.cid}/thumb`)).statusCode).toBe(401);
  });
});

describe("moderation", () => {
  let a: Awaited<ReturnType<typeof submit>>, b: Awaited<ReturnType<typeof submit>>, c: Awaited<ReturnType<typeof submit>>;
  beforeAll(async () => { a = await submit(tokA, frameA, "#101010"); b = await submit(tokA, frameA, "#202020"); c = await submit(tokA, frameA, "#303030"); });
  it("approves and rejects one picture, recording who, when and why", async () => {
    expect((await adm(op, "POST", `/api/v1/events/${evA}/compositions/${a.cid}/moderation`, { status: "approved" })).statusCode).toBe(200);
    expect((await adm(op, "POST", `/api/v1/events/${evA}/compositions/${b.cid}/moderation`, { status: "rejected", note: "blurry" })).statusCode).toBe(200);
    const items = (await list(evA)).compositions;
    const A = items.find((x: any) => x.id === a.cid), B = items.find((x: any) => x.id === b.cid);
    expect(A).toMatchObject({ moderation: "approved", moderatedBy: "op9@t.test" }); expect(A.moderatedAt).toBeTruthy();
    expect(B).toMatchObject({ moderation: "rejected", moderationNote: "blurry" });
    expect((await adm(op, "POST", `/api/v1/events/${evA}/compositions/${a.cid}/moderation`, { status: "maybe" })).statusCode).toBe(400);
    const audit = await pool.query("SELECT action FROM audit_logs WHERE event_id=$1 AND action IN ('photo_approved','photo_rejected')", [evA]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(2);
  });
  it("applies bulk actions, reports unknown ids, and keeps events apart", async () => {
    const other = (await list(evB)).compositions[0].id;
    const r = await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [a.cid, b.cid, c.cid, other, "00000000-0000-4000-8000-000000000000"], action: "approve", note: "ok" });
    expect(r.json()).toMatchObject({ updated: 3 }); expect(r.json().missing).toEqual([other, "00000000-0000-4000-8000-000000000000"]);
    expect((await pool.query("SELECT moderation FROM final_compositions WHERE id=$1", [other])).rows[0].moderation).toBe("pending");   // B's picture untouched
    expect((await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [a.cid], action: "reject" })).json().updated).toBe(1);
    const counts = (await list(evA)).counts; expect(counts.approved).toBeGreaterThanOrEqual(2); expect(counts.rejected).toBeGreaterThanOrEqual(1);
    expect((await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [], action: "approve" })).statusCode).toBe(400);
    expect((await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [other], action: "approve" })).statusCode).toBe(404);
  });
  it("hides pictures from the photo wall and shows them again", async () => {
    await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [c.cid], action: "hide_wall" });
    expect((await list(evA, "?wall=false")).compositions.map((x: any) => x.id)).toEqual([c.cid]);
    await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [c.cid], action: "show_wall" });
    expect((await list(evA, "?wall=false")).total).toBe(0);
  });
  it("viewers and other events' staff cannot moderate", async () => {
    expect((await adm(viewer, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [a.cid], action: "approve" })).statusCode).toBe(403);
    expect((await adm(opB, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [a.cid], action: "approve" })).statusCode).toBe(403);
    expect((await adm(null, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [a.cid], action: "approve" })).statusCode).toBe(401);
  });
});

describe("deleting", () => {
  it("deletes the picture, its original and cached thumbnails from disk, and the public link stops working", async () => {
    const s = await submit(tokA, frameA, "#bb5500");
    const link = (await app.inject({ method: "GET", url: `${G(tokA)}/composition/${s.cid}/url`, headers: { "x-guest-session": s.sessionId } })).json().url;
    expect((await app.inject({ method: "GET", url: link })).statusCode).toBe(200);
    await adm(op, "GET", `/api/v1/events/${evA}/compositions/${s.cid}/thumb?size=200`);
    const fKey = (await keyOf("final_compositions", s.cid))!, oKey = (await keyOf("photo_uploads", s.uploadId))!;
    expect(exists(fKey) && exists(oKey)).toBe(true);
    const r = await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [s.cid], action: "delete" });
    expect(r.json()).toMatchObject({ deleted: 1, blocked: [] });
    expect(exists(fKey)).toBe(false); expect(exists(oKey)).toBe(false); expect(exists(`events/${evA}/thumbs/c-${s.cid}-200.jpg`)).toBe(false);
    expect((await pool.query("SELECT 1 FROM final_compositions WHERE id=$1", [s.cid])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM photo_uploads WHERE id=$1", [s.uploadId])).rowCount).toBe(0);
    expect((await app.inject({ method: "GET", url: link })).statusCode).toBe(404);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='photo_delete' AND event_id=$1", [evA])).rowCount).toBeGreaterThan(0);
  });
  it("keeps an original that another picture still uses", async () => {
    const sid = (await app.inject({ method: "POST", url: `${G(tokA)}/session`, payload: { consent: true, fields: {} } })).json().sessionId;
    const up = (await app.inject({ method: "POST", url: `${G(tokA)}/photo`, payload: await jpeg("#44aa44"), headers: { "content-type": "application/octet-stream", "x-guest-session": sid } })).json().uploadId;
    const post = async (frameId: string, slots: number[]) => (await app.inject({ method: "POST", url: `${G(tokA)}/compose`, payload: { frameId, slots: slots.map((slot) => ({ slot, uploadId: up, adjust: A0 })) } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
    const one = await post(frameA, [1]);
    await pool.query("UPDATE final_compositions SET created_at=created_at"); // no-op
    // a second composition from the same upload that is not auto-replaced: insert directly
    const two = (await pool.query("INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256,session_id,input_hash,bytes) VALUES ($1,$2,$3,$4,1200,1800,'x',$5,'h2',1) RETURNING id", [evA, up, frameA, "events/x/finals/fake.jpg", sid])).rows[0].id;
    await pool.query("INSERT INTO composition_photos(composition_id,event_id,slot,upload_id,adjust) VALUES ($1,$2,1,$3,'{}')", [two, evA, up]);
    const oKey = (await keyOf("photo_uploads", up))!;
    await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [one], action: "delete" });
    expect(exists(oKey)).toBe(true); expect((await pool.query("SELECT 1 FROM photo_uploads WHERE id=$1", [up])).rowCount).toBe(1);
    await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [two], action: "delete" });
    expect(exists(oKey)).toBe(false);
  });
  it("will not delete a picture with print jobs unless the operator confirms", async () => {
    const s = await submit(tokA, frameA, "#cc3300");
    await pool.query("INSERT INTO print_jobs(event_id,composition_id,idempotency_key,status) VALUES ($1,$2,$3,'printed')", [evA, s.cid, "pj-" + s.cid]);
    const blocked = await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [s.cid], action: "delete" });
    expect(blocked.json()).toMatchObject({ deleted: 0, blocked: [s.cid] });
    expect((await pool.query("SELECT 1 FROM final_compositions WHERE id=$1", [s.cid])).rowCount).toBe(1);
    expect((await adm(op, "GET", `/api/v1/events/${evA}/compositions/${s.cid}`)).json().printJobsByStatus).toEqual({ printed: 1 });
    const ok = await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [s.cid], action: "delete", confirmPrinted: true });
    expect(ok.json().deleted).toBe(1);
  });
  it("cannot delete other events' pictures", async () => {
    const other = (await list(evB)).compositions[0].id;
    expect((await adm(op, "POST", `/api/v1/events/${evA}/compositions/bulk`, { ids: [other], action: "delete" })).statusCode).toBe(404);
    expect((await pool.query("SELECT 1 FROM final_compositions WHERE id=$1", [other])).rowCount).toBe(1);
  });
});

describe("delete all data for a guest", () => {
  it("removes sessions, originals, pictures, share records and files; managers only", async () => {
    const s = await submit(tokA, frameA, "#0a0a99", { fields: {} });
    await app.inject({ method: "POST", url: `${G(tokA)}/composition/${s.cid}/share`, payload: { channel: "download" } as any, headers: { "x-guest-session": s.sessionId } });
    const fKey = (await keyOf("final_compositions", s.cid))!, oKey = (await keyOf("photo_uploads", s.uploadId))!;
    expect((await adm(op, "DELETE", `/api/v1/events/${evA}/guests/${s.guestCode}`)).statusCode).toBe(403);
    expect((await adm(mgrB, "DELETE", `/api/v1/events/${evA}/guests/${s.guestCode}`)).statusCode).toBe(403);
    expect((await adm(mgrB, "DELETE", `/api/v1/events/${evB}/guests/${s.guestCode}`)).statusCode).toBe(404);      // right event, wrong guest
    const r = await adm(mgrA, "DELETE", `/api/v1/events/${evA}/guests/${s.guestCode}`);
    expect(r.json()).toMatchObject({ ok: true, pictures: 1, originals: 1 });
    expect(exists(fKey)).toBe(false); expect(exists(oKey)).toBe(false);
    for (const t of ["guest_sessions", "photo_uploads", "final_compositions", "share_events"]) {
      const col = t === "guest_sessions" ? "id" : t === "share_events" ? "session_id" : "session_id";
      expect((await pool.query(`SELECT 1 FROM ${t} WHERE ${col}=$1`, [s.sessionId])).rowCount, t).toBe(0);
    }
    expect((await adm(mgrA, "DELETE", `/api/v1/events/${evA}/guests/${s.guestCode}`)).statusCode).toBe(404);
    expect((await adm(mgrA, "DELETE", `/api/v1/events/${evA}/guests/not-a-code`)).statusCode).toBe(404);
  });
});

describe("export", () => {
  it("streams a ZIP of the approved pictures, byte-identical to the stored files", async () => {
    const ev = await mkEvent("Photos Export"); const f = await mkFrame(ev.id, "Single", "single");
    const s1 = await submit(ev.guestToken, f, "#ff0000"), s2 = await submit(ev.guestToken, f, "#00ff00"), s3 = await submit(ev.guestToken, f, "#0000ff");
    await adm(sup, "POST", `/api/v1/events/${ev.id}/compositions/bulk`, { ids: [s1.cid, s2.cid], action: "approve" });
    const z = await adm(sup, "GET", `/api/v1/events/${ev.id}/compositions-export`);
    expect(z.statusCode).toBe(200); expect(z.headers["content-type"]).toBe("application/zip"); expect(z.headers["content-disposition"]).toContain("photos.zip");
    const files = unzipSync(new Uint8Array(z.rawPayload));
    const names = Object.keys(files); expect(names).toHaveLength(2);
    expect(names.every((n) => /^\d{4}-G[A-Z0-9]{5}-[0-9a-f]{8}\.jpg$/.test(n))).toBe(true);
    const disk = fs.readFileSync(path.join(STORE(), (await keyOf("final_compositions", s1.cid))!));
    expect(Buffer.from(Object.values(files)[0]).equals(disk) || Buffer.from(Object.values(files)[1]).equals(disk)).toBe(true);
    const all = await adm(sup, "GET", `/api/v1/events/${ev.id}/compositions-export?status=pending`);
    expect(Object.keys(unzipSync(new Uint8Array(all.rawPayload)))).toHaveLength(1);
    expect(s3.cid).toBeTruthy();
  });
  it("is limited to staff of the event and audited", async () => {
    expect((await adm(viewer, "GET", `/api/v1/events/${evA}/compositions-export`)).statusCode).toBe(403);
    expect((await adm(opB, "GET", `/api/v1/events/${evA}/compositions-export`)).statusCode).toBe(403);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='photo_export'")).rowCount).toBeGreaterThan(0);
  });
});
