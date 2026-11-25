import { exists, readStored, listStored } from "./helpers/store";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DEFAULT_MOSAIC, cellRect, presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-mo-"));
process.env.STORAGE_DIR = STORE;
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, viewer: S, opA: S; let evA: string, evB: string, tokA: string, tokB: string, frameA: string, frameB: string;
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };
const RED = "#dc1e1e", BLUE = "#1e1edc";

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$2,$3,$4) RETURNING id", [email, email.split("@")[0], await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { ...(s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {}), ...headers } });
const G = (t: string) => `/api/v1/public/g/${t}`;
const M = (t: string) => `/api/v1/public/m/${t}`;
async function mkEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  const photo = presetLayers("single", 1200, 1800).find((l) => l.type === "photo")!;
  const fr = await adm(sup, "POST", `/api/v1/events/${e.id}/frames`, { name: "Full", format: "4x6", layers: [{ ...photo, x: 0, y: 0, w: 1, h: 1 }] });
  return { ...(e as { id: string; guestToken: string }), frame: fr.json().frame.id as string };
}
const solid = (c: string, w = 1200, h = 1800) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).jpeg().toBuffer();
/** 2:1 master, left half red, right half blue. */
const master = (w = 800, h = 400) => sharp({ create: { width: w, height: h, channels: 3, background: RED } })
  .composite([{ input: { create: { width: w / 2, height: h, channels: 3, background: BLUE } }, left: w / 2, top: 0 }]).png().toBuffer();
async function pic(tok: string, frame: string, colour: string, o: { optOut?: boolean; approve?: boolean; ev?: string } = {}) {
  const sid = (await app.inject({ method: "POST", url: `${G(tok)}/session`, payload: { consent: true, fields: {}, ...(o.optOut ? { wallOptOut: true } : {}) } })).json().sessionId as string;
  const up = (await app.inject({ method: "POST", url: `${G(tok)}/photo`, payload: await solid(colour), headers: { "content-type": "application/octet-stream", "x-guest-session": sid } })).json().uploadId;
  const cid = (await app.inject({ method: "POST", url: `${G(tok)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
  await app.inject({ method: "POST", url: `${G(tok)}/composition/${cid}/finalize`, headers: { "x-guest-session": sid } });
  if (o.approve && o.ev) await bulk(o.ev, [cid], "approve");
  return { sid, cid };
}
const bulk = (ev: string, ids: string[], action: string, extra: object = {}) => adm(sup, "POST", `/api/v1/events/${ev}/compositions/bulk`, { ids, action, ...extra });
const state = async (ev: string, s: S = sup) => (await adm(s, "GET", `/api/v1/events/${ev}/mosaic`)).json();
const settings = (over: object = {}) => ({ ...DEFAULT_MOSAIC, enabled: true, tileTarget: 32, outputWidth: 1600, ...over });
const putM = (ev: string, body: object, s: S | null = sup) => adm(s, "PUT", `/api/v1/events/${ev}/mosaic`, body);
const upMaster = (ev: string, body: Buffer | string, s: S | null = sup) => adm(s, "POST", `/api/v1/events/${ev}/mosaic/master`, body as any, { "content-type": "application/octet-stream" });
const cellOf = async (cid: string) => (await pool.query("SELECT cell FROM mosaic_tiles WHERE composition_id=$1", [cid])).rows[0]?.cell as number | undefined;
const tileCount = async (ev: string) => (await pool.query("SELECT count(*)::int c FROM mosaic_tiles WHERE event_id=$1", [ev])).rows[0].c as number;
const mosaicFiles = (ev: string, sub = "") => listStored(`events/${ev}/mosaic${sub ? "/" + sub : ""}`);
let mtA = "";

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup14@t.test", "super_admin");
  const a = await mkEvent("Mosaic A"), b = await mkEvent("Mosaic B");
  evA = a.id; tokA = a.guestToken; frameA = a.frame; evB = b.id; tokB = b.guestToken; frameB = b.frame;
  mgrA = await mkUser("mgr14@t.test", "event_manager", evA, "event_manager");
  viewer = await mkUser("view14@t.test", "reporting_viewer", evA, "reporting_viewer");
  opA = await mkUser("op14@t.test", "print_operator", evA, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("module and access", () => {
  it("starts off, empty, with a private link", async () => {
    const s = await state(evA);
    expect(s.settings.enabled).toBe(false); expect(s.master).toBeNull(); expect(s.grid).toBeNull();
    expect(s.stats).toMatchObject({ cells: 0, filled: 0, percent: 0 });
    expect(s.token).toMatch(/^[0-9a-f]{24}$/); expect(s.path).toBe(`/m/${s.token}`);
    mtA = s.token;
    expect((await app.inject({ method: "GET", url: M(mtA) })).statusCode).toBe(404);              // module off and no master: nothing is exposed
  });
  it("checks permissions, event scope and CSRF", async () => {
    expect((await adm(viewer, "GET", `/api/v1/events/${evA}/mosaic`)).statusCode).toBe(200);
    expect((await adm(opA, "GET", `/api/v1/events/${evA}/mosaic`)).statusCode).toBe(200);
    expect((await putM(evA, settings(), viewer)).statusCode).toBe(403);
    expect((await putM(evA, settings(), opA)).statusCode).toBe(403);
    expect((await upMaster(evA, await master(), viewer)).statusCode).toBe(403);
    expect((await adm(viewer, "POST", `/api/v1/events/${evA}/mosaic/rebuild`)).statusCode).toBe(403);
    expect((await adm(viewer, "POST", `/api/v1/events/${evA}/mosaic/regenerate-token`)).statusCode).toBe(403);
    expect((await adm(mgrA, "GET", `/api/v1/events/${evB}/mosaic`)).statusCode).toBe(403);
    expect((await putM(evB, settings(), mgrA)).statusCode).toBe(403);
    expect((await adm(null, "GET", `/api/v1/events/${evA}/mosaic`)).statusCode).toBe(401);
    expect((await adm({ ...mgrA, csrf: "bad" }, "PUT", `/api/v1/events/${evA}/mosaic`, settings())).statusCode).toBe(403);
  });
  it("validates settings", async () => {
    for (const bad of [{ tileTarget: 5 }, { tileTarget: 99999 }, { tintPct: 90 }, { outputWidth: 100 }, { empty: "none" }, { logo: { position: "middle", sizePct: 10, plate: true } }, { title: "x".repeat(101) }])
      expect((await putM(evA, settings(bad))).statusCode).toBe(400);
  });
});

describe("master image", () => {
  it("refuses anything that is not a real photo-like raster", async () => {
    expect((await upMaster(evA, "just text")).statusCode).toBe(415);
    expect((await upMaster(evA, Buffer.alloc(0))).statusCode).toBe(415);
    expect((await upMaster(evA, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"500\" height=\"500\"><rect width=\"500\" height=\"500\"/></svg>")).statusCode).toBe(415);
    expect((await upMaster(evA, await master(120, 100))).statusCode).toBe(422);
    expect((await upMaster(evA, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(26 * 1024 * 1024)]))).statusCode).toBe(413);
    expect((await upMaster(evA, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000, 7)]))).statusCode).toBe(415);   // right signature, not decodable
    expect((await mosaicFiles(evA)).filter((f) => f.endsWith(".png"))).toHaveLength(0);
  });
  it("builds a grid that follows the master's shape and reads its colours", async () => {
    await putM(evA, settings());
    const r = await upMaster(evA, await master());
    expect(r.statusCode).toBe(201);
    const s = r.json();
    expect(s.master).toEqual({ width: 800, height: 400 });
    expect(s.grid).toEqual({ cols: 8, rows: 4, cells: 32 });
    const p = (await pool.query("SELECT cell_colors FROM mosaic_projects WHERE event_id=$1", [evA])).rows[0];
    expect(p.cell_colors).toHaveLength(32 * 6);
    expect(p.cell_colors.slice(0, 6)).toBe("dc1e1e");                     // top-left cell is red
    expect(p.cell_colors.slice(7 * 6, 8 * 6)).toBe("1e1edc");             // top-right cell is blue
    const got = await adm(viewer, "GET", `/api/v1/events/${evA}/mosaic/master`);
    expect(got.statusCode).toBe(200); expect(got.headers["content-type"]).toBe("image/png");
  });
  it("replacing the master deletes the old file and clears placed pictures", async () => {
    const before = (await mosaicFiles(evA)).filter((f) => f.endsWith(".png"));
    expect(before).toHaveLength(1);
    const r = await upMaster(evA, await master(1000, 500));
    expect(r.json().master).toEqual({ width: 1000, height: 500 });
    const after = (await mosaicFiles(evA)).filter((f) => f.endsWith(".png"));
    expect(after).toHaveLength(1); expect(after[0]).not.toBe(before[0]);
    await upMaster(evA, await master());                                   // back to 800x400 for the next tests
  });
  it("changing the tile count rebuilds the grid", async () => {
    const r = await putM(evA, settings({ tileTarget: 200 }));
    expect(r.json().grid.cells).toBeGreaterThan(150); expect(r.json().grid.cols / r.json().grid.rows).toBeGreaterThan(1.8);
    await putM(evA, settings({ tileTarget: 32 }));
    expect((await state(evA)).grid).toEqual({ cols: 8, rows: 4, cells: 32 });
  });
});

describe("placing pictures", () => {
  it("only approved pictures are used while moderation is required, and each goes to the cell that matches its colour", async () => {
    const red = await pic(tokA, frameA, RED), blue = await pic(tokA, frameA, BLUE);
    expect((await state(evA)).stats).toMatchObject({ filled: 0, eligible: 0 });
    await bulk(evA, [red.cid, blue.cid], "approve");
    const s = await state(evA);
    expect(s.stats).toMatchObject({ cells: 32, filled: 2, eligible: 2, percent: 6, unused: 0 });
    expect((await cellOf(red.cid))! % 8).toBeLessThan(4);                  // left half = red part of the master
    expect((await cellOf(blue.cid))! % 8).toBeGreaterThanOrEqual(4);
  });
  it("a picture keeps its cell when others arrive, and several of one colour stay in their half", async () => {
    const before = (await pool.query("SELECT composition_id, cell FROM mosaic_tiles WHERE event_id=$1", [evA])).rows;
    const more = [await pic(tokA, frameA, RED, { approve: true, ev: evA }), await pic(tokA, frameA, RED, { approve: true, ev: evA }), await pic(tokA, frameA, BLUE, { approve: true, ev: evA })];
    await state(evA);
    for (const b of before) expect(await cellOf(b.composition_id)).toBe(b.cell);
    expect((await cellOf(more[0].cid))! % 8).toBeLessThan(4); expect((await cellOf(more[1].cid))! % 8).toBeLessThan(4);
    expect((await cellOf(more[2].cid))! % 8).toBeGreaterThanOrEqual(4);
    expect(await tileCount(evA)).toBe(5);
    const cells = (await pool.query("SELECT cell FROM mosaic_tiles WHERE event_id=$1", [evA])).rows.map((r) => r.cell);
    expect(new Set(cells).size).toBe(cells.length);                        // never two pictures in one cell
  });
  it("concurrent displays cannot place a picture twice", async () => {
    const p = await pic(tokA, frameA, BLUE, { approve: true, ev: evA });
    const before = await tileCount(evA);
    const rs = await Promise.all([state(evA), state(evA), state(evA), state(evA)]);
    expect(rs.every((r) => r.stats.filled === before + 1)).toBe(true);
    expect(await tileCount(evA)).toBe(before + 1);
    expect((await pool.query("SELECT count(*)::int c FROM mosaic_tiles WHERE composition_id=$1", [p.cid])).rows[0].c).toBe(1);
  });
  it("hiding, rejecting, deleting and opting out free the cell; showing again puts the picture back", async () => {
    const p = await pic(tokA, frameA, RED, { approve: true, ev: evA }); await state(evA);
    expect(await cellOf(p.cid)).toBeDefined();
    const n = await tileCount(evA);
    await bulk(evA, [p.cid], "hide_wall"); await state(evA);
    expect(await cellOf(p.cid)).toBeUndefined(); expect(await tileCount(evA)).toBe(n - 1);
    await bulk(evA, [p.cid], "show_wall"); await state(evA);
    expect(await cellOf(p.cid)).toBeDefined();
    await bulk(evA, [p.cid], "reject"); await state(evA);
    expect(await cellOf(p.cid)).toBeUndefined();
    await bulk(evA, [p.cid], "approve"); await state(evA);
    expect(await cellOf(p.cid)).toBeDefined();
    const thumb = `events/${evA}/mosaic/tiles/${p.cid}.jpg`;
    expect(await exists(thumb)).toBe(true);
    await bulk(evA, [p.cid], "delete", { confirmPrinted: true });
    expect(await exists(thumb)).toBe(false);                              // the cached thumbnail goes with the picture
    expect(await tileCount(evA)).toBe(n - 1);
    const out = await pic(tokA, frameA, RED, { optOut: true, approve: true, ev: evA }); await state(evA);
    expect(await cellOf(out.cid)).toBeUndefined();                         // guest asked to stay off the big screen
  });
  it("moderation off lets pending pictures in (never rejected ones); switching it on again removes them", async () => {
    const pend = await pic(tokA, frameA, BLUE); const rej = await pic(tokA, frameA, BLUE); await bulk(evA, [rej.cid], "reject");
    await putM(evA, settings({ moderationRequired: false }));
    expect(await cellOf(pend.cid)).toBeDefined(); expect(await cellOf(rej.cid)).toBeUndefined();
    await putM(evA, settings({ moderationRequired: true }));
    expect(await cellOf(pend.cid)).toBeUndefined();
  });
  it("when every cell is taken the remaining pictures are reported as unused", async () => {
    await pool.query("UPDATE mosaic_projects SET cols=2, rows=1, cell_colors='dc1e1e1e1edc' WHERE event_id=$1", [evA]);
    await pool.query("DELETE FROM mosaic_tiles WHERE event_id=$1", [evA]);
    const s = await state(evA);
    expect(s.stats).toMatchObject({ cells: 2, filled: 2, percent: 100 }); expect(s.stats.unused).toBe(s.stats.eligible - 2); expect(s.stats.unused).toBeGreaterThan(0);
    await pool.query("UPDATE mosaic_projects SET cols=8, rows=4 WHERE event_id=$1", [evA]);
    await adm(sup, "POST", `/api/v1/events/${evA}/mosaic/rebuild`);        // restores the real 8x4 colours below
    await upMaster(evA, await master());
  });
  it("rebuild clears every tile and places everything again, deterministically", async () => {
    await state(evA);
    const first = (await pool.query("SELECT composition_id, cell FROM mosaic_tiles WHERE event_id=$1 ORDER BY composition_id", [evA])).rows;
    expect(first.length).toBeGreaterThan(3);
    const r = await adm(mgrA, "POST", `/api/v1/events/${evA}/mosaic/rebuild`);
    expect(r.statusCode).toBe(200); expect(r.json().stats.filled).toBe(first.length);
    const again = (await pool.query("SELECT composition_id, cell FROM mosaic_tiles WHERE event_id=$1 ORDER BY composition_id", [evA])).rows;
    expect(again).toEqual(first);
  });
  it("events never mix: another event's pictures are not used", async () => {
    await upMaster(evB, await master()); await putM(evB, settings());
    const b = await pic(tokB, frameB, RED, { approve: true, ev: evB });
    const sb = await state(evB);
    expect(sb.stats.filled).toBe(1); expect(await cellOf(b.cid)).toBeDefined();
    const mine = (await pool.query("SELECT count(*)::int c FROM mosaic_tiles WHERE event_id=$1", [evA])).rows[0].c;
    expect((await state(evA)).stats.filled).toBe(mine);
  });
});

describe("rendering", () => {
  const pixel = async (buf: Buffer, cell: number, cols = 8, rows = 4) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const r = cellRect(cell, cols, rows, info.width, info.height);
    const at = ((r.y + Math.floor(r.h / 2)) * info.width + r.x + Math.floor(r.w / 2)) * info.channels;
    return [data[at], data[at + 1], data[at + 2]];
  };
  it("draws the master at the requested width, with placed cells brighter than empty ones, and caches by version", async () => {
    await adm(sup, "POST", `/api/v1/events/${evA}/mosaic/rebuild`);
    const r = await adm(viewer, "GET", `/api/v1/events/${evA}/mosaic/image?w=800`);
    expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toBe("image/jpeg"); expect(r.headers["x-mosaic-version"]).toBeTruthy();
    const m = await sharp(r.rawPayload).metadata(); expect(m).toMatchObject({ width: 800, height: 400 });
    const tiles = (await pool.query("SELECT cell FROM mosaic_tiles WHERE event_id=$1", [evA])).rows.map((x) => x.cell as number);
    const empty = [...Array(32).keys()].filter((c) => !tiles.includes(c));
    const filledLeft = tiles.find((c) => c % 8 < 4)!, emptyLeft = empty.find((c) => c % 8 < 4)!;
    const f = await pixel(r.rawPayload, filledLeft), e = await pixel(r.rawPayload, emptyLeft);
    expect(f[0]).toBeGreaterThan(e[0] + 40);                               // a placed red picture is clearly brighter than the dimmed master
    expect(e[0]).toBeLessThan(140); expect(e[2]).toBeLessThan(60);         // empty cell still shows the (dimmed) red of the master
    const v1 = r.headers["x-mosaic-version"];
    expect((await mosaicFiles(evA, "render")).filter((x) => x.startsWith(`${v1}-`))).toEqual([`${v1}-800.jpg`]);
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/mosaic/image?w=800`)).headers["x-mosaic-version"]).toBe(v1);      // nothing changed: same version
    await pic(tokA, frameA, BLUE, { approve: true, ev: evA });
    const r2 = await adm(sup, "GET", `/api/v1/events/${evA}/mosaic/image?w=800`);
    expect(r2.headers["x-mosaic-version"]).not.toBe(v1);                   // a new picture is a new version
    expect((await mosaicFiles(evA, "render")).every((x) => x.startsWith(`${r2.headers["x-mosaic-version"]}-`))).toBe(true);        // old renders removed
  });
  it("refuses sizes that are not offered", async () => {
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/mosaic/image?w=5000`)).statusCode).toBe(404);
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/mosaic/image?w=abc`)).statusCode).toBe(404);
    expect((await adm(null, "GET", `/api/v1/events/${evA}/mosaic/image?w=800`)).statusCode).toBe(401);
  });
  it("puts the event logo on the mosaic where it is told to, and nowhere when set to none", async () => {
    const logo = await sharp({ create: { width: 300, height: 150, channels: 3, background: "#00c800" } }).png().toBuffer();
    expect((await adm(sup, "POST", `/api/v1/events/${evA}/logo/event`, logo as any, { "content-type": "application/octet-stream" })).statusCode).toBe(201);
    const centre = async () => { const b = (await adm(sup, "GET", `/api/v1/events/${evA}/mosaic/image?w=800`)).rawPayload; const { data, info } = await sharp(b).raw().toBuffer({ resolveWithObject: true }); const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels; return [data[at], data[at + 1], data[at + 2]]; };
    await putM(evA, settings({ logo: { position: "none", sizePct: 20, plate: false } }));
    const none = await centre(); expect(none[1] > 150 && none[0] < 80).toBe(false);
    await putM(evA, settings({ logo: { position: "center", sizePct: 20, plate: false } }));
    const on = await centre(); expect(on[1]).toBeGreaterThan(150); expect(on[0]).toBeLessThan(80);
    const g = (await adm(sup, "GET", `/api/v1/events/${evA}/mosaic/image?w=800`)).rawPayload;
    const { data, info } = await sharp(g).raw().toBuffer({ resolveWithObject: true });
    const corner = (info.height - 20) * info.width * info.channels + (info.width - 20) * info.channels;
    expect(data[corner + 1] > 150 && data[corner] < 80).toBe(false);          // bottom-right corner is not logo-green
    await putM(evA, settings({ logo: { position: "bottom-right", sizePct: 20, plate: false } }));
    const br = (await adm(sup, "GET", `/api/v1/events/${evA}/mosaic/image?w=800`)).rawPayload;
    const b2 = await sharp(br).raw().toBuffer({ resolveWithObject: true });
    const bc = (b2.info.height - 40) * b2.info.width * 3 + (b2.info.width - 60) * 3;
    expect(b2.data[bc + 1]).toBeGreaterThan(150);                              // logo moved to the corner
    await putM(evA, settings());
  });
  it("downloads the finished file at the configured width as an attachment, and audits it", async () => {
    const r = await adm(viewer, "GET", `/api/v1/events/${evA}/mosaic/download`);
    expect(r.statusCode).toBe(200); expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="mosaic-[0-9a-f]{8}\.jpg"$/); expect(r.headers["cache-control"]).toBe("no-store");
    expect(await sharp(r.rawPayload).metadata()).toMatchObject({ width: 1600, height: 800, format: "jpeg" });
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='mosaic_download' AND event_id=$1", [evA])).rowCount).toBeGreaterThan(0);
    expect((await adm(null, "GET", `/api/v1/events/${evA}/mosaic/download`)).statusCode).toBe(401);
    const c = await mkEvent("Mosaic C");
    expect((await adm(sup, "GET", `/api/v1/events/${c.id}/mosaic/download`)).statusCode).toBe(404);   // no master yet
  });
});

describe("public display", () => {
  it("shows progress and the picture only while the module is on and the event is live", async () => {
    const j = (await app.inject({ method: "GET", url: M(mtA) })).json();
    expect(Object.keys(j).sort()).toEqual(["aspect", "event", "imageWidths", "joinPath", "progress", "showProgress", "title", "version"]);
    expect(j.joinPath).toBe(`/g/${tokA}`); expect(j.aspect).toBe(2); expect(j.progress.cells).toBe(32); expect(j.progress.filled).toBeGreaterThan(0);
    const img = await app.inject({ method: "GET", url: `${M(mtA)}/image?w=800` });
    expect(img.headers["x-mosaic-version"]).toBe(j.version);               // the display learns about a new picture from the version
    expect(img.statusCode).toBe(200); expect(img.headers["content-type"]).toBe("image/jpeg"); expect(img.headers["cache-control"]).toMatch(/private/);
    expect((await app.inject({ method: "GET", url: `${M(mtA)}/image?w=123` })).statusCode).toBe(404);
    await putM(evA, settings({ enabled: false }));
    for (const u of [M(mtA), `${M(mtA)}/image`, `${M(mtA)}/stream`]) expect((await app.inject({ method: "GET", url: u })).statusCode).toBe(404);
    await putM(evA, settings());
    await adm(sup, "POST", `/api/v1/events/${evA}/status`, { status: "inactive" });
    expect((await app.inject({ method: "GET", url: M(mtA) })).statusCode).toBe(404);
    await adm(sup, "POST", `/api/v1/events/${evA}/status`, { status: "active" });
    expect((await app.inject({ method: "GET", url: M(mtA) })).statusCode).toBe(200);
    for (const bad of ["nope", "0".repeat(24)]) expect((await app.inject({ method: "GET", url: M(bad) })).statusCode).toBe(404);
  });
  it("regenerating the link kills the old one at once", async () => {
    const r = (await adm(mgrA, "POST", `/api/v1/events/${evA}/mosaic/regenerate-token`)).json();
    expect(r.token).not.toBe(mtA);
    expect((await app.inject({ method: "GET", url: M(mtA) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: M(r.token) })).statusCode).toBe(200);
    mtA = r.token;
  });
  it("an open display gets a tick when a picture arrives", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${M(mtA)}/stream`, { signal: ac.signal });
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    const until = async (needle: string) => { const end = Date.now() + 8000; while (!buf.includes(needle) && Date.now() < end) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } return buf.includes(needle); };
    expect(await until("event: hello")).toBe(true);
    const p = await pic(tokA, frameA, RED); buf = "";
    await bulk(evA, [p.cid], "approve");
    expect(await until("event: tick")).toBe(true);
    ac.abort();
  });
});
