import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DEFAULT_WALL_STYLE, presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-sp-"));
process.env.STORAGE_DIR = STORE;
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, viewer: S, opA: S; let evA: string, evB: string, tokA: string, tokB: string;
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$2,$3,$4) RETURNING id", [email, email.split("@")[0], await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { ...(s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {}), ...headers } });
const G = (t: string) => `/api/v1/public/g/${t}`;
async function mkEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return e as { id: string; guestToken: string };
}
const png = (colour: string, w = 200, h = 100) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
const upload = (s: S | null, ev: string, id: string, body: Buffer | string) => adm(s, "POST", `/api/v1/events/${ev}/sponsors/${id}/logo`, body as any, { "content-type": "application/octet-stream" });
const mk = async (ev: string, over: object = {}) => (await adm(sup, "POST", `/api/v1/events/${ev}/sponsors`, { name: "Acme", ...over })).json().sponsor;
const jpeg = (c: string) => sharp({ create: { width: 1500, height: 2250, channels: 3, background: c } }).jpeg().toBuffer();
const files = (ev: string) => { const d = path.join(STORE, "events", ev, "sponsors"); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const sponsorBody = (over: object = {}) => ({ name: "Acme Corp", url: "https://acme.test", hashtag: "AcmeLive", active: true, placement: { guest: true, wall: true }, ...over });

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup13@t.test", "super_admin");
  const a = await mkEvent("Sponsor A"), b = await mkEvent("Sponsor B");
  evA = a.id; tokA = a.guestToken; evB = b.id; tokB = b.guestToken;
  mgrA = await mkUser("mgr13@t.test", "event_manager", evA, "event_manager");
  viewer = await mkUser("view13@t.test", "reporting_viewer", evA, "reporting_viewer");
  opA = await mkUser("op13@t.test", "print_operator", evA, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("sponsor management", () => {
  it("creates with defaults, cleans the hashtag, lists in order, and audits", async () => {
    const r = await adm(mgrA, "POST", `/api/v1/events/${evA}/sponsors`, { name: "  Acme Corp ", url: "https://acme.test", hashtag: "#AcmeLive" });
    expect(r.statusCode).toBe(201);
    expect(r.json().sponsor).toMatchObject({ name: "Acme Corp", url: "https://acme.test", hashtag: "AcmeLive", active: true, hasLogo: false, frames: 0, placement: { guest: true, wall: true } });
    await mk(evA, { name: "Beta" });
    const l = (await adm(viewer, "GET", `/api/v1/events/${evA}/sponsors`)).json();
    expect(l.sponsors.map((x: any) => x.name)).toEqual(["Acme Corp", "Beta"]);
    expect(l.max).toBe(20);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='sponsor_create' AND event_id=$1", [evA])).rowCount).toBeGreaterThan(0);
  });
  it("checks permissions, events and CSRF", async () => {
    const s = (await adm(sup, "GET", `/api/v1/events/${evA}/sponsors`)).json().sponsors[0];
    expect((await adm(viewer, "POST", `/api/v1/events/${evA}/sponsors`, { name: "X" })).statusCode).toBe(403);
    expect((await adm(opA, "PUT", `/api/v1/events/${evA}/sponsors/${s.id}`, sponsorBody())).statusCode).toBe(403);
    expect((await adm(null, "GET", `/api/v1/events/${evA}/sponsors`)).statusCode).toBe(401);
    expect((await adm(mgrA, "GET", `/api/v1/events/${evB}/sponsors`)).statusCode).toBe(403);
    expect((await adm({ ...mgrA, csrf: "bad" }, "POST", `/api/v1/events/${evA}/sponsors`, { name: "X" })).statusCode).toBe(403);
    expect((await adm(sup, "PUT", `/api/v1/events/${evB}/sponsors/${s.id}`, sponsorBody({ name: "Hijack" }))).statusCode).toBe(404);   // other event's id
  });
  it("validates links, hashtags, names and the per-event limit", async () => {
    for (const body of [{ name: "" }, { name: "A", url: "http://x.test" }, { name: "A", url: "javascript:alert(1)" }, { name: "A", hashtag: "two words" }])
      expect((await adm(sup, "POST", `/api/v1/events/${evA}/sponsors`, body)).statusCode).toBe(400);
    const c = await mkEvent("Sponsor Limit");
    for (let i = 0; i < 20; i++) expect((await adm(sup, "POST", `/api/v1/events/${c.id}/sponsors`, { name: `S${i}` })).statusCode).toBe(201);
    expect((await adm(sup, "POST", `/api/v1/events/${c.id}/sponsors`, { name: "one too many" })).statusCode).toBe(409);
  });
  it("edits and reorders; reorder needs exactly the event's sponsors", async () => {
    const list = (await adm(sup, "GET", `/api/v1/events/${evA}/sponsors`)).json().sponsors;
    const [a, b] = list;
    const u = await adm(mgrA, "PUT", `/api/v1/events/${evA}/sponsors/${a.id}`, sponsorBody({ name: "Acme Renamed", url: null, hashtag: "#New_Tag", active: false, placement: { guest: false, wall: true } }));
    expect(u.json().sponsor).toMatchObject({ name: "Acme Renamed", url: null, hashtag: "New_Tag", active: false, placement: { guest: false, wall: true } });
    expect((await adm(sup, "POST", `/api/v1/events/${evA}/sponsors/reorder`, { ids: [b.id] })).statusCode).toBe(400);
    expect((await adm(sup, "POST", `/api/v1/events/${evA}/sponsors/reorder`, { ids: list.map((x: any) => x.id).reverse() })).statusCode).toBe(200);
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/sponsors`)).json().sponsors.map((x: any) => x.id)).toEqual([b.id, a.id]);
  });
});

describe("sponsor logos", () => {
  let sp: any;
  beforeAll(async () => { sp = await mk(evB, { name: "Logo Co" }); });
  it("stores a valid image by its bytes, serves it to staff, and replaces the old file", async () => {
    const r = await upload(sup, evB, sp.id, await png("#ff0000"));
    expect(r.statusCode).toBe(201); expect(r.json().sponsor.hasLogo).toBe(true);
    expect(files(evB)).toHaveLength(1);
    const got = await adm(sup, "GET", `/api/v1/events/${evB}/sponsors/${sp.id}/logo`);
    expect(got.statusCode).toBe(200); expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["content-security-policy"]).toMatch(/sandbox/);
    await upload(sup, evB, sp.id, await png("#00ff00"));
    expect(files(evB)).toHaveLength(1);                       // old file removed
  });
  it("refuses non-images, script in SVG, huge files, empty bodies and the wrong event", async () => {
    expect((await upload(sup, evB, sp.id, "just text")).statusCode).toBe(415);
    expect((await upload(sup, evB, sp.id, Buffer.alloc(0))).statusCode).toBe(415);
    expect((await upload(sup, evB, sp.id, "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")).statusCode).toBe(422);
    expect((await upload(sup, evB, sp.id, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2.5 * 1024 * 1024)]))).statusCode).toBe(413);
    expect((await upload(sup, evB, sp.id, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\" fill=\"red\"/></svg>")).statusCode).toBe(201);   // a safe SVG is fine
    expect((await upload(sup, evA, sp.id, await png("#0000ff"))).statusCode).toBe(404);      // sponsor belongs to B
    expect((await upload(viewer, evA, sp.id, await png("#0000ff"))).statusCode).toBe(403);
    expect(files(evB)).toHaveLength(1);
  });
  it("removing the logo or the sponsor deletes the file", async () => {
    expect((await adm(sup, "DELETE", `/api/v1/events/${evB}/sponsors/${sp.id}/logo`)).json().sponsor.hasLogo).toBe(false);
    expect(files(evB)).toHaveLength(0);
    await upload(sup, evB, sp.id, await png("#ff0000"));
    expect(files(evB)).toHaveLength(1);
    expect((await adm(sup, "DELETE", `/api/v1/events/${evB}/sponsors/${sp.id}`)).statusCode).toBe(200);
    expect(files(evB)).toHaveLength(0);
    expect((await adm(sup, "GET", `/api/v1/events/${evB}/sponsors/${sp.id}/logo`)).statusCode).toBe(404);
  });
});

describe("what guests and the wall can see", () => {
  let guestOnly: any, wallOnly: any, off: any;
  beforeAll(async () => {
    await pool.query("DELETE FROM sponsors WHERE event_id=$1", [evA]);
    guestOnly = await mk(evA, { name: "GuestOnly", hashtag: "#GuestTag", placement: { guest: true, wall: false }, url: "https://guest.test" });
    wallOnly = await mk(evA, { name: "WallOnly", placement: { guest: false, wall: true } });
    off = await mk(evA, { name: "Off", hashtag: "#OffTag", active: false });
    for (const s of [guestOnly, wallOnly, off]) await upload(sup, evA, s.id, await png("#336699"));
    await adm(sup, "PUT", `/api/v1/events/${evA}/wall`, { enabled: true, moderationRequired: true, displaySeconds: 6, mode: "slideshow", style: DEFAULT_WALL_STYLE });
  });
  it("the guest config lists only active guest sponsors and exposes no private fields", async () => {
    const j = (await app.inject({ method: "GET", url: G(tokA) })).json();
    expect(j.sponsors).toHaveLength(1);
    expect(j.sponsors[0]).toEqual({ id: guestOnly.id, name: "GuestOnly", url: "https://guest.test", hashtag: "GuestTag", hasLogo: true, placement: { guest: true, wall: false } });
    expect(JSON.stringify(j)).not.toContain("OffTag");
  });
  it("guest logo route: only active sponsors placed on guest screens, never across events", async () => {
    const url = (t: string, id: string) => `${G(t)}/sponsor/${id}/logo`;
    const ok = await app.inject({ method: "GET", url: url(tokA, guestOnly.id) });
    expect(ok.statusCode).toBe(200); expect(ok.headers["content-type"]).toBe("image/png"); expect(ok.headers["cache-control"]).toMatch(/private/);
    for (const id of [wallOnly.id, off.id]) expect((await app.inject({ method: "GET", url: url(tokA, id) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: url(tokB, guestOnly.id) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: url(tokA, "not-a-uuid") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: url("0".repeat(24), guestOnly.id) })).statusCode).toBe(404);
  });
  it("a sponsor that is not shown to guests still reaches them when it owns an active frame (its logo is in the frame preview)", async () => {
    const fr = await adm(sup, "POST", `/api/v1/events/${evA}/frames`, { name: "WallOnly frame", format: "4x6", layers: presetLayers("single", 1200, 1800), sponsorId: wallOnly.id });
    expect(fr.statusCode).toBe(201);
    const j = (await app.inject({ method: "GET", url: G(tokA) })).json();
    expect(j.sponsors.map((x: any) => x.name).sort()).toEqual(["GuestOnly", "WallOnly"]);
    expect(j.sponsors[0]).not.toHaveProperty("framed");
    expect((await app.inject({ method: "GET", url: `${G(tokA)}/sponsor/${wallOnly.id}/logo` })).statusCode).toBe(200);
    await adm(sup, "PUT", `/api/v1/events/${evA}/frames/${fr.json().frame.id}`, { name: "x", format: "4x6", orientation: "portrait", layers: fr.json().frame.layers, active: false });
    expect((await app.inject({ method: "GET", url: `${G(tokA)}/sponsor/${wallOnly.id}/logo` })).statusCode).toBe(404);   // frame switched off: back to hidden
  });
  it("the wall lists and serves only active wall sponsors that have a logo, and only while the wall is on", async () => {
    const wt = (await adm(sup, "GET", `/api/v1/events/${evA}/wall`)).json().token;
    const info = (await app.inject({ method: "GET", url: `/api/v1/public/w/${wt}` })).json();
    expect(info.sponsors).toEqual([{ id: wallOnly.id, name: "WallOnly" }]);
    expect((await app.inject({ method: "GET", url: `/api/v1/public/w/${wt}/sponsor/${wallOnly.id}/logo` })).statusCode).toBe(200);
    for (const id of [guestOnly.id, off.id]) expect((await app.inject({ method: "GET", url: `/api/v1/public/w/${wt}/sponsor/${id}/logo` })).statusCode).toBe(404);
    await adm(sup, "PUT", `/api/v1/events/${evA}/wall`, { enabled: false, moderationRequired: true, displaySeconds: 6, mode: "slideshow", style: DEFAULT_WALL_STYLE });
    expect((await app.inject({ method: "GET", url: `/api/v1/public/w/${wt}/sponsor/${wallOnly.id}/logo` })).statusCode).toBe(404);
  });
});

describe("sponsor frames", () => {
  let sp: any, frame: string;
  const layersWithLogo = () => {
    const base = presetLayers("single", 1200, 1800).filter((l) => l.type === "photo").map((l) => ({ ...l, x: 0.05, y: 0.03, w: 0.9, h: 0.75 }));
    return [...base, { id: "lg1", type: "logo", which: "sponsor", x: 0.3, y: 0.85, w: 0.4, h: 0.1, rotation: 0, opacity: 1, locked: false, hidden: false }];
  };
  beforeAll(async () => {
    sp = await mk(evB, { name: "Frame Sponsor", hashtag: "FrameTag" });
    await upload(sup, evB, sp.id, await png("#ff0000"));
  });
  it("assigns a sponsor to a frame, keeps it when a save omits it, and refuses another event's sponsor", async () => {
    const other = await mk(evA, { name: "Foreign" });
    const bad = await adm(sup, "POST", `/api/v1/events/${evB}/frames`, { name: "Bad", format: "4x6", layers: layersWithLogo(), sponsorId: other.id });
    expect(bad.statusCode).toBe(400); expect(bad.json().error).toBe("sponsor_not_found");
    const c = await adm(sup, "POST", `/api/v1/events/${evB}/frames`, { name: "Sponsored", format: "4x6", layers: layersWithLogo(), sponsorId: sp.id });
    expect(c.statusCode).toBe(201); frame = c.json().frame.id;
    expect(c.json().frame.sponsorId).toBe(sp.id);
    const cur = c.json().frame;
    const save = (extra: object) => adm(sup, "PUT", `/api/v1/events/${evB}/frames/${frame}`, { name: cur.name, format: cur.format, orientation: cur.orientation, layers: cur.layers, ...extra });
    expect((await save({})).json().frame.sponsorId).toBe(sp.id);                                   // omitted = unchanged
    expect((await save({ sponsorId: other.id })).statusCode).toBe(400);
    expect((await adm(sup, "GET", `/api/v1/events/${evB}/sponsors`)).json().sponsors.find((x: any) => x.id === sp.id).frames).toBe(1);
    const dup = (await adm(sup, "POST", `/api/v1/events/${evB}/frames/${frame}/duplicate`, {})).json().frame;
    expect(dup.sponsorId).toBe(sp.id);
    expect((await app.inject({ method: "GET", url: `${G(tokB)}/frames` })).json().frames.find((f: any) => f.id === frame).sponsorId).toBe(sp.id);
  });
  it("prints the sponsor's logo on the final picture, and a switched-off sponsor changes the picture", async () => {
    const sid = (await app.inject({ method: "POST", url: `${G(tokB)}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
    const h = { "x-guest-session": sid };
    const up = (await app.inject({ method: "POST", url: `${G(tokB)}/photo`, payload: await jpeg("#2244aa"), headers: { ...h, "content-type": "application/octet-stream" } })).json().uploadId;
    const compose = () => app.inject({ method: "POST", url: `${G(tokB)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: h });
    const pixel = async (cid: string) => {
      const key = (await pool.query("SELECT storage_key FROM final_compositions WHERE id=$1", [cid])).rows[0].storage_key;
      const { data, info } = await sharp(path.join(STORE, key)).raw().toBuffer({ resolveWithObject: true });
      const at = (Math.round(info.height * 0.9) * info.width + Math.round(info.width * 0.5)) * info.channels;
      return [data[at], data[at + 1], data[at + 2]];
    };
    const first = (await compose()).json();
    const [r, g, b] = await pixel(first.compositionId);
    expect(r).toBeGreaterThan(200); expect(g).toBeLessThan(60); expect(b).toBeLessThan(60);      // the red logo is on the print
    expect((await compose()).json().duplicate).toBe(true);                                     // same inputs, same picture

    await adm(sup, "PUT", `/api/v1/events/${evB}/sponsors/${sp.id}`, sponsorBody({ name: "Frame Sponsor", url: null, hashtag: "FrameTag", active: false }));
    const second = (await compose()).json();
    expect(second.duplicate).toBeUndefined();                                                  // not served from the old composition
    const [r2, g2, b2] = await pixel(second.compositionId);
    expect(r2 > 200 && g2 < 60 && b2 < 60).toBe(false);                                         // logo is gone
    await adm(sup, "PUT", `/api/v1/events/${evB}/sponsors/${sp.id}`, sponsorBody({ name: "Frame Sponsor", url: null, hashtag: "FrameTag", active: true }));
  });
  it("deleting a sponsor keeps its frames and clears the link", async () => {
    const r = await adm(sup, "DELETE", `/api/v1/events/${evB}/sponsors/${sp.id}`);
    expect(r.json().framesUnlinked).toBe(2);
    const f = (await adm(sup, "GET", `/api/v1/events/${evB}/frames/${frame}`)).json().frame;
    expect(f.sponsorId).toBeNull();
  });
});
