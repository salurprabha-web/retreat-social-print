import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { claimNext, reportResult, requeueAllStale } from "../src/printService";
import { readPackage } from "../src/offlinePackage";
import { runSyncCycle, type SyncConfig } from "../src/syncService";

const CLOUD_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-cloud-"));
const LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-local-"));
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-unused-"));      // proves nothing falls back to the shared default
const { buildApp } = await import("../src/app");

type App = Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let cloudPool: Pool, localPool: Pool, adminPool: Pool;
let cloud: App, local: App; let cloudUrl = "";
let cSup: S, cViewer: S, lSup: S, lOp: S, lViewer: S;
let evId = "", guestTok = "", frame = "", wallTok = "", qrCode = "";
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function mkUser(app: App, pool: Pool, email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$2,$3,$4) RETURNING id", [email, email.split("@")[0], await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const call = (app: App, s: S | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { ...(s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {}), ...headers } });
const c = (s: S | null, m: string, u: string, p?: unknown, h?: Record<string, string>) => call(cloud, s, m, u, p, h);
const l = (s: S | null, m: string, u: string, p?: unknown, h?: Record<string, string>) => call(local, s, m, u, p, h);
const png = (colour: string) => sharp({ create: { width: 300, height: 150, channels: 3, background: colour } }).png().toBuffer();
const jpeg = (colour: string) => sharp({ create: { width: 1500, height: 2250, channels: 3, background: colour } }).jpeg().toBuffer();
const OCT = { "content-type": "application/octet-stream" };

async function startCloud() {
  cloud = await buildApp(cloudPool, { storageDir: CLOUD_STORE, mode: "cloud" });
  await cloud.listen({ port: 0, host: "127.0.0.1" });
  cloudUrl = `http://127.0.0.1:${(cloud.server.address() as any).port}`;
}
const localCfg = (): SyncConfig => ({ ...local.rspSync!, storageDir: LOCAL_STORE });
const counts = async (pool: Pool, ev = evId) => Object.fromEntries(await Promise.all(["guest_sessions", "photo_uploads", "final_compositions", "composition_photos", "print_jobs", "print_job_events", "qr_scan_events", "share_events", "wall_views"].map(async (t) => [t, (await pool.query(`SELECT count(*)::int n FROM ${t} WHERE event_id=$1`, [ev])).rows[0].n]))) as Record<string, number>;

/** A guest on the LOCAL server: session, photo, frame, finish. Returns ids. */
async function localGuest(colour = "#336699") {
  const G = `/api/v1/public/g/${guestTok}`;
  const sid = (await local.inject({ method: "POST", url: `${G}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
  const up = (await local.inject({ method: "POST", url: `${G}/photo`, payload: await jpeg(colour), headers: { ...OCT, "x-guest-session": sid } })).json().uploadId;
  const cid = (await local.inject({ method: "POST", url: `${G}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
  await local.inject({ method: "POST", url: `${G}/composition/${cid}/finalize`, headers: { "x-guest-session": sid } });
  const code = (await localPool.query("SELECT guest_code FROM guest_sessions WHERE id=$1", [sid])).rows[0].guest_code as string;
  return { sid, cid, up, code };
}
const pkgBytes = async () => (await c(cSup, "GET", `/api/v1/events/${evId}/offline/package`)).rawPayload;
const importPkg = (app: App, s: S | null, buf: Buffer | string) => call(app, s, "POST", "/api/v1/offline/import", buf as any, OCT);
const sync = async () => (await l(lSup, "POST", "/api/v1/sync/run")).json();
/** Builds a package by hand (for tampering tests): same layout the server uses. */
const craft = (manifest: object, files: Buffer[] = []) => { const mj = Buffer.from(JSON.stringify(manifest)); const len = Buffer.alloc(4); len.writeUInt32BE(mj.length); return Buffer.concat([Buffer.from("RSPK1\n"), len, mj, ...files]); };

beforeAll(async () => {
  adminPool = createPool(process.env.TEST_DATABASE_URL!);
  await adminPool.query("CREATE DATABASE rsp_cloud15"); await adminPool.query("CREATE DATABASE rsp_local15");
  const url = (db: string) => process.env.TEST_DATABASE_URL!.replace(/\/rsp_test$/, `/${db}`);
  cloudPool = createPool(url("rsp_cloud15")); localPool = createPool(url("rsp_local15"));
  await migrate(cloudPool); await migrate(localPool);
  await startCloud();
  local = await buildApp(localPool, { storageDir: LOCAL_STORE, mode: "local", sync: { cloudUrl: "", tokens: [] } });
  cSup = await mkUser(cloud, cloudPool, "sup15@c.test", "super_admin");
  lSup = await mkUser(local, localPool, "sup15@l.test", "super_admin");
  // the event is built entirely on the CLOUD: page, frame, sponsor, logos, QR
  const e = (await c(cSup, "POST", "/api/v1/events", { name: "Offline Summit" })).json().event;
  evId = e.id; guestTok = e.guestToken;
  const def = (await c(cSup, "GET", `/api/v1/events/${evId}/builder`)).json().definition;
  await c(cSup, "PUT", `/api/v1/events/${evId}/builder/draft`, { definition: def });
  await c(cSup, "POST", `/api/v1/events/${evId}/builder/publish`, {});
  await c(cSup, "POST", `/api/v1/events/${evId}/status`, { status: "active" });
  const photo = presetLayers("single", 1200, 1800).find((x) => x.type === "photo")!;
  const sp = (await c(cSup, "POST", `/api/v1/events/${evId}/sponsors`, { name: "Acme", hashtag: "Acme" })).json().sponsor;
  await c(cSup, "POST", `/api/v1/events/${evId}/sponsors/${sp.id}/logo`, await png("#ff0000"), OCT);
  await c(cSup, "POST", `/api/v1/events/${evId}/logo/event`, await png("#00aa00"), OCT);
  frame = (await c(cSup, "POST", `/api/v1/events/${evId}/frames`, { name: "Full", format: "4x6", layers: [{ ...photo, x: 0, y: 0, w: 1, h: 1 }], sponsorId: sp.id })).json().frame.id;
  wallTok = (await c(cSup, "GET", `/api/v1/events/${evId}/wall`)).json().token;
  qrCode = (await c(cSup, "GET", `/api/v1/events/${evId}/qr`)).json().qrCodes[0].code;
  cViewer = await mkUser(cloud, cloudPool, "view15@c.test", "reporting_viewer", evId, "reporting_viewer");
});
afterAll(async () => { await cloud.close().catch(() => {}); await local.close(); await cloudPool.end(); await localPool.end(); await adminPool.end(); });

describe("two servers, one release", () => {
  it("cloud and local run in their own modes with their own storage", async () => {
    expect(cloud.rspMode).toBe("cloud"); expect(local.rspMode).toBe("local");
    expect((await call(cloud, null, "GET", `/api/v1/public/g/${guestTok}`)).json().settings.localMode).toBe(false);
  });
  it("sync endpoints exist only on a cloud server; a package can only be installed on a local one", async () => {
    expect((await local.inject({ method: "GET", url: "/api/v1/sync/ping" })).statusCode).toBe(404);
    expect((await l(lSup, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "x" })).statusCode).toBe(404);
    expect((await importPkg(cloud, cSup, await pkgBytes())).statusCode).toBe(409);       // never overwrite a cloud event
    expect((await c(cSup, "GET", "/api/v1/sync/status")).json()).toMatchObject({ mode: "cloud", configured: false });
  });
});

describe("credentials and the event package (cloud)", () => {
  let token = "", credId = "";
  it("credentials need the right to edit, are shown once, listed without secrets, and can be revoked", async () => {
    expect((await c(cViewer, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "Laptop" })).statusCode).toBe(403);
    expect((await c(null, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "Laptop" })).statusCode).toBe(401);
    expect((await c(cSup, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "" })).statusCode).toBe(400);
    const r = await c(cSup, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "Venue laptop" });
    expect(r.statusCode).toBe(201); token = r.json().token; credId = r.json().id;
    expect(token).toMatch(/^sync_[a-f0-9]{48}$/);
    const list = (await c(cViewer, "GET", `/api/v1/events/${evId}/sync-credentials`)).json().credentials;
    expect(list).toHaveLength(1); expect(JSON.stringify(list)).not.toContain(token); expect(JSON.stringify(list)).not.toMatch(/token_hash|tokenHash/);
    const stored = (await cloudPool.query("SELECT token_hash FROM sync_credentials WHERE id=$1", [credId])).rows[0].token_hash;
    expect(stored).toBe(sha(Buffer.from(token))); expect(stored).not.toContain(token.slice(5));      // only a hash is kept
    const ping = await fetch(`${cloudUrl}/api/v1/sync/ping`, { headers: { authorization: `Bearer ${token}` } });
    expect(ping.status).toBe(200); expect((await ping.json()).eventId).toBe(evId);
    expect((await cloudPool.query("SELECT last_seen_at FROM sync_credentials WHERE id=$1", [credId])).rows[0].last_seen_at).not.toBeNull();
    expect((await c(cViewer, "DELETE", `/api/v1/events/${evId}/sync-credentials/${credId}`)).statusCode).toBe(403);
    expect((await c(cSup, "DELETE", `/api/v1/events/${evId}/sync-credentials/${credId}`)).statusCode).toBe(200);
    expect((await fetch(`${cloudUrl}/api/v1/sync/ping`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    for (const h of [undefined, "Bearer nope", `Bearer sync_${"0".repeat(48)}`, "Basic abc"]) expect((await fetch(`${cloudUrl}/api/v1/sync/ping`, { headers: h ? { authorization: h } : {} })).status).toBe(401);
  });
  it("the package holds the event's configuration and files, and no guest data, users or secrets", async () => {
    expect((await c(cViewer, "GET", `/api/v1/events/${evId}/offline/package`)).statusCode).toBe(403);
    expect((await c(null, "GET", `/api/v1/events/${evId}/offline/package`)).statusCode).toBe(401);
    const r = await c(cSup, "GET", `/api/v1/events/${evId}/offline/package`);
    expect(r.statusCode).toBe(200); expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="event-[0-9a-f]{8}\.rspkg"$/);
    const { manifest, files } = readPackage(r.rawPayload);
    expect(manifest.eventId).toBe(evId);
    expect(Object.keys(manifest.tables).sort()).toEqual(["event_settings", "events", "frame_layers", "frames", "guest_experience_pages", "mosaic_projects", "photo_wall_settings", "qr_tracking", "sponsors"].filter((t) => t in manifest.tables).sort());
    expect(manifest.tables.frames).toHaveLength(1); expect(manifest.tables.sponsors).toHaveLength(1); expect(manifest.tables.guest_experience_pages).toHaveLength(1);
    expect(manifest.tables.guest_experience_pages[0].state).toBe("published");
    expect(manifest.tables.events[0].created_by).toBeNull();
    expect(files.size).toBeGreaterThanOrEqual(2);                                              // sponsor logo + event logo at least
    for (const k of files.keys()) expect(k.startsWith(`events/${evId}/`)).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/password|token_hash|sessions/);
  });
});

describe("installing the package on the local server", () => {
  it("refuses anything that is not an intact package for this release", async () => {
    const good = await pkgBytes();
    expect((await importPkg(local, lSup, Buffer.from("hello"))).json().error).toBe("not_a_package");
    expect((await importPkg(local, lSup, good.subarray(0, good.length - 5))).json().error).toBe("package_damaged");
    expect((await importPkg(local, lSup, Buffer.concat([good, Buffer.from("extra")]))).json().error).toBe("package_damaged");
    const flipped = Buffer.from(good); flipped[flipped.length - 1] ^= 0xff;
    expect((await importPkg(local, lSup, flipped)).json().error).toBe("checksum_mismatch");
    const { manifest } = readPackage(good);
    expect((await importPkg(local, lSup, craft({ ...manifest, files: [{ key: `events/${evId}/frames/../../x.png`, size: 1, sha256: sha(Buffer.from("x")) }] }, [Buffer.from("x")]))).json().error).toBe("bad_file_name");
    expect((await importPkg(local, lSup, craft({ ...manifest, files: [{ key: "events/22222222-2222-4222-8222-222222222222/frames/a.png", size: 1, sha256: sha(Buffer.from("x")) }] }, [Buffer.from("x")]))).json().error).toBe("bad_file_name");
    expect((await importPkg(local, lSup, craft({ ...manifest, files: [], tables: { ...manifest.tables, users: [{ id: "x" }] } }))).json().error).toBe("unknown_table");
    expect((await importPkg(local, lSup, craft({ ...manifest, files: [], tables: { ...manifest.tables, frames: [{ id: "x", event_id: "22222222-2222-4222-8222-222222222222" }] } }))).json().error).toBe("wrong_event_in_package");
    expect((await importPkg(local, lSup, craft({ ...manifest, files: [], schema: "999_future.sql" }))).json().error).toBe("version_mismatch");
    expect((await importPkg(local, null, good)).statusCode).toBe(401);
    expect((await localPool.query("SELECT 1 FROM events WHERE id=$1", [evId])).rowCount).toBe(0);         // nothing half-installed
  });
  it("only a super administrator can install one", async () => {
    const op = await mkUser(local, localPool, "op15@l.test", "event_manager");
    await localPool.query("UPDATE users SET global_role='event_manager' WHERE email='op15@l.test'");
    expect((await importPkg(local, op, await pkgBytes())).statusCode).toBe(403);
  });
  it("installs the event with the same ids and links, and serves it to guests from local storage", async () => {
    const r = await importPkg(local, lSup, await pkgBytes());
    expect(r.statusCode).toBe(201); expect(r.json()).toMatchObject({ eventId: evId, name: "Offline Summit" });
    const ev = (await localPool.query("SELECT guest_token,status FROM events WHERE id=$1", [evId])).rows[0];
    expect(ev).toMatchObject({ guest_token: guestTok, status: "active" });                  // same link, so printed QR codes keep working
    expect((await local.inject({ method: "GET", url: `/api/v1/public/g/${guestTok}` })).json().settings.localMode).toBe(true);
    const frames = (await local.inject({ method: "GET", url: `/api/v1/public/g/${guestTok}/frames` })).json().frames;
    expect(frames.map((f: any) => f.id)).toEqual([frame]);
    const sp = (await localPool.query("SELECT id,logo_asset FROM sponsors WHERE event_id=$1", [evId])).rows[0];
    expect(fs.existsSync(path.join(LOCAL_STORE, sp.logo_asset))).toBe(true);                // the file really arrived on this server
    expect((await local.inject({ method: "GET", url: `/api/v1/public/g/${guestTok}/sponsor/${sp.id}/logo` })).statusCode).toBe(200);
    expect((await local.inject({ method: "GET", url: `/api/v1/public/g/${guestTok}/logo/event` })).statusCode).toBe(200);
    expect((await localPool.query("SELECT wall_token FROM photo_wall_settings WHERE event_id=$1", [evId])).rows[0].wall_token).toBe(wallTok);
    const q = await local.inject({ method: "GET", url: `/api/v1/public/q/${qrCode}` });
    expect(q.statusCode).toBeGreaterThanOrEqual(300); expect(q.statusCode).toBeLessThan(400);
    expect(fs.existsSync(path.join(CLOUD_STORE, sp.logo_asset))).toBe(true);                // and the cloud still has its own copy
  });
  it("installing again refreshes the configuration but never touches guests or a local pause", async () => {
    const g = await localGuest("#aa5500");
    await l(lSup, "POST", `/api/v1/events/${evId}/print/pause`, { paused: true }).catch(() => {});
    await localPool.query("UPDATE event_settings SET print_paused=true WHERE event_id=$1", [evId]);
    const f = (await c(cSup, "GET", `/api/v1/events/${evId}/frames/${frame}`)).json().frame;
    await c(cSup, "PUT", `/api/v1/events/${evId}/frames/${frame}`, { name: "Renamed on cloud", format: f.format, orientation: f.orientation, layers: f.layers, expectedUpdatedAt: f.updatedAt });
    const before = await counts(localPool);
    expect((await importPkg(local, lSup, await pkgBytes())).statusCode).toBe(201);
    expect(await counts(localPool)).toEqual(before);
    expect((await localPool.query("SELECT name FROM frames WHERE id=$1", [frame])).rows[0].name).toBe("Renamed on cloud");
    expect((await localPool.query("SELECT print_paused FROM event_settings WHERE event_id=$1", [evId])).rows[0].print_paused).toBe(true);
    expect((await localPool.query("SELECT 1 FROM guest_sessions WHERE id=$1", [g.sid])).rowCount).toBe(1);
    await localPool.query("UPDATE event_settings SET print_paused=false WHERE event_id=$1", [evId]);
  });
});

describe("working without the cloud", () => {
  it("guests upload, compose and finish, and the local print queue prints, with no cloud connection at all", async () => {
    await l(lSup, "PATCH", `/api/v1/events/${evId}`, { settings: { printMode: "auto" } });
    await localPool.query("UPDATE print_jobs SET status='cancelled' WHERE event_id=$1 AND status IN ('approved','pending','received')", [evId]);
    const a = await localGuest("#cc3300"), b = await localGuest("#0033cc");
    const jobs = (await localPool.query("SELECT id,status,composition_id FROM print_jobs WHERE composition_id = ANY($1)", [[a.cid, b.cid]])).rows;
    expect(jobs).toHaveLength(2); expect(jobs.every((j) => j.status === "approved")).toBe(true);
    const first = await claimNext(localPool, evId); expect(first).not.toBeNull();
    await reportResult(localPool, evId, first!.id, true);
    const second = await claimNext(localPool, evId); await reportResult(localPool, evId, second!.id, true);
    expect((await localPool.query("SELECT count(*)::int n FROM print_jobs WHERE composition_id = ANY($1) AND status='printed'", [[a.cid, b.cid]])).rows[0].n).toBe(2);
    // a share tap and a wall appearance happen locally too
    expect((await local.inject({ method: "POST", url: `/api/v1/public/g/${guestTok}/composition/${a.cid}/share`, payload: { channel: "download" } as any, headers: { "x-guest-session": a.sid } })).statusCode).toBe(201);
    await localPool.query("INSERT INTO wall_views(composition_id,event_id,shown_count) VALUES ($1,$2,4)", [a.cid, evId]);
    expect((await local.inject({ method: "GET", url: `/api/v1/public/q/${qrCode}` })).statusCode).toBeLessThan(400);
    await local.inject({ method: "GET", url: `/api/v1/public/q/${qrCode}` });
    lOp = await mkUser(local, localPool, "oper15@l.test", "print_operator", evId, "print_operator");
    lViewer = await mkUser(local, localPool, "lview15@l.test", "reporting_viewer", evId, "reporting_viewer");
  });
  it("status says plainly that nothing is configured yet", async () => {
    const s = (await l(lSup, "GET", "/api/v1/sync/status")).json();
    expect(s).toMatchObject({ mode: "local", configured: false, cloudReachable: null, pendingTotal: 0 });
    expect((await l(lSup, "POST", "/api/v1/sync/run")).json().error).toBe("sync_not_configured");
    expect((await l(null, "GET", "/api/v1/sync/status")).statusCode).toBe(401);
  });
});

describe("delivering to the cloud", () => {
  let token = "", credId = "";
  const guestsBefore = async () => counts(cloudPool);
  it("sends sessions, photos, pictures, print history and QR scans, with their files, byte for byte", async () => {
    const r = await c(cSup, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "Venue laptop" }); token = r.json().token; credId = r.json().id;
    local.rspSync = { cloudUrl, tokens: [token] };
    expect((await l(lViewer, "POST", "/api/v1/sync/run")).statusCode).toBe(403);
    const st = await sync();
    expect(st).toMatchObject({ mode: "local", configured: true, cloudReachable: true, lastError: null, pendingTotal: 0 });
    expect(st.events[0]).toMatchObject({ eventId: evId, pending: 0 });
    const lc = await counts(localPool), cc = await counts(cloudPool);
    expect(cc).toEqual(lc); expect(cc.final_compositions).toBeGreaterThanOrEqual(3); expect(cc.print_jobs).toBeGreaterThanOrEqual(3); expect(cc.qr_scan_events).toBe(3); expect(cc.share_events).toBe(1); expect(cc.wall_views).toBe(1);
    expect((await cloudPool.query("SELECT shown_count FROM wall_views WHERE event_id=$1", [evId])).rows[0].shown_count).toBe(4);
    expect((await cloudPool.query("SELECT channel,outcome FROM share_events WHERE event_id=$1", [evId])).rows[0]).toEqual({ channel: "download", outcome: "attempted" });
    const files = (await localPool.query("SELECT storage_key FROM final_compositions WHERE event_id=$1 UNION SELECT storage_key FROM photo_uploads WHERE event_id=$1", [evId])).rows;
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) expect(sha(fs.readFileSync(path.join(CLOUD_STORE, f.storage_key)))).toBe(sha(fs.readFileSync(path.join(LOCAL_STORE, f.storage_key))));
    expect((await cloudPool.query("SELECT scans FROM qr_tracking WHERE code=$1", [qrCode])).rows[0].scans).toBe(3);
    expect((await cloudPool.query("SELECT count(*)::int n FROM print_job_events WHERE origin_key IS NOT NULL")).rows[0].n).toBe(cc.print_job_events);
  });
  it("the cloud shows the pictures to its staff, and local-only references are cleared", async () => {
    const list = (await c(cSup, "GET", `/api/v1/events/${evId}/compositions`)).json();
    expect(list.total).toBeGreaterThanOrEqual(3);
    const cid = list.compositions[0].id;
    const thumb = await c(cSup, "GET", `/api/v1/events/${evId}/compositions/${cid}/thumb`);
    expect(thumb.statusCode).toBe(200); expect(thumb.headers["content-type"]).toBe("image/jpeg");
    const j = (await cloudPool.query("SELECT printer_id,approved_by,requested_by,synced_from FROM print_jobs WHERE event_id=$1", [evId])).rows;
    expect(j.every((x) => x.printer_id === null && x.approved_by === null && x.requested_by === null && x.synced_from === credId)).toBe(true);
    expect((await cloudPool.query("SELECT count(*)::int n FROM guest_sessions WHERE event_id=$1 AND device_id IS NOT NULL", [evId])).rows[0].n).toBe(0);
  });
  it("a delivered print job is a read-only record on the cloud: it can never be claimed, changed or requeued there", async () => {
    expect(await claimNext(cloudPool, evId)).toBeNull();
    const job = (await cloudPool.query("SELECT id FROM print_jobs WHERE event_id=$1 LIMIT 1", [evId])).rows[0].id;
    for (const action of ["approve", "retry", "cancel", "hold", "reject"]) {
      const r = await c(cSup, "POST", `/api/v1/events/${evId}/print/jobs/${job}/action`, { action });
      expect(r.statusCode).toBe(409); expect(r.json().error).toBe("synced_job_read_only");
    }
    await cloudPool.query("UPDATE print_jobs SET status='approved' WHERE id=$1", [job]);                  // even if it somehow looked printable
    expect(await claimNext(cloudPool, evId)).toBeNull();
    await cloudPool.query("UPDATE print_jobs SET status='printing', started_at=now() - interval '1 hour' WHERE id=$1", [job]);
    expect(await requeueAllStale(cloudPool, 60)).toBe(0);
    expect((await cloudPool.query("SELECT status FROM print_jobs WHERE id=$1", [job])).rows[0].status).toBe("printing");
    await cloudPool.query("UPDATE print_jobs SET status='printed' WHERE id=$1", [job]);
  });
  it("delivering again changes nothing, even if this server forgets what it already sent", async () => {
    const before = await guestsBefore();
    expect((await sync()).pendingTotal).toBe(0);
    expect(await guestsBefore()).toEqual(before);
    await localPool.query("DELETE FROM sync_state");                                                        // lost memory: everything looks new
    expect((await sync()).pendingTotal).toBe(0);
    expect(await guestsBefore()).toEqual(before);                                                          // no duplicates, scans not counted twice
    expect((await cloudPool.query("SELECT scans FROM qr_tracking WHERE code=$1", [qrCode])).rows[0].scans).toBe(3);
  });
  it("later changes travel too: moderation, and removal (including the files) follows", async () => {
    const [a, b] = (await localPool.query("SELECT id FROM final_compositions WHERE event_id=$1 ORDER BY created_at LIMIT 2", [evId])).rows.map((r) => r.id as string);
    await l(lSup, "POST", `/api/v1/events/${evId}/compositions/bulk`, { ids: [a], action: "reject", note: "blurry" });
    expect((await sync()).pendingTotal).toBe(0);
    const row = (await cloudPool.query("SELECT moderation,moderation_note,moderated_by FROM final_compositions WHERE id=$1", [a])).rows[0];
    expect(row).toMatchObject({ moderation: "rejected", moderation_note: "blurry", moderated_by: null });
    const key = (await cloudPool.query("SELECT storage_key FROM final_compositions WHERE id=$1", [b])).rows[0].storage_key;
    expect(fs.existsSync(path.join(CLOUD_STORE, key))).toBe(true);
    await l(lSup, "POST", `/api/v1/events/${evId}/compositions/bulk`, { ids: [b], action: "delete", confirmPrinted: true });
    expect((await sync()).pendingTotal).toBe(0);
    expect((await cloudPool.query("SELECT 1 FROM final_compositions WHERE id=$1", [b])).rowCount).toBe(0);
    expect((await cloudPool.query("SELECT 1 FROM print_jobs WHERE composition_id=$1", [b])).rowCount).toBe(0);
    expect(fs.existsSync(path.join(CLOUD_STORE, key))).toBe(false);                                         // privacy: deleted here means deleted there
    expect(await counts(cloudPool)).toEqual(await counts(localPool));
  });
  it("deleting a guest's data on the local server removes it from the cloud as well", async () => {
    const g = await localGuest("#112233"); await sync();
    const keys = (await cloudPool.query("SELECT storage_key FROM photo_uploads WHERE session_id=$1 UNION SELECT storage_key FROM final_compositions WHERE session_id=$1", [g.sid])).rows.map((r) => r.storage_key as string);
    expect(keys.length).toBe(2); for (const k of keys) expect(fs.existsSync(path.join(CLOUD_STORE, k))).toBe(true);
    expect((await l(lSup, "DELETE", `/api/v1/events/${evId}/guests/${g.code}`)).statusCode).toBe(200);
    await sync();
    expect((await cloudPool.query("SELECT 1 FROM guest_sessions WHERE id=$1", [g.sid])).rowCount).toBe(0);
    for (const k of keys) expect(fs.existsSync(path.join(CLOUD_STORE, k))).toBe(false);
    expect(await counts(cloudPool)).toEqual(await counts(localPool));
  });
});

describe("losing and regaining the connection", () => {
  let token = "";
  it("keeps working offline, shows a growing backlog, and catches up by itself", async () => {
    token = local.rspSync!.tokens[0];
    await cloud.close();                                                                                    // the venue loses its internet
    const g1 = await localGuest("#445566"), g2 = await localGuest("#665544");                               // guests are not affected
    expect((await localPool.query("SELECT count(*)::int n FROM print_jobs WHERE composition_id = ANY($1)", [[g1.cid, g2.cid]])).rows[0].n).toBe(2);
    const st = await sync();
    expect(st).toMatchObject({ cloudReachable: false, lastError: "Cannot reach the cloud" });
    expect(st.pendingTotal).toBeGreaterThanOrEqual(10);                                                      // 2 guests x (session, photo, picture, link row, job, history...)
    expect(st.events[0]).toMatchObject({ eventId: evId, error: "Cannot reach the cloud" }); expect(st.events[0].lastSuccessAt).not.toBeNull();
    const again = (await l(lOp, "GET", "/api/v1/sync/status")).json();                                      // an operator sees the same backlog for their event
    expect(again.pendingTotal).toBe(st.pendingTotal); expect(again.cloudReachable).toBe(false);
    await startCloud(); local.rspSync = { cloudUrl, tokens: [token] };                                      // internet is back (on a new address)
    const ok = await sync();
    expect(ok).toMatchObject({ cloudReachable: true, lastError: null, pendingTotal: 0 });
    expect(await counts(cloudPool)).toEqual(await counts(localPool));
  });
  it("an interrupted delivery resumes without losing or doubling anything", async () => {
    const g = await localGuest("#778899");
    let failed = false; const realFetch = fetch;
    const cfg: SyncConfig = { ...localCfg(), fetchImpl: ((url: any, init: any) => { if (!failed && String(url).endsWith("/sync/push")) { failed = true; return Promise.reject(new TypeError("fetch failed")); } return realFetch(url, init); }) as typeof fetch };
    const cut = await runSyncCycle(localPool, cfg);                                                         // files arrive, then the connection dies before the rows
    expect(cut.cloudReachable).toBe(false); expect(cut.pendingTotal).toBeGreaterThan(0);
    expect((await cloudPool.query("SELECT 1 FROM guest_sessions WHERE id=$1", [g.sid])).rowCount).toBe(0);
    const key = (await localPool.query("SELECT storage_key FROM final_compositions WHERE session_id=$1", [g.sid])).rows[0].storage_key;
    expect(fs.existsSync(path.join(CLOUD_STORE, key))).toBe(true);                                          // the files made it
    expect((await sync()).pendingTotal).toBe(0);
    expect(await counts(cloudPool)).toEqual(await counts(localPool));
  });
  it("a proxy answering 502, 503 or 504 means the cloud is unreachable, while other errors are refusals", async () => {
    for (const code of [502, 503, 504]) {
      const st = await runSyncCycle(localPool, { ...localCfg(), fetchImpl: (async () => new Response("bad gateway", { status: code })) as unknown as typeof fetch });
      expect(st).toMatchObject({ cloudReachable: false, lastError: "Cannot reach the cloud" });
    }
    const st = await runSyncCycle(localPool, { ...localCfg(), fetchImpl: (async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch });
    expect(st).toMatchObject({ cloudReachable: true, lastError: "Cloud refused: boom" });
    expect((await sync()).lastError).toBeNull();                                                          // the real cloud is fine again
  });
  it("a revoked credential is reported as a refusal (the cloud is reachable), the backlog is kept, and a new credential resumes", async () => {
    const list = (await c(cSup, "GET", `/api/v1/events/${evId}/sync-credentials`)).json().credentials;
    for (const cr of list.filter((x: any) => !x.revoked)) await c(cSup, "DELETE", `/api/v1/events/${evId}/sync-credentials/${cr.id}`);
    const g = await localGuest("#889900");
    const st = await sync();
    expect(st).toMatchObject({ cloudReachable: true, lastError: "Cloud refused: invalid_credential" }); expect(st.pendingTotal).toBeGreaterThan(0);
    const nt = (await c(cSup, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "Replacement" })).json().token;
    local.rspSync = { cloudUrl, tokens: [nt] };
    expect((await sync())).toMatchObject({ lastError: null, pendingTotal: 0 });
    expect((await cloudPool.query("SELECT 1 FROM guest_sessions WHERE id=$1", [g.sid])).rowCount).toBe(1);
  });
});

describe("what a sync credential may and may not do", () => {
  let token = "", other = "";
  const post = (p: string, body: unknown, tok = token) => fetch(`${cloudUrl}${p}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const schema = async () => (await cloudPool.query("SELECT max(name) n FROM schema_migrations")).rows[0].n as string;
  beforeAll(async () => {
    token = (await c(cSup, "POST", `/api/v1/events/${evId}/sync-credentials`, { name: "Attacker test" })).json().token;
    const e2 = (await c(cSup, "POST", "/api/v1/events", { name: "Other Event" })).json().event; other = e2.id;
  });
  it("rows of another event are refused, whole", async () => {
    const row = { id: "33333333-3333-4333-8333-333333333333", event_id: other, guest_code: "GZZZZZ", fields: {} };
    const r = await post("/api/v1/sync/push", { schema: await schema(), rows: { guest_sessions: [row] } });
    expect(r.status).toBe(403); expect((await r.json()).error).toBe("wrong_event");
    expect((await post("/api/v1/sync/push", { schema: await schema(), rows: { guest_sessions: [{ id: "x", guest_code: "G" }] } })).status).toBe(403);   // no event at all
    expect((await cloudPool.query("SELECT 1 FROM guest_sessions WHERE event_id=$1", [other])).rowCount).toBe(0);
  });
  it("only the listed tables, only for the same release, only valid shapes", async () => {
    expect((await (await post("/api/v1/sync/push", { schema: await schema(), rows: { users: [{ event_id: evId }] } })).json()).error).toBe("unknown_table");
    expect((await (await post("/api/v1/sync/push", { schema: await schema(), deletes: { events: ["abc"] } })).json()).error).toBe("unknown_table");
    const mm = await post("/api/v1/sync/push", { schema: "000_old.sql", rows: {} });
    expect(mm.status).toBe(409); expect((await mm.json()).error).toBe("version_mismatch");
    expect((await post("/api/v1/sync/push", { rows: {} })).status).toBe(400);
    expect((await post("/api/v1/sync/push", { schema: await schema(), deletes: { guest_sessions: ["x'; DROP TABLE users;--"] } })).status).toBe(422);
    expect((await cloudPool.query("SELECT 1 FROM users LIMIT 1")).rowCount).toBe(1);
  });
  it("files: own event's picture folders only, plain names, and a damaged upload is never stored", async () => {
    const put = (key: string, body: Buffer, hash: string) => fetch(`${cloudUrl}/api/v1/sync/file?key=${encodeURIComponent(key)}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-sha256": hash }, body: new Uint8Array(body) });
    const data = Buffer.from("hello"); const h = sha(data);
    for (const key of [`events/${other}/finals/abc12345.jpg`, `events/${evId}/branding/abc12345.png`, `events/${evId}/finals/../../evil.jpg`, `events/${evId}/finals/a/b.jpg`, "../x"])
      expect((await put(key, data, h)).status).toBe(422);
    const ok = `events/${evId}/finals/zz00112233445566.jpg`;
    expect((await put(ok, data, "0".repeat(64))).status).toBe(422);
    expect(fs.existsSync(path.join(CLOUD_STORE, ok))).toBe(false);
    expect((await put(ok, data, h)).status).toBe(201); expect(fs.readFileSync(path.join(CLOUD_STORE, ok)).toString()).toBe("hello");
    expect((await (await post("/api/v1/sync/files/check", { files: [{ key: ok, size: 5 }, { key: `events/${evId}/finals/missing0000000000.jpg`, size: 1 }] })).json()).missing).toEqual([`events/${evId}/finals/missing0000000000.jpg`]);
    expect((await post("/api/v1/sync/files/check", { files: [{ key: `events/${other}/finals/x1234567.jpg`, size: 1 }] })).status).toBe(422);
    fs.rmSync(path.join(CLOUD_STORE, ok));
  });
  it("a delivered row can never reach into the cloud's own users, devices or printers", async () => {
    const rows = (await localPool.query("SELECT to_jsonb(g) j FROM guest_sessions g WHERE event_id=$1 LIMIT 1", [evId])).rows[0].j;
    const dev = (await cloudPool.query("INSERT INTO devices(event_id,kind,name,token_hash) VALUES ($1,'kiosk','k','h15') RETURNING id", [evId])).rows[0].id;
    const r = await post("/api/v1/sync/push", { schema: await schema(), rows: { guest_sessions: [{ ...rows, device_id: dev }] } });
    expect(r.status).toBe(200);
    expect((await cloudPool.query("SELECT device_id FROM guest_sessions WHERE id=$1", [rows.id])).rows[0].device_id).toBeNull();
  });
});
