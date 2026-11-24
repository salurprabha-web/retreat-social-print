import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DEFAULT_WALL_STYLE, presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-wall-"));
process.env.STORAGE_DIR = STORE;
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, viewer: S, opA: S; let evA: string, evB: string, tokA: string, tokB: string, frameA: string, frameB: string;
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$2,$3,$4) RETURNING id", [email, email.split("@")[0], await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S | null, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {} });
const G = (t: string) => `/api/v1/public/g/${t}`;
const W = (t: string) => `/api/v1/public/w/${t}`;
async function mkEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return e as { id: string; guestToken: string };
}
const jpeg = (c: string) => sharp({ create: { width: 1500, height: 2250, channels: 3, background: c } }).jpeg().toBuffer();

/** A guest who composes a picture and (by default) taps Finish. */
async function pic(tok: string, frame: string, o: { optOut?: boolean; finish?: boolean; colour?: string } = {}) {
  const sid = (await app.inject({ method: "POST", url: `${G(tok)}/session`, payload: { consent: true, fields: {}, ...(o.optOut ? { wallOptOut: true } : {}) } })).json().sessionId as string;
  const up = (await app.inject({ method: "POST", url: `${G(tok)}/photo`, payload: await jpeg(o.colour ?? "#336699"), headers: { "content-type": "application/octet-stream", "x-guest-session": sid } })).json().uploadId;
  const cid = (await app.inject({ method: "POST", url: `${G(tok)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
  if (o.finish !== false) await app.inject({ method: "POST", url: `${G(tok)}/composition/${cid}/finalize`, headers: { "x-guest-session": sid } });
  return { sid, cid };
}
const bulk = (ev: string, ids: string[], action: string, extra: object = {}) => adm(sup, "POST", `/api/v1/events/${ev}/compositions/bulk`, { ids, action, ...extra });
const wallState = async (ev: string) => (await adm(sup, "GET", `/api/v1/events/${ev}/wall`)).json();
const settings = (over: object = {}) => ({ enabled: true, moderationRequired: true, displaySeconds: 6, mode: "slideshow", style: DEFAULT_WALL_STYLE, ...over });
const putWall = (ev: string, body: object, s: S | null = sup) => adm(s, "PUT", `/api/v1/events/${ev}/wall`, body);
const ids = async (tok: string) => ((await app.inject({ method: "GET", url: `${W(tok)}/photos` })).json().photos ?? []).map((p: any) => p.id as string);
let wtA = "", wtB = "";

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup12@t.test", "super_admin");
  const a = await mkEvent("Wall A"), b = await mkEvent("Wall B");
  evA = a.id; tokA = a.guestToken; evB = b.id; tokB = b.guestToken;
  const mk = async (ev: string) => (await adm(sup, "POST", `/api/v1/events/${ev}/frames`, { name: "Single", format: "4x6", layers: presetLayers("single", 1200, 1800) })).json().frame.id as string;
  frameA = await mk(evA); frameB = await mk(evB);
  mgrA = await mkUser("mgr12@t.test", "event_manager", evA, "event_manager");
  viewer = await mkUser("view12@t.test", "reporting_viewer", evA, "reporting_viewer");
  opA = await mkUser("op12@t.test", "print_operator", evA, "print_operator");
  wtA = (await wallState(evA)).token; wtB = (await wallState(evB)).token;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("wall settings", () => {
  it("a new event has an off wall with a private link", async () => {
    const s = await wallState(evA);
    expect(s.settings.enabled).toBe(false);
    expect(s.settings.moderationRequired).toBe(true);
    expect(s.token).toMatch(/^[0-9a-f]{24}$/); expect(s.path).toBe(`/w/${s.token}`);
    expect(wtA).not.toBe(wtB);
  });
  it("is permission-checked: viewer reads, only builder editors write, outsiders and anonymous are refused", async () => {
    expect((await adm(viewer, "GET", `/api/v1/events/${evA}/wall`)).statusCode).toBe(200);
    expect((await putWall(evA, settings(), viewer)).statusCode).toBe(403);
    expect((await putWall(evA, settings(), opA)).statusCode).toBe(403);
    expect((await adm(mgrA, "GET", `/api/v1/events/${evB}/wall`)).statusCode).toBe(403);     // manager of A has no access to B
    expect((await putWall(evB, settings(), mgrA)).statusCode).toBe(403);
    expect((await adm(null, "GET", `/api/v1/events/${evA}/wall`)).statusCode).toBe(401);
    expect((await adm({ ...mgrA, csrf: "wrong" }, "PUT", `/api/v1/events/${evA}/wall`, settings())).statusCode).toBe(403);   // CSRF
  });
  it("validates ranges and unknown values", async () => {
    expect((await putWall(evA, settings({ displaySeconds: 1 }))).statusCode).toBe(400);
    expect((await putWall(evA, settings({ mode: "carousel" }))).statusCode).toBe(400);
    expect((await putWall(evA, settings({ style: { ...DEFAULT_WALL_STYLE, accentColor: "red" } }))).statusCode).toBe(400);
    expect((await putWall(evA, settings({ style: { ...DEFAULT_WALL_STYLE, headline: "x".repeat(101) } }))).statusCode).toBe(400);
  });
  it("saves, reads back, and records an audit entry", async () => {
    const r = await putWall(evA, settings({ mode: "grid", displaySeconds: 9, moderationRequired: false, style: { ...DEFAULT_WALL_STYLE, gridColumns: 5, headline: "Hello!" } }), mgrA);
    expect(r.statusCode).toBe(200);
    const s = await wallState(evA);
    expect(s.settings).toMatchObject({ enabled: true, mode: "grid", displaySeconds: 9, moderationRequired: false });
    expect(s.settings.style.gridColumns).toBe(5); expect(s.settings.style.headline).toBe("Hello!");
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='wall_update' AND event_id=$1", [evA])).rowCount).toBeGreaterThan(0);
    await putWall(evA, settings());                      // back to moderated slideshow for the next tests
  });
});

describe("public access", () => {
  it("a disabled wall, a bad link and an event that is not live all look the same: not found", async () => {
    await putWall(evB, settings({ enabled: false }));
    for (const u of [W(wtB), `${W(wtB)}/photos`, `${W(wtB)}/stream`, `${W("0".repeat(24))}`, `${W("nope")}/photos`])
      expect((await app.inject({ method: "GET", url: u })).statusCode).toBe(404);
    await putWall(evB, settings());
    expect((await app.inject({ method: "GET", url: W(wtB) })).statusCode).toBe(200);
    await adm(sup, "POST", `/api/v1/events/${evB}/status`, { status: "inactive" });
    expect((await app.inject({ method: "GET", url: W(wtB) })).statusCode).toBe(404);
    await adm(sup, "POST", `/api/v1/events/${evB}/status`, { status: "active" });
    expect((await app.inject({ method: "GET", url: W(wtB) })).statusCode).toBe(200);
  });
  it("exposes only what a display needs (no guest data, no other tokens except the join link)", async () => {
    const j = (await app.inject({ method: "GET", url: W(wtA) })).json();
    expect(Object.keys(j).sort()).toEqual(["event", "imageSizes", "joinPath", "logos", "settings"]);
    expect(j.joinPath).toBe(`/g/${tokA}`);
    expect(j.settings.style.background).toBeTruthy();
  });
  it("the guest page tells guests whether a wall exists", async () => {
    expect((await app.inject({ method: "GET", url: G(tokA) })).json().settings.photoWallEnabled).toBe(true);
    await putWall(evB, settings({ enabled: false }));
    expect((await app.inject({ method: "GET", url: G(tokB) })).json().settings.photoWallEnabled).toBe(false);
    await putWall(evB, settings());
  });
  it("regenerating the link kills the old one at once, and needs the right to edit", async () => {
    expect((await adm(viewer, "POST", `/api/v1/events/${evB}/wall/regenerate-token`, {})).statusCode).toBe(403);
    const r = (await adm(sup, "POST", `/api/v1/events/${evB}/wall/regenerate-token`, {})).json();
    expect(r.token).not.toBe(wtB);
    expect((await app.inject({ method: "GET", url: W(wtB) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: W(r.token) })).statusCode).toBe(200);
    wtB = r.token;
  });
});

describe("which pictures may appear", () => {
  it("only finished pictures, and with moderation on only approved ones", async () => {
    await putWall(evA, settings({ moderationRequired: true }));
    const done = await pic(tokA, frameA);
    const editing = await pic(tokA, frameA, { finish: false });
    expect(await ids(wtA)).not.toContain(done.cid);         // pending
    expect(await ids(wtA)).not.toContain(editing.cid);      // never finished
    await bulk(evA, [done.cid, editing.cid], "approve");
    const list = await ids(wtA);
    expect(list).toContain(done.cid);
    expect(list).not.toContain(editing.cid);                 // approved but still being edited
  });
  it("rejecting or hiding removes a picture, showing it again brings it back, and the image route agrees", async () => {
    const p = await pic(tokA, frameA); await bulk(evA, [p.cid], "approve");
    expect(await ids(wtA)).toContain(p.cid);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${p.cid}?w=800` })).statusCode).toBe(200);
    await bulk(evA, [p.cid], "hide_wall");
    expect(await ids(wtA)).not.toContain(p.cid);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${p.cid}?w=800` })).statusCode).toBe(404);   // cached file does not leak it
    await bulk(evA, [p.cid], "show_wall");
    expect(await ids(wtA)).toContain(p.cid);
    await bulk(evA, [p.cid], "reject");
    expect(await ids(wtA)).not.toContain(p.cid);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${p.cid}` })).statusCode).toBe(404);
    await bulk(evA, [p.cid], "approve");
    expect(await ids(wtA)).toContain(p.cid);
  });
  it("with moderation off a pending picture shows, but a rejected one still never does", async () => {
    const p = await pic(tokA, frameA);
    await putWall(evA, settings({ moderationRequired: false }));
    expect(await ids(wtA)).toContain(p.cid);
    await bulk(evA, [p.cid], "reject");
    expect(await ids(wtA)).not.toContain(p.cid);
    await putWall(evA, settings({ moderationRequired: true }));
    const q = await pic(tokA, frameA);
    expect(await ids(wtA)).not.toContain(q.cid);             // switching moderation back on hides unapproved again
  });
  it("a guest who opts out is never shown, however it is approved", async () => {
    const p = await pic(tokA, frameA, { optOut: true });
    await bulk(evA, [p.cid], "approve");
    expect(await ids(wtA)).not.toContain(p.cid);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${p.cid}` })).statusCode).toBe(404);
    expect((await pool.query("SELECT wall_opt_out FROM guest_sessions WHERE id=$1", [p.sid])).rows[0].wall_opt_out).toBe(true);
    expect((await wallState(evA)).stats.optedOut).toBeGreaterThan(0);
  });
  it("a deleted picture disappears and its cached wall images are removed from disk", async () => {
    const p = await pic(tokA, frameA); await bulk(evA, [p.cid], "approve");
    await app.inject({ method: "GET", url: `${W(wtA)}/img/${p.cid}?w=800` });
    const cached = path.join(STORE, "events", evA, "wall", `${p.cid}-800.jpg`);
    expect(fs.existsSync(cached)).toBe(true);
    expect((await bulk(evA, [p.cid], "delete", { confirmPrinted: true })).statusCode).toBe(200);
    expect(await ids(wtA)).not.toContain(p.cid);
    expect(fs.existsSync(cached)).toBe(false);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${p.cid}` })).statusCode).toBe(404);
  });
  it("deleting a guest's data removes their pictures from the wall too", async () => {
    const p = await pic(tokA, frameA); await bulk(evA, [p.cid], "approve");
    expect(await ids(wtA)).toContain(p.cid);
    const code = (await pool.query("SELECT guest_code FROM guest_sessions WHERE id=$1", [p.sid])).rows[0].guest_code;
    expect((await adm(sup, "DELETE", `/api/v1/events/${evA}/guests/${code}`)).statusCode).toBe(200);
    expect(await ids(wtA)).not.toContain(p.cid);
  });
  it("events never see each other's pictures", async () => {
    const a = await pic(tokA, frameA); const b = await pic(tokB, frameB);
    await bulk(evA, [a.cid], "approve"); await bulk(evB, [b.cid], "approve");
    expect(await ids(wtA)).toContain(a.cid); expect(await ids(wtA)).not.toContain(b.cid);
    expect(await ids(wtB)).toContain(b.cid); expect(await ids(wtB)).not.toContain(a.cid);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${b.cid}` })).statusCode).toBe(404);   // right link, other event's picture
    expect((await app.inject({ method: "POST", url: `${W(wtA)}/shown`, payload: { ids: [b.cid] } })).json().counted).toBe(0);
  });
  it("lists newest first and caps the list", async () => {
    const first = await pic(tokB, frameB); await bulk(evB, [first.cid], "approve");
    const second = await pic(tokB, frameB); await bulk(evB, [second.cid], "approve");
    const list = await ids(wtB);
    expect(list.indexOf(second.cid)).toBeLessThan(list.indexOf(first.cid));
    expect(list.length).toBeLessThanOrEqual(500);
  });
  it("admin stats count what is eligible, waiting and hidden", async () => {
    const p = await pic(tokA, frameA);
    const before = await wallState(evA);
    await bulk(evA, [p.cid], "approve");
    const after = await wallState(evA);
    expect(after.stats.eligible).toBe(before.stats.eligible + 1);
    expect(after.stats.pendingModeration).toBe(before.stats.pendingModeration - 1);
    await bulk(evA, [p.cid], "hide_wall");
    const hidden = await wallState(evA);
    expect(hidden.stats.eligible).toBe(after.stats.eligible - 1);
    expect(hidden.stats.hidden).toBe(after.stats.hidden + 1);
  });
});

describe("images", () => {
  let cid = "";
  beforeAll(async () => { const p = await pic(tokA, frameA, { colour: "#aa3355" }); cid = p.cid; await bulk(evA, [cid], "approve"); });
  it("serves resized JPEGs per size, caches them, and is cacheable by the display only (private)", async () => {
    for (const w of [800, 1600]) {
      const r = await app.inject({ method: "GET", url: `${W(wtA)}/img/${cid}?w=${w}` });
      expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toBe("image/jpeg");
      expect(r.headers["cache-control"]).toMatch(/private/); expect(r.headers["cache-control"]).not.toMatch(/no-store/);
      const m = await sharp(r.rawPayload).metadata();
      expect(Math.max(m.width!, m.height!)).toBeLessThanOrEqual(w);
      expect(fs.existsSync(path.join(STORE, "events", evA, "wall", `${cid}-${w}.jpg`))).toBe(true);
    }
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${cid}` })).statusCode).toBe(200);          // default size
    const again = await app.inject({ method: "GET", url: `${W(wtA)}/img/${cid}?w=800` });                    // served from the cache
    expect(again.statusCode).toBe(200);
  });
  it("refuses sizes that are not offered and ids that are not ids", async () => {
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${cid}?w=5000` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/${cid}?w=abc` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/img/..%2F..%2Fx` })).statusCode).toBe(404);
  });
  it("everything else stays uncacheable", async () => {
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/photos` })).headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "GET", url: W(wtA) })).headers["cache-control"]).toBe("no-store");
  });
  it("the event logo is served only when one is set", async () => {
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/logo/event` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${W(wtA)}/logo/other` })).statusCode).toBe(404);
  });
});

describe("shown counts", () => {
  it("counts each report of an eligible picture, ignores ones that may not be shown", async () => {
    const ok = await pic(tokA, frameA); await bulk(evA, [ok.cid], "approve");
    const hidden = await pic(tokA, frameA);                                 // pending: not eligible
    const r1 = await app.inject({ method: "POST", url: `${W(wtA)}/shown`, payload: { ids: [ok.cid, hidden.cid, ok.cid] } });
    expect(r1.json().counted).toBe(1);
    await app.inject({ method: "POST", url: `${W(wtA)}/shown`, payload: { ids: [ok.cid] } });
    const row = (await pool.query("SELECT shown_count FROM wall_views WHERE composition_id=$1", [ok.cid])).rows[0];
    expect(row.shown_count).toBe(2);
    expect((await pool.query("SELECT 1 FROM wall_views WHERE composition_id=$1", [hidden.cid])).rowCount).toBe(0);
    expect((await wallState(evA)).stats.totalShown).toBeGreaterThanOrEqual(2);
  });
  it("rejects malformed reports", async () => {
    expect((await app.inject({ method: "POST", url: `${W(wtA)}/shown`, payload: { ids: ["x"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${W(wtA)}/shown`, payload: { ids: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${W("0".repeat(24))}/shown`, payload: { ids: ["00000000-0000-4000-8000-000000000000"] } })).statusCode).toBe(404);
  });
  it("counts are removed with the picture", async () => {
    const p = await pic(tokA, frameA); await bulk(evA, [p.cid], "approve");
    await app.inject({ method: "POST", url: `${W(wtA)}/shown`, payload: { ids: [p.cid] } });
    expect((await pool.query("SELECT 1 FROM wall_views WHERE composition_id=$1", [p.cid])).rowCount).toBe(1);
    await bulk(evA, [p.cid], "delete", { confirmPrinted: true });
    expect((await pool.query("SELECT 1 FROM wall_views WHERE composition_id=$1", [p.cid])).rowCount).toBe(0);
  });
});

describe("live updates", () => {
  it("an open display receives a tick when a picture is approved, and a closed one is cleaned up", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${W(wtA)}/stream`, { signal: ac.signal });
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    const until = async (needle: string) => { const end = Date.now() + 8000; while (!buf.includes(needle) && Date.now() < end) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } return buf.includes(needle); };
    expect(await until("event: hello")).toBe(true);
    const p = await pic(tokA, frameA);                                       // finishing a picture ticks
    expect(await until("event: tick")).toBe(true);
    buf = "";
    await bulk(evA, [p.cid], "approve");                                     // approving ticks
    expect(await until("event: tick")).toBe(true);
    ac.abort();
    const { wallBus } = await import("../src/wallBus");
    await new Promise((r) => setTimeout(r, 100));
    expect(wallBus.listenerCount(evA)).toBe(0);
  });
  it("a stream for a disabled wall is refused", async () => {
    await putWall(evB, settings({ enabled: false }));
    expect((await app.inject({ method: "GET", url: `${W(wtB)}/stream` })).statusCode).toBe(404);
  });
});
