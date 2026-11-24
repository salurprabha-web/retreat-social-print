import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { validateGuestInput, type PageDefinition } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-g-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, op: S; let evA: string, evB: string, tokA: string, tokB: string;
const PW = "correct horse battery";

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id", [email, await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: s.cookie, "x-rsp-csrf": s.csrf } });
const G = (t: string) => `/api/v1/public/g/${t}`;
const session = (t: string, body: unknown = { consent: true, fields: {} }) => app.inject({ method: "POST", url: `${G(t)}/session`, payload: body as any });
const upload = (t: string, sid: string | null, buf: Buffer) =>
  app.inject({ method: "POST", url: `${G(t)}/photo`, payload: buf, headers: { "content-type": "application/octet-stream", ...(sid ? { "x-guest-session": sid } : {}) } });

const jpeg = (w = 2000, h = 3000, color = "#c33") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
const png = () => sharp({ create: { width: 1600, height: 1600, channels: 4, background: "#0a0" } }).png().toBuffer();

async function publishEvent(name: string, tweak?: (d: PageDefinition) => void, settings?: object) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition as PageDefinition;
  tweak?.(def);
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  if (settings) await adm(sup, "PATCH", `/api/v1/events/${e.id}`, { settings });
  return { id: e.id as string, token: e.guestToken as string };
}

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup5@t.test", "super_admin");
  const a = await publishEvent("Flow A", (d) => {
    d.journey.steps.find((s) => s.id === "details")!.enabled = true;
    d.fields = [{ id: "em", type: "email", label: "Email", required: false }, { id: "nm", type: "name", label: "Name", required: true }];
  });
  const b = await publishEvent("Flow B");
  evA = a.id; tokA = a.token; evB = b.id; tokB = b.token;
  mgrA = await mkUser("mgr5@t.test", "event_manager", evA, "event_manager");
  op = await mkUser("op5@t.test", "print_operator", evA, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("guest input validation (shared)", () => {
  const base = { journey: { steps: [{ id: "details", enabled: true }] }, fields: [
    { id: "a", type: "phone", label: "", required: false }, { id: "b", type: "name", label: "", required: true }] } as unknown as PageDefinition;
  it("optional fields may be empty; required ones may not; formats are checked", () => {
    expect(validateGuestInput(base, { consent: true, fields: { b: "Asha" } }, true).ok).toBe(true);
    expect(validateGuestInput(base, { consent: true, fields: {} }, true).errors.b).toBeTruthy();
    expect(validateGuestInput(base, { consent: true, fields: { a: "abc", b: "x" } }, true).errors.a).toBeTruthy();
    expect(validateGuestInput(base, { consent: false, fields: { b: "x" } }, true).errors._consent).toBeTruthy();
    expect(validateGuestInput(base, { consent: false, fields: { b: "x" } }, false).ok).toBe(true);
    expect(validateGuestInput(base, { consent: true, fields: { b: "x", zzz: "1" } }, true).ok).toBe(false);
  });
  it("does not enforce required fields when the details step is off", () => {
    const off = { ...base, journey: { steps: [{ id: "details", enabled: false }] } } as unknown as PageDefinition;
    expect(validateGuestInput(off, { consent: true, fields: {} }, true).ok).toBe(true);
  });
});

describe("guest session", () => {
  it("creates a session with a readable guest code and stores only valid fields", async () => {
    const r = await session(tokA, { consent: true, fields: { nm: "Asha", em: "" } });
    expect(r.statusCode).toBe(201);
    expect(r.json().guestCode).toMatch(/^G[A-HJ-NP-Z2-9]{5}$/);
    const row = (await pool.query("SELECT fields,consent_at FROM guest_sessions WHERE id=$1", [r.json().sessionId])).rows[0];
    expect(row.fields).toEqual({ nm: "Asha" }); expect(row.consent_at).toBeTruthy();
  });
  it("enforces consent, required and invalid fields; refuses unknown ones", async () => {
    expect((await session(tokA, { consent: false, fields: { nm: "A" } })).statusCode).toBe(400);
    expect((await session(tokA, { consent: true, fields: {} })).statusCode).toBe(400);
    expect((await session(tokA, { consent: true, fields: { nm: "A", em: "nope" } })).statusCode).toBe(400);
    expect((await session(tokA, { consent: true, fields: { nm: "A", evil: "x" } })).statusCode).toBe(400);
  });
  it("is unavailable for unknown, malformed or inactive events", async () => {
    expect((await session("0".repeat(24))).statusCode).toBe(404);
    expect((await session("bad")).statusCode).toBe(404);
    const e = await publishEvent("Flow Off"); await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "inactive" });
    expect((await session(e.token)).statusCode).toBe(404);
  });
});

describe("photo upload", () => {
  let sid: string;
  beforeAll(async () => { sid = (await session(tokB)).json().sessionId; });

  it("accepts a JPEG, keeps the ORIGINAL bytes untouched and records metadata", async () => {
    const buf = await jpeg();
    const r = await upload(tokB, sid, buf);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ width: 2000, height: 3000, lowResolution: false, bytes: buf.length });
    const row = (await pool.query("SELECT storage_key,mime,event_id FROM photo_uploads WHERE id=$1", [r.json().uploadId])).rows[0];
    expect(row.event_id).toBe(evB); expect(row.mime).toBe("image/jpeg");
    expect(row.storage_key).toMatch(new RegExp(`^events/${evB}/originals/[0-9a-f]{32}\\.jpg$`));
    expect(fs.readFileSync(path.join(process.env.STORAGE_DIR!, row.storage_key)).equals(buf)).toBe(true);
  });
  it("accepts PNG, flags low resolution, and is idempotent for the same file", async () => {
    const s2 = (await session(tokB)).json().sessionId;
    const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#222" } }).png().toBuffer();
    const r = await upload(tokB, s2, small);
    expect(r.statusCode).toBe(201); expect(r.json().lowResolution).toBe(true);
    const again = await upload(tokB, s2, small);
    expect(again.json()).toMatchObject({ uploadId: r.json().uploadId, duplicate: true });
    expect((await pool.query("SELECT count(*)::int c FROM photo_uploads WHERE session_id=$1", [s2])).rows[0].c).toBe(1);
    expect((await upload(tokB, (await session(tokB)).json().sessionId, await png())).statusCode).toBe(201);
  });
  it("swaps width/height for EXIF-rotated phone photos", async () => {
    const s2 = (await session(tokB)).json().sessionId;
    const buf = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#09c" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await upload(tokB, s2, buf);
    expect(r.json()).toMatchObject({ width: 2000, height: 3000 });
  });
  it("rejects non-images, corrupt images, SVG and HEIC with friendly codes", async () => {
    const s2 = (await session(tokB)).json().sessionId;
    expect((await upload(tokB, s2, Buffer.from("MZ not an image"))).json().error).toBe("unsupported_image");
    expect((await upload(tokB, s2, (await jpeg()).subarray(0, 3000))).statusCode).toBe(415);
    expect((await upload(tokB, s2, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).statusCode).toBe(415);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(40)]);
    expect((await upload(tokB, s2, heic)).json().error).toBe("heic_unsupported");
  });
  it("enforces the per-event size limit before reading the body", async () => {
    const e = await publishEvent("Flow Small", undefined, { maxUploadMb: 1 });
    const s2 = (await session(e.token)).json().sessionId;
    const big = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } }).jpeg({ quality: 95 }).toBuffer();
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const r = await upload(e.token, s2, big);
    expect(r.statusCode).toBe(413); expect(r.json()).toMatchObject({ error: "too_large", maxMb: 1 });
  });
  it("requires a valid session that belongs to this event", async () => {
    expect((await upload(tokB, null, await jpeg(800, 800))).statusCode).toBe(401);
    expect((await upload(tokB, "00000000-0000-4000-8000-000000000000", await jpeg(800, 800))).statusCode).toBe(401);
    const sA = (await session(tokA, { consent: true, fields: { nm: "x" } })).json().sessionId;
    expect((await upload(tokB, sA, await jpeg(900, 900))).statusCode).toBe(401);   // session of event A cannot post to event B
  });
  it("replacing a photo removes the previous original from disk and the active set", async () => {
    const s2 = (await session(tokB)).json().sessionId;
    const first = (await upload(tokB, s2, await jpeg(1500, 1500, "#111"))).json().uploadId;
    const key1 = (await pool.query("SELECT storage_key FROM photo_uploads WHERE id=$1", [first])).rows[0].storage_key;
    const second = (await upload(tokB, s2, await jpeg(1500, 1500, "#eee"))).json().uploadId;
    expect(second).not.toBe(first);
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR!, key1))).toBe(false);
    expect((await pool.query("SELECT deleted_at FROM photo_uploads WHERE id=$1", [first])).rows[0].deleted_at).toBeTruthy();
  });
  it("caps uploads per session", async () => {
    const s2 = (await session(tokB)).json().sessionId;
    for (let i = 0; i < 10; i++) expect((await upload(tokB, s2, await jpeg(1300 + i, 1300, "#" + (100 + i * 11)))).statusCode).toBe(201);
    expect((await upload(tokB, s2, await jpeg(1400, 1400, "#fa0"))).statusCode).toBe(429);
  });
});

describe("adjustments", () => {
  it("stores rotate/zoom/offset beside the untouched original; rejects out-of-range values and other sessions", async () => {
    const s2 = (await session(tokB)).json().sessionId; const s3 = (await session(tokB)).json().sessionId;
    const up = (await upload(tokB, s2, await jpeg(1800, 1800, "#357"))).json().uploadId;
    const put = (sid: string, body: unknown) => app.inject({ method: "PUT", url: `${G(tokB)}/photo/${up}/adjust`, payload: body as any, headers: { "x-guest-session": sid } });
    expect((await put(s2, { rotate: 90, zoom: 1.8, offsetX: -0.25, offsetY: 0.5 })).statusCode).toBe(200);
    expect((await pool.query("SELECT adjust FROM photo_uploads WHERE id=$1", [up])).rows[0].adjust).toEqual({ rotate: 90, zoom: 1.8, offsetX: -0.25, offsetY: 0.5 });
    expect((await put(s2, { rotate: 45, zoom: 1, offsetX: 0, offsetY: 0 })).statusCode).toBe(400);
    expect((await put(s2, { rotate: 0, zoom: 9, offsetX: 0, offsetY: 0 })).statusCode).toBe(400);
    expect((await put(s3, { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 })).statusCode).toBe(404);
  });
});

describe("photo privacy", () => {
  it("has no public route to photos; staff of the right event can open originals, others cannot", async () => {
    const sB = (await session(tokB)).json().sessionId;
    const upB = (await upload(tokB, sB, await jpeg(1500, 1500, "#abc"))).json().uploadId;
    const sA = (await session(tokA, { consent: true, fields: { nm: "x" } })).json().sessionId;
    const upA = (await upload(tokA, sA, await jpeg(1500, 1500, "#cba"))).json().uploadId;
    expect((await app.inject({ method: "GET", url: `/api/v1/events/${evA}/uploads/${upA}/original` })).statusCode).toBe(401);
    expect((await adm(op, "GET", `/api/v1/events/${evA}/uploads/${upA}/original`)).statusCode).toBe(200);
    expect((await adm(mgrA, "GET", `/api/v1/events/${evB}/uploads/${upB}/original`)).statusCode).toBe(403);
    expect((await adm(mgrA, "GET", `/api/v1/events/${evA}/uploads/${upB}/original`)).statusCode).toBe(404);   // right event URL, other event's photo
    expect((await app.inject({ method: "GET", url: `${G(tokB)}/photo/${upB}` })).statusCode).toBe(404);
    const viewed = await pool.query("SELECT count(*)::int c FROM audit_logs WHERE action='photo_original_view'");
    expect(viewed.rows[0].c).toBeGreaterThan(0);
  });
});
