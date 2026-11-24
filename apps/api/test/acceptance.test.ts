/**
 * FINAL PRODUCT ACCEPTANCE TEST: the 25-step journey from the product specification, run through the real HTTP interface in order.
 * What it proves is the SOFTWARE side of each step. Three things cannot be proven here and are stated at their steps: real Instagram,
 * a physical printer, and real phones. See docs/ACCEPTANCE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import jsQR from "jsqr";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-acc-"));
process.env.STORAGE_DIR = STORE;
const { buildApp } = await import("../src/app");
const { runRetention } = await import("../src/retention");

let pool: Pool, admin: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
const PW = "correct horse battery"; const OCT = { "content-type": "application/octet-stream" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
let sup: S, operator: S;
const call = (s: S | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { ...(s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {}), ...headers } });
const bearer = (tok: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
const png = (c: string, w = 400, h = 200) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();

// state carried from step to step
const J: Record<string, any> = {};
const G = () => `/api/v1/public/g/${J.guestToken}`;

beforeAll(async () => {
  admin = createPool(process.env.TEST_DATABASE_URL!);
  await admin.query("CREATE DATABASE rsp_acc17");
  pool = createPool(process.env.TEST_DATABASE_URL!.replace(/\/rsp_test$/, "/rsp_acc17"));
  await migrate(pool);
  app = await buildApp(pool);
  await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ('admin@acc.test','Admin',$1,'super_admin')", [await hashPassword(PW)]);
  const oid = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ('operator@acc.test','Operator',$1,'print_operator') RETURNING id", [await hashPassword(PW)])).rows[0].id;
  J.operatorId = oid;
});
afterAll(async () => { await app.close(); await pool.end(); await admin.end(); });

describe("A. The administrator builds the event (steps 1-9)", () => {
  it("1. the admin logs in (and a wrong password is refused)", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@acc.test", password: "wrong-wrong-wrong" } })).statusCode).toBe(401);
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@acc.test", password: PW } });
    expect(r.statusCode).toBe(200); sup = { cookie: (r.headers["set-cookie"] as string).split(";")[0], csrf: r.json().csrf };
    expect((await call(sup, "GET", "/api/v1/auth/me")).json().user.globalRole).toBe("super_admin");
  });
  it("2. the admin creates a new event", async () => {
    const r = await call(sup, "POST", "/api/v1/events", { name: "Acceptance Gala 2026", clientName: "Globex Corporation", hashtag: "GalaNight" });
    expect(r.statusCode).toBe(201); J.eventId = r.json().event.id; J.guestToken = r.json().event.guestToken;
    expect(r.json().event).toMatchObject({ name: "Acceptance Gala 2026", status: "draft" });
  });
  it("3. the admin uploads the client logo", async () => {
    const r = await call(sup, "POST", `/api/v1/events/${J.eventId}/logo/client`, await png("#d62828"), OCT);
    expect(r.statusCode).toBe(201);
    expect((await call(sup, "GET", `/api/v1/events/${J.eventId}/logo/client`)).headers["content-type"]).toBe("image/png");
  });
  it("4+5. the admin customises the landing page: colours, fonts, background and text", async () => {
    const cur = (await call(sup, "GET", `/api/v1/events/${J.eventId}/builder`)).json().definition;
    const def = structuredClone(cur);
    def.theme.background = { ...def.theme.background, type: "color", color: "#0a1b2c" };
    def.theme.textColor = "#fff4e6"; def.theme.accentColor = "#ff2e63"; def.theme.fontFamily = "serif";
    const heading = def.welcome.components.find((c: any) => c.type === "heading"); expect(heading).toBeTruthy();
    heading.props.text = "Welcome to the Gala, {{event.name}}!";
    const r = await call(sup, "PUT", `/api/v1/events/${J.eventId}/builder/draft`, { definition: def });
    expect(r.statusCode).toBe(200); J.customDef = def;
  });
  it("6. the admin creates and uploads several frames", async () => {
    const ov = await call(sup, "POST", `/api/v1/events/${J.eventId}/frame-assets`, await png("#ffd166", 1200, 300), OCT);
    expect(ov.statusCode).toBe(201); const asset = ov.json().name as string;
    const classic = await call(sup, "POST", `/api/v1/events/${J.eventId}/frames`, { name: "Classic", format: "4x6", preset: "single" });
    expect(classic.statusCode).toBe(201);
    const layers = (await call(sup, "POST", `/api/v1/events/${J.eventId}/frames`, { name: "tmp", format: "4x6", preset: "polaroid" })).json().frame.layers;
    const gold = await call(sup, "POST", `/api/v1/events/${J.eventId}/frames`, { name: "Gold banner", format: "4x6", layers: [...layers, { id: "ovl1", type: "image", src: asset, fit: "stretch", x: 0, y: 0.82, w: 1, h: 0.18, rotation: 0, opacity: 1, locked: false, hidden: false }] });
    expect(gold.statusCode).toBe(201);
    const list = (await call(sup, "GET", `/api/v1/events/${J.eventId}/frames`)).json().frames;
    for (const f of list.filter((x: any) => x.name === "tmp")) await call(sup, "DELETE", `/api/v1/events/${J.eventId}/frames/${f.id}`);
    J.frames = (await call(sup, "GET", `/api/v1/events/${J.eventId}/frames`)).json().frames; expect(J.frames.map((f: any) => f.name).sort()).toEqual(["Classic", "Gold banner"]);
    J.classic = J.frames.find((f: any) => f.name === "Classic").id; J.gold = J.frames.find((f: any) => f.name === "Gold banner").id;
  });
  it("7. the admin configures the guest journey", async () => {
    const def = structuredClone(J.customDef);
    def.journey.steps = def.journey.steps.map((s: any) => (s.id === "details" ? { ...s, enabled: true } : s.id === "welcome" ? { ...s, buttonLabel: "BEGIN" } : s.id === "share" ? { ...s, title: "Show it off!" } : s));
    def.messages.success = "You are all set. See you at the print desk!";
    expect((await call(sup, "PUT", `/api/v1/events/${J.eventId}/builder/draft`, { definition: def })).statusCode).toBe(200); J.customDef = def;
  });
  it("8. the admin publishes the event (guests see nothing before this)", async () => {
    expect((await app.inject({ method: "GET", url: G() })).statusCode).toBe(404);                                   // draft event: not reachable
    expect((await call(sup, "POST", `/api/v1/events/${J.eventId}/builder/publish`, {})).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: G() })).statusCode).toBe(404);                                   // published page but event not live yet
    expect((await call(sup, "POST", `/api/v1/events/${J.eventId}/status`, { status: "active" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: G() })).statusCode).toBe(200);
  });
  it("9. the admin downloads the QR code, and it really encodes the guest link", async () => {
    const qrs = (await call(sup, "GET", `/api/v1/events/${J.eventId}/qr`)).json().qrCodes; J.qrCode = qrs[0].code;
    const r = await call(sup, "GET", `/api/v1/events/${J.eventId}/qr/${qrs[0].id}/image?format=png&size=800&download=1&base=${encodeURIComponent("https://photos.example.test")}`);
    expect(r.statusCode).toBe(200); expect(r.headers["content-disposition"]).toMatch(/attachment/);
    const { data, info } = await sharp(r.rawPayload).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    expect(decoded?.data).toBe(`https://photos.example.test/q/${J.qrCode}`);                                        // a real scanner reads the right address
    expect((await call(sup, "GET", `/api/v1/events/${J.eventId}/qr/${qrs[0].id}/poster?base=${encodeURIComponent("https://photos.example.test")}`)).statusCode).toBe(200);
  });
});

describe("B. The guest takes part (steps 10-17)", () => {
  it("10. the guest scans the QR code and is sent to the event website", async () => {
    const r = await app.inject({ method: "GET", url: `/api/v1/public/q/${J.qrCode}` });
    expect(r.statusCode).toBeGreaterThanOrEqual(300); expect(r.statusCode).toBeLessThan(400); expect(r.headers.location).toContain(`/g/${J.guestToken}`);
    expect((await pool.query("SELECT count(*)::int n FROM qr_scan_events WHERE event_id=$1", [J.eventId])).rows[0].n).toBe(1);            // the scan was counted
  });
  it("11. the guest sees the customised event website (nothing else about the event leaks)", async () => {
    const j = (await app.inject({ method: "GET", url: G() })).json();
    expect(j.definition.theme).toMatchObject({ textColor: "#fff4e6", accentColor: "#ff2e63", fontFamily: "serif" }); expect(j.definition.theme.background).toMatchObject({ type: "color", color: "#0a1b2c" });
    expect(j.definition.welcome.components.find((c: any) => c.type === "heading").props.text).toContain("Welcome to the Gala");
    expect(j.definition.journey.steps.find((s: any) => s.id === "welcome").buttonLabel).toBe("BEGIN"); expect(j.definition.messages.success).toMatch(/print desk/);
    expect(j.event).toMatchObject({ name: "Acceptance Gala 2026", hashtag: "GalaNight", clientName: "Globex Corporation" }); expect(j.logos).toMatchObject({ client: true });
    expect(Object.keys(j.event).sort()).toEqual(["clientName", "eventDate", "hashtag", "name"]);
    expect((await app.inject({ method: "GET", url: `${G()}/logo/client` })).statusCode).toBe(200);
  });
  it("12. the guest uploads a photograph", async () => {
    const s = await app.inject({ method: "POST", url: `${G()}/session`, payload: { consent: true, fields: {} } });
    expect(s.statusCode).toBe(201); J.sid = s.json().sessionId; J.code = s.json().guestCode;
    const photo = await sharp({ create: { width: 1500, height: 2250, channels: 3, background: "#3a86ff" } }).composite([{ input: Buffer.from("<svg width='1500' height='2250' xmlns='http://www.w3.org/2000/svg'><circle cx='750' cy='900' r='400' fill='#ffbe0b'/></svg>") }]).jpeg().toBuffer();
    const r = await app.inject({ method: "POST", url: `${G()}/photo`, payload: photo, headers: { ...OCT, "x-guest-session": J.sid } });
    expect(r.statusCode).toBe(201); J.upload = r.json().uploadId; J.originalSha = sha(photo);
    expect((await pool.query("SELECT sha256 FROM photo_uploads WHERE id=$1", [J.upload])).rows[0].sha256).toBe(J.originalSha);          // the original is stored untouched
  });
  it("13. the guest selects a frame (only active frames are offered)", async () => {
    const frames = (await app.inject({ method: "GET", url: `${G()}/frames` })).json().frames;
    expect(frames.map((f: any) => f.name).sort()).toEqual(["Classic", "Gold banner"]); expect(frames.find((f: any) => f.name === "Gold banner").layers.some((l: any) => l.type === "image")).toBe(true);
    J.chosen = frames.find((f: any) => f.name === "Gold banner").id;
  });
  it("14. the guest adjusts the photo (rotate, zoom, move)", async () => {
    J.adjust = { rotate: 0, zoom: 1.4, offsetX: 0.1, offsetY: -0.05 };
    const r = await app.inject({ method: "PUT", url: `${G()}/photo/${J.upload}/adjust`, payload: J.adjust, headers: { "x-guest-session": J.sid } });
    expect(r.statusCode).toBe(200);
    expect((await pool.query("SELECT adjust FROM photo_uploads WHERE id=$1", [J.upload])).rows[0].adjust).toMatchObject({ zoom: 1.4, offsetX: 0.1 });
    expect((await app.inject({ method: "PUT", url: `${G()}/photo/${J.upload}/adjust`, payload: { rotate: 0, zoom: 99, offsetX: 0, offsetY: 0 }, headers: { "x-guest-session": J.sid } })).statusCode).toBe(400);   // nonsense is refused
  });
  it("15. the guest previews the final image: one 300-DPI picture made on the server", async () => {
    const r = await app.inject({ method: "POST", url: `${G()}/compose`, payload: { frameId: J.chosen, slots: [{ slot: 1, uploadId: J.upload, adjust: J.adjust }] } as any, headers: { "x-guest-session": J.sid } });
    expect(r.statusCode).toBe(201); J.cid = r.json().compositionId; J.finalUrl = r.json().url;
    const img = await app.inject({ method: "GET", url: J.finalUrl });
    expect(img.statusCode).toBe(200); expect(img.headers["content-type"]).toBe("image/jpeg");
    const m = await sharp(img.rawPayload).metadata(); expect([m.width, m.height, m.density]).toEqual([1200, 1800, 300]);
    J.finalBytes = img.rawPayload; J.finalSha = sha(img.rawPayload);
    expect((await pool.query("SELECT sha256, width_px, height_px FROM final_compositions WHERE id=$1", [J.cid])).rows[0]).toMatchObject({ sha256: J.finalSha, width_px: 1200, height_px: 1800 });
    await app.inject({ method: "POST", url: `${G()}/composition/${J.cid}/finalize`, headers: { "x-guest-session": J.sid } });
  });
  it("16. the guest downloads the image, and it is byte for byte the stored picture", async () => {
    const r = await app.inject({ method: "GET", url: `${J.finalUrl}&dl=1` });
    expect(r.statusCode).toBe(200); expect(r.headers["content-disposition"]).toMatch(/attachment/); expect(sha(r.rawPayload)).toBe(J.finalSha);
    expect((await app.inject({ method: "GET", url: J.finalUrl.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(40)) })).statusCode).toBe(404);     // the link cannot be forged
  });
  it("17. the guest shares through the supported workflow; it is recorded as an ATTEMPT (real Instagram is not testable here)", async () => {
    const r = await app.inject({ method: "POST", url: `${G()}/composition/${J.cid}/share`, payload: { channel: "instagram" } as any, headers: { "x-guest-session": J.sid } });
    expect(r.statusCode).toBe(201); expect(r.json()).toEqual({ ok: true, outcome: "attempted" });
    expect((await pool.query("SELECT channel, outcome FROM share_events WHERE composition_id=$1", [J.cid])).rows).toEqual([{ channel: "instagram", outcome: "attempted" }]);
    const cfg = (await app.inject({ method: "GET", url: G() })).json().settings;
    expect(cfg.share.channels.instagram).toBe(true);                                                                // the share screen offers the Instagram hand-off with caption, hashtag and instructions
  });
});

describe("C. Staff, printing, wall and analytics (steps 18-24)", () => {
  it("18. the final image appears in the admin dashboard", async () => {
    const list = (await call(sup, "GET", `/api/v1/events/${J.eventId}/compositions`)).json();
    expect(list.total).toBe(1); expect(list.compositions[0]).toMatchObject({ id: J.cid, guestCode: J.code, moderation: "pending", finalized: true });
    expect((await call(sup, "GET", `/api/v1/events/${J.eventId}/compositions/${J.cid}/thumb`)).statusCode).toBe(200);
    const ov = (await call(sup, "GET", "/api/v1/dashboard/overview")).json(); expect(ov).toMatchObject({ totalSubmissions: 1, photosPending: 1, shareAttempts: 1 });
  });
  it("19. the operator approves the image for printing", async () => {
    await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,'print_operator')", [J.operatorId, J.eventId]);
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "operator@acc.test", password: PW } }); operator = { cookie: (r.headers["set-cookie"] as string).split(";")[0], csrf: r.json().csrf };
    const jobs = (await call(operator, "GET", `/api/v1/events/${J.eventId}/print/jobs`)).json();
    J.job = (await pool.query("SELECT id,status FROM print_jobs WHERE composition_id=$1", [J.cid])).rows[0]; expect(J.job.status).toBe("pending"); expect(JSON.stringify(jobs)).toContain(J.job.id);
    expect((await call(operator, "POST", `/api/v1/events/${J.eventId}/print/jobs/${J.job.id}/action`, { action: "approve" })).statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM print_jobs WHERE id=$1", [J.job.id])).rows[0].status).toBe("approved");
    expect((await pool.query("SELECT moderation FROM final_compositions WHERE id=$1", [J.cid])).rows[0].moderation).toBe("approved");
  });
  it("20. the print agent pairs, reports its printer and receives the print job (the agent protocol, over HTTP)", async () => {
    const c = (await call(sup, "POST", `/api/v1/events/${J.eventId}/agents`, { name: "Print desk PC" })).json();
    const reg = await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { code: c.pairingCode, hostName: "PRINT-PC", version: "1.0.0" } });
    expect(reg.statusCode).toBe(201); J.agent = reg.json().deviceToken; J.deviceId = c.deviceId;
    expect((await bearer(J.agent, "POST", "/api/v1/agent/heartbeat", { version: "1.0.0", hostName: "PRINT-PC", printers: [{ name: "DNP DS620", state: "ready", paperSizes: ["4x6", "5x7"] }] })).statusCode).toBe(200);
    const pid = (await pool.query("SELECT id FROM printers WHERE device_id=$1", [J.deviceId])).rows[0].id;
    expect((await call(sup, "PATCH", `/api/v1/events/${J.eventId}/printers/${pid}`, { enabled: true, paperSize: "4x6" })).statusCode).toBe(200);
    const claim = (await bearer(J.agent, "POST", "/api/v1/agent/claim", { printer: "DNP DS620" })).json().job;
    expect(claim).toMatchObject({ id: J.job.id, copies: 1, paperSize: "4x6", widthPx: 1200, heightPx: 1800 }); J.claim = claim;
    expect((await pool.query("SELECT status FROM print_jobs WHERE id=$1", [J.job.id])).rows[0].status).toBe("printing");
    expect((await bearer(J.agent, "POST", "/api/v1/agent/claim", { printer: "DNP DS620" })).json()).toEqual({ job: null });             // nothing is handed out twice
  });
  it("21. the agent receives EXACTLY the final image (a physical printer is not testable here)", async () => {
    const img = await bearer(J.agent, "GET", J.claim.imageUrl);
    expect(img.statusCode).toBe(200); expect(img.headers["x-content-sha256"]).toBe(J.finalSha);
    expect(sha(img.rawPayload)).toBe(J.finalSha); expect(img.rawPayload.equals(J.finalBytes)).toBe(true);                       // the file to print == what the guest previewed and downloaded
    const stored = fs.readFileSync(path.join(STORE, (await pool.query("SELECT storage_key FROM final_compositions WHERE id=$1", [J.cid])).rows[0].storage_key));
    expect(stored.equals(img.rawPayload)).toBe(true);
    expect([J.claim.widthPx, J.claim.heightPx]).toEqual([1200, 1800]);                                                          // 4x6 inch at 300 DPI
  });
  it("22. the print job is recorded: status, printer, history, who did what", async () => {
    expect((await bearer(J.agent, "POST", `/api/v1/agent/jobs/${J.job.id}/result`, { ok: true })).statusCode).toBe(200);
    const row = (await pool.query("SELECT status, printer_id, copies FROM print_jobs WHERE id=$1", [J.job.id])).rows[0]; expect(row).toMatchObject({ status: "printed", copies: 1 }); expect(row.printer_id).not.toBeNull();
    const hist = (await pool.query("SELECT from_status,to_status,user_id FROM print_job_events WHERE job_id=$1 ORDER BY id", [J.job.id])).rows;
    expect(hist.map((h) => `${h.from_status ?? "-"}>${h.to_status}`)).toEqual(["->pending", "pending>approved", "approved>printing", "printing>printed"]);
    expect(hist.find((h) => h.to_status === "approved")!.user_id).toBe(J.operatorId);                                            // the approval is attributed to the operator
    const h = (await call(operator, "GET", `/api/v1/events/${J.eventId}/print/history`)).json(); expect(JSON.stringify(h)).toContain("printed");
  });
  it("23. the photo appears on the event photo wall", async () => {
    const w = (await call(sup, "GET", `/api/v1/events/${J.eventId}/wall`)).json();
    expect((await app.inject({ method: "GET", url: `/api/v1/public/w/${w.token}` })).statusCode).toBe(404);                      // wall is off until enabled
    expect((await call(sup, "PUT", `/api/v1/events/${J.eventId}/wall`, { ...w.settings, enabled: true })).statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: `/api/v1/public/w/${w.token}/photos` })).json().photos;
    expect(list.map((p: any) => p.id)).toEqual([J.cid]);
    const img = await app.inject({ method: "GET", url: `/api/v1/public/w/${w.token}/img/${J.cid}?w=800` }); expect(img.statusCode).toBe(200); expect((await sharp(img.rawPayload).metadata()).width).toBeLessThanOrEqual(800);
    await call(sup, "POST", `/api/v1/events/${J.eventId}/compositions/bulk`, { ids: [J.cid], action: "hide_wall" });             // staff can take it off again
    expect((await app.inject({ method: "GET", url: `/api/v1/public/w/${w.token}/photos` })).json().photos).toEqual([]);
    await call(sup, "POST", `/api/v1/events/${J.eventId}/compositions/bulk`, { ids: [J.cid], action: "show_wall" });
  });
  it("24. the admin views the event analytics, and exports them", async () => {
    const s = (await call(sup, "GET", `/api/v1/events/${J.eventId}/reports/summary`)).json();
    expect(s.totals).toMatchObject({ scans: 1, sessions: 1, uploads: 1, frameSelections: 1, completed: 1, instagramAttempts: 1, shareAttempts: 1, printJobs: 1, printed: 1, copiesPrinted: 1, failedAttempts: 0 });
    expect(s.funnel.map((f: any) => f.count)).toEqual([1, 1, 1, 1, 1, 1]);
    const f = (await call(sup, "GET", `/api/v1/events/${J.eventId}/reports/frames`)).json().rows.find((r: any) => r.name === "Gold banner"); expect(f).toMatchObject({ selections: 1, completed: 1, printed: 1 });
    expect((await call(sup, "GET", `/api/v1/events/${J.eventId}/reports/operators`)).json().rows.find((r: any) => r.name === "Operator")).toMatchObject({ printApproved: 1 });
    expect((await call(sup, "GET", `/api/v1/events/${J.eventId}/reports/summary/csv`)).body).toContain("Prints completed,1");
    const pdf = await call(sup, "GET", `/api/v1/events/${J.eventId}/reports/pdf`); expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("D. Archive and retention (step 25)", () => {
  it("25. the event is archived and its photo retention policy is applied: guest data and files deleted, statistics kept", async () => {
    expect((await call(sup, "PATCH", `/api/v1/events/${J.eventId}`, { settings: { retentionDays: 14 } })).statusCode).toBe(200);
    expect((await call(sup, "POST", `/api/v1/events/${J.eventId}/status`, { status: "archived" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: G() })).statusCode).toBe(404);                                                // archived: guests can no longer reach it
    const st = (await call(sup, "GET", `/api/v1/events/${J.eventId}/retention`)).json(); expect(st).toMatchObject({ status: "archived", retentionDays: 14, daysLeft: 14, due: false });
    expect((await runRetention(pool)).purged).toEqual([]);                                                                       // not yet: nothing is deleted early
    const finalKey = (await pool.query("SELECT storage_key FROM final_compositions WHERE id=$1", [J.cid])).rows[0].storage_key;
    expect(fs.existsSync(path.join(STORE, finalKey))).toBe(true);
    await pool.query("UPDATE events SET archived_at = now() - interval '15 days' WHERE id=$1", [J.eventId]);                     // the retention period has now passed
    expect((await runRetention(pool)).purged).toEqual([J.eventId]);
    expect(fs.existsSync(path.join(STORE, finalKey))).toBe(false);
    for (const t of ["guest_sessions", "photo_uploads", "final_compositions", "print_jobs", "share_events", "frame_selections", "qr_scan_events"]) expect((await pool.query(`SELECT count(*)::int n FROM ${t} WHERE event_id=$1`, [J.eventId])).rows[0].n, t).toBe(0);
    const s = (await call(sup, "GET", `/api/v1/events/${J.eventId}/reports/summary`)).json();
    expect(s.archived).toBe(true); expect(s.totals).toMatchObject({ sessions: 1, completed: 1, printed: 1, instagramAttempts: 1, scans: 1 });   // the figures survive, the guest data does not
    expect((await call(sup, "GET", `/api/v1/events/${J.eventId}/frames`)).json().frames).toHaveLength(2);                        // configuration is kept
  });
});
