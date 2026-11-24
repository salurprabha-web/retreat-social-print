import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { newLayer, presetLayers, type PhotoAdjust } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-c-"));
const { buildApp } = await import("../src/app");
const { signCompositionPath } = await import("../src/signing");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, op: S, mgrB: S;
let evA: string, evB: string, tokA: string, tokB: string; let single: string, trio: string, offFrame: string, frameB: string;
const PW = "correct horse battery";
const A0: PhotoAdjust = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id", [email, await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: s.cookie, "x-rsp-csrf": s.csrf } });
const G = (t: string) => `/api/v1/public/g/${t}`;
const newSession = async (t: string) => (await app.inject({ method: "POST", url: `${G(t)}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
const upload = (t: string, sid: string, buf: Buffer, slot?: number) =>
  app.inject({ method: "POST", url: `${G(t)}/photo${slot ? `?slot=${slot}` : ""}`, payload: buf, headers: { "content-type": "application/octet-stream", "x-guest-session": sid } });
const compose = (t: string, sid: string | null, body: unknown) => app.inject({ method: "POST", url: `${G(t)}/compose`, payload: body as any, headers: sid ? { "x-guest-session": sid } : {} });
const solid = (w: number, h: number, c: string) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).jpeg({ quality: 95 }).toBuffer();
const leftRight = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#ff0000" } }).composite([{ input: { create: { width: w / 2, height: h, channels: 3, background: "#00ff00" } }, left: w / 2, top: 0 }]).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, "");

async function mkFrame(ev: string, name: string, layers: unknown[], extra: object = {}) {
  const r = await adm(sup, "POST", `/api/v1/events/${ev}/frames`, { name, format: "4x6", layers, ...extra });
  expect(r.statusCode, name).toBe(201); return r.json().frame.id as string;
}
async function mkEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name, hashtag: "Tag" })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return e as { id: string; guestToken: string };
}

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup7@t.test", "super_admin");
  const a = await mkEvent("Compose A"), b = await mkEvent("Compose B");
  evA = a.id; tokA = a.guestToken; evB = b.id; tokB = b.guestToken;
  single = await mkFrame(evA, "Single", presetLayers("single", 1200, 1800));
  trio = await mkFrame(evA, "Trio", presetLayers("trio", 1200, 1800));
  offFrame = await mkFrame(evA, "Off", presetLayers("single", 1200, 1800), { active: false });
  frameB = await mkFrame(evB, "Other event", presetLayers("single", 1200, 1800));
  mgrA = await mkUser("mgr7@t.test", "event_manager", evA, "event_manager");
  op = await mkUser("op7@t.test", "print_operator", evA, "print_operator");
  mgrB = await mkUser("mgrb7@t.test", "event_manager", evB, "event_manager");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("compose", () => {
  it("renders ONE final file and the guest link, the staff view and the stored file are byte-identical", async () => {
    const sid = await newSession(tokA); const up = (await upload(tokA, sid, await leftRight(3000, 2000))).json().uploadId;
    const r = await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }] });
    expect(r.statusCode).toBe(201);
    const c = r.json(); expect([c.width, c.height]).toEqual([1200, 1800]);
    const row = (await pool.query("SELECT storage_key,sha256,bytes,session_id FROM final_compositions WHERE id=$1", [c.compositionId])).rows[0];
    const onDisk = fs.readFileSync(path.join(process.env.STORAGE_DIR!, row.storage_key));
    expect(sha(onDisk)).toBe(row.sha256); expect(onDisk.length).toBe(Number(row.bytes)); expect(c.bytes).toBe(onDisk.length);
    const meta = await sharp(onDisk).metadata(); expect([meta.format, meta.width, meta.height, meta.density]).toEqual(["jpeg", 1200, 1800, 300]);
    const viaLink = await app.inject({ method: "GET", url: pathOf(c.url) });
    expect(viaLink.statusCode).toBe(200); expect(viaLink.headers["content-type"]).toBe("image/jpeg");
    expect(sha(viaLink.rawPayload)).toBe(row.sha256);
    const viaStaff = await adm(op, "GET", `/api/v1/events/${evA}/compositions/${c.compositionId}/image`);
    expect(sha(viaStaff.rawPayload)).toBe(row.sha256);
    expect(viaLink.headers["content-disposition"]).toBe("inline");
    expect((await app.inject({ method: "GET", url: pathOf(c.url) + "&dl=1" })).headers["content-disposition"]).toContain("attachment");
  });

  it("applies the guest's zoom/pan/rotation from the request", async () => {
    const sid = await newSession(tokA); const up = (await upload(tokA, sid, await leftRight(4000, 3000))).json().uploadId;
    const full = await mkFrame(evA, "Full", [newLayer("photo", { x: 0, y: 0, w: 1, h: 1 })]);
    const r = await compose(tokA, sid, { frameId: full, slots: [{ slot: 1, uploadId: up, adjust: { ...A0, zoom: 3, offsetX: -1 } }] });
    const img = await app.inject({ method: "GET", url: pathOf(r.json().url) });
    const { data, info } = await sharp(img.rawPayload).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [data[(y * info.width + x) * 3], data[(y * info.width + x) * 3 + 1]];
    expect(px(1100, 1700)[0]).toBeGreaterThan(200); expect(px(1100, 1700)[1]).toBeLessThan(60);   // pure red even at the far corner: panned to the left edge
    const r2 = await compose(tokA, sid, { frameId: full, slots: [{ slot: 1, uploadId: up, adjust: A0 }] });
    expect(r2.json().compositionId).not.toBe(r.json().compositionId);
  });

  it("is idempotent: the same request returns the same composition and keeps one file", async () => {
    const sid = await newSession(tokA); const up = (await upload(tokA, sid, await solid(2400, 3600, "#3366aa"))).json().uploadId;
    const body = { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }] };
    const a = await compose(tokA, sid, body), b = await compose(tokA, sid, body);
    expect(a.statusCode).toBe(201); expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ compositionId: a.json().compositionId, duplicate: true });
    expect((await pool.query("SELECT count(*)::int c FROM final_compositions WHERE session_id=$1", [sid])).rows[0].c).toBe(1);
    const parallel = await Promise.all([1, 2, 3].map(() => compose(tokA, sid, body)));
    expect(new Set(parallel.map((p) => p.json().compositionId)).size).toBe(1);
  });

  it("trying another frame replaces the earlier composition (row and file), unless it was already queued for printing", async () => {
    const sid = await newSession(tokA); const up = (await upload(tokA, sid, await solid(2400, 3600, "#aa3366"))).json().uploadId;
    const one = (await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }] })).json().compositionId;
    const key1 = (await pool.query("SELECT storage_key FROM final_compositions WHERE id=$1", [one])).rows[0].storage_key;
    const two = (await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: { ...A0, zoom: 2 } }] })).json().compositionId;
    expect((await pool.query("SELECT 1 FROM final_compositions WHERE id=$1", [one])).rowCount).toBe(0);
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR!, key1))).toBe(false);
    // once a print job exists the printed image must never disappear
    await pool.query("INSERT INTO print_jobs(event_id,composition_id,idempotency_key) VALUES ($1,$2,$3)", [evA, two, "keep-" + two]);
    const three = (await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: { ...A0, zoom: 3 } }] })).json().compositionId;
    expect((await pool.query("SELECT count(*)::int c FROM final_compositions WHERE session_id=$1", [sid])).rows[0].c).toBe(2);
    expect(three).not.toBe(two);
  });

  it("re-renders after the frame is edited (not served stale)", async () => {
    const f = await mkFrame(evA, "Editable", presetLayers("single", 1200, 1800));
    const sid = await newSession(tokA); const up = (await upload(tokA, sid, await solid(2400, 3600, "#55aa55"))).json().uploadId;
    const body = { frameId: f, slots: [{ slot: 1, uploadId: up, adjust: A0 }] };
    const a = (await compose(tokA, sid, body)).json().compositionId;
    const fr = (await adm(sup, "GET", `/api/v1/events/${evA}/frames/${f}`)).json().frame;
    await adm(sup, "PUT", `/api/v1/events/${evA}/frames/${f}`, { name: "Editable v2", format: "4x6", layers: fr.layers, expectedUpdatedAt: fr.updatedAt });
    expect((await compose(tokA, sid, body)).json().compositionId).not.toBe(a);
  });
});

describe("multi-photo frames", () => {
  it("uploads per slot without removing the other slots' photos, then composes all three", async () => {
    const sid = await newSession(tokA);
    const u1 = (await upload(tokA, sid, await solid(2000, 3000, "#ff0000"), 1)).json().uploadId;
    const u2 = (await upload(tokA, sid, await solid(2000, 3000, "#00ff00"), 2)).json().uploadId;
    const u3 = (await upload(tokA, sid, await solid(2000, 3000, "#0000ff"), 3)).json().uploadId;
    expect((await pool.query("SELECT count(*)::int c FROM photo_uploads WHERE session_id=$1 AND deleted_at IS NULL", [sid])).rows[0].c).toBe(3);
    const r = await compose(tokA, sid, { frameId: trio, slots: [{ slot: 1, uploadId: u1, adjust: A0 }, { slot: 2, uploadId: u2, adjust: A0 }, { slot: 3, uploadId: u3, adjust: A0 }] });
    expect(r.statusCode).toBe(201);
    const { data, info } = await sharp((await app.inject({ method: "GET", url: pathOf(r.json().url) })).rawPayload).raw().toBuffer({ resolveWithObject: true });
    const at = (fx: number, fy: number) => { const o = (Math.round(fy * info.height) * info.width + Math.round(fx * info.width)) * 3; return [data[o], data[o + 1], data[o + 2]]; };
    const lay = presetLayers("trio", 1200, 1800).filter((l) => l.type === "photo") as any[];
    const mid = (l: any) => at(l.x + l.w / 2, l.y + l.h / 2);
    expect(mid(lay[0])[0]).toBeGreaterThan(200); expect(mid(lay[1])[1]).toBeGreaterThan(200); expect(mid(lay[2])[2]).toBeGreaterThan(200);
  });
  it("replacing the photo of one slot deletes only that slot's old file; used photos are protected", async () => {
    const sid = await newSession(tokA);
    const a1 = (await upload(tokA, sid, await solid(1500, 2000, "#101010"), 1)).json().uploadId;
    const b1 = (await upload(tokA, sid, await solid(1500, 2000, "#202020"), 2)).json().uploadId;
    const keyA1 = (await pool.query("SELECT storage_key FROM photo_uploads WHERE id=$1", [a1])).rows[0].storage_key;
    const a2 = (await upload(tokA, sid, await solid(1500, 2000, "#303030"), 1)).json().uploadId;
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR!, keyA1))).toBe(false);
    expect((await pool.query("SELECT deleted_at FROM photo_uploads WHERE id=$1", [b1])).rows[0].deleted_at).toBeNull();
    // a photo that is part of a composition survives a later replacement
    const f = await mkFrame(evA, "Two", presetLayers("collage2", 1200, 1800));
    expect((await compose(tokA, sid, { frameId: f, slots: [{ slot: 1, uploadId: a2, adjust: A0 }, { slot: 2, uploadId: b1, adjust: A0 }] })).statusCode).toBe(201);
    await upload(tokA, sid, await solid(1500, 2000, "#404040"), 1);
    expect((await pool.query("SELECT deleted_at FROM photo_uploads WHERE id=$1", [a2])).rows[0].deleted_at).toBeNull();
  });
  it("the same upload may fill several slots", async () => {
    const sid = await newSession(tokA); const u = (await upload(tokA, sid, await solid(2000, 3000, "#778899"), 1)).json().uploadId;
    const r = await compose(tokA, sid, { frameId: trio, slots: [1, 2, 3].map((s) => ({ slot: s, uploadId: u, adjust: A0 })) });
    expect(r.statusCode).toBe(201);
  });
  it("rejects a bad slot number on upload", async () => {
    const sid = await newSession(tokA);
    expect((await upload(tokA, sid, await solid(1500, 1500, "#111111"), 9)).statusCode).toBe(400);
  });
});

describe("compose validation and isolation", () => {
  let sid: string; let up: string;
  beforeAll(async () => { sid = await newSession(tokA); up = (await upload(tokA, sid, await solid(2000, 3000, "#123456"))).json().uploadId; });
  it("needs exactly the frame's photo slots", async () => {
    const r = await compose(tokA, sid, { frameId: trio, slots: [{ slot: 1, uploadId: up, adjust: A0 }] });
    expect(r.statusCode).toBe(400); expect(r.json()).toMatchObject({ error: "slots_mismatch", need: [1, 2, 3] });
    expect((await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }, { slot: 1, uploadId: up, adjust: A0 }] })).statusCode).toBe(400);
  });
  it("rejects inactive frames, other events' frames and other sessions' photos", async () => {
    expect((await compose(tokA, sid, { frameId: offFrame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] })).statusCode).toBe(404);
    expect((await compose(tokA, sid, { frameId: frameB, slots: [{ slot: 1, uploadId: up, adjust: A0 }] })).statusCode).toBe(404);
    const other = await newSession(tokA);
    expect((await compose(tokA, other, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }] })).statusCode).toBe(404);
    const sB = await newSession(tokB); const upB = (await upload(tokB, sB, await solid(2000, 3000, "#654321"))).json().uploadId;
    expect((await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: upB, adjust: A0 }] })).statusCode).toBe(404);
  });
  it("validates adjustments and requires a session", async () => {
    expect((await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: { ...A0, zoom: 99 } }] })).statusCode).toBe(400);
    expect((await compose(tokA, null, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }] })).statusCode).toBe(401);
    expect((await compose(tokB, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }] })).statusCode).toBe(401);   // session of A on event B's link
  });
});

describe("signed links", () => {
  let id: string; let url: string; let sid: string;
  beforeAll(async () => {
    sid = await newSession(tokA); const up = (await upload(tokA, sid, await solid(2000, 3000, "#abcdef"))).json().uploadId;
    const r = (await compose(tokA, sid, { frameId: single, slots: [{ slot: 1, uploadId: up, adjust: A0 }] })).json();
    id = r.compositionId; url = pathOf(r.url);
  });
  it("accepts only an untampered, unexpired link", async () => {
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: url.replace(/sig=(.)/, (_m, c) => `sig=${c === "a" ? "b" : "a"}`) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: url.replace(/exp=\d+/, "exp=9999999999") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: signCompositionPath(id, 1, Date.now() - 3 * 3600_000) })).statusCode).toBe(404);   // expired an hour ago
    expect((await app.inject({ method: "GET", url: `/api/v1/public/c/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/public/c/00000000-0000-4000-8000-000000000000?${url.split("?")[1]}` })).statusCode).toBe(404);   // signature belongs to another id
  });
  it("gives the owner a fresh link, nobody else", async () => {
    const r = await app.inject({ method: "GET", url: `${G(tokA)}/composition/${id}/url`, headers: { "x-guest-session": sid } });
    expect(r.statusCode).toBe(200); expect((await app.inject({ method: "GET", url: pathOf(r.json().url) })).statusCode).toBe(200);
    const other = await newSession(tokA);
    expect((await app.inject({ method: "GET", url: `${G(tokA)}/composition/${id}/url`, headers: { "x-guest-session": other } })).statusCode).toBe(404);
  });
});

describe("staff access", () => {
  it("lists compositions for the right event only", async () => {
    const l = await adm(op, "GET", `/api/v1/events/${evA}/compositions`);
    expect(l.statusCode).toBe(200);
    expect(l.json().compositions.length).toBeGreaterThan(3);
    expect(Object.keys(l.json().compositions[0]).sort()).toEqual(["bytes", "createdAt", "downloads", "finalized", "frame", "guestCode", "heightPx", "id", "moderatedAt", "moderatedBy", "moderation", "moderationNote", "printJobs", "shareAttempts", "showOnWall", "slots", "widthPx"]);
    expect((await adm(mgrB, "GET", `/api/v1/events/${evA}/compositions`)).statusCode).toBe(403);
    const id = l.json().compositions[0].id;
    expect((await adm(mgrB, "GET", `/api/v1/events/${evB}/compositions/${id}/image`)).statusCode).toBe(404);   // right event URL, other event's image
    expect((await adm(mgrB, "GET", `/api/v1/events/${evA}/compositions/${id}/image`)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/v1/events/${evA}/compositions` })).statusCode).toBe(401);
  });
});
