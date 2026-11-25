import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { unzipSync } from "fflate";
import type { PageDefinition } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { S3Backend, DiskBackend } from "../src/storageBackends";
import { FakeS3 } from "./helpers/fakeS3";

// On object storage, big downloads are a redirect to a short-lived signed address (a serverless response cannot carry more than ~4.5 MB).
(globalThis as any).__rspNoFollow = true;
const fake = new FakeS3();
(globalThis as any).__rspStorageFactory = () => new S3Backend(fake, "bkt", "", fake);
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-dl-"));
const { buildApp } = await import("../src/app");
const storage = await import("../src/storage");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, other: S; let ev: { id: string; token: string }, evOther: string; let frame: string;
const PW = "correct horse battery";
const adm = (s: S, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: s.cookie, "x-rsp-csrf": s.csrf } });
const G = (t: string) => `/api/v1/public/g/${t}`;
const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };
const keyOfLocation = (loc: string) => decodeURIComponent(new URL(loc).pathname.slice(1));

async function login(email: string, role: string) {
  await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3)", [email, await hashPassword(PW), role]);
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (r.headers["set-cookie"] as string).split(";")[0], csrf: r.json().csrf } as S;
}
async function mkEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition as PageDefinition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return { id: e.id as string, token: e.guestToken as string };
}
/** One guest, one photo, one finished picture. */
async function picture(color: string) {
  const sid = (await app.inject({ method: "POST", url: `${G(ev.token)}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
  const h = { "x-guest-session": sid, "content-type": "application/octet-stream" };
  const photo = await sharp({ create: { width: 1800, height: 2400, channels: 3, background: color } }).jpeg().toBuffer();
  const up = (await app.inject({ method: "POST", url: `${G(ev.token)}/photo`, payload: photo, headers: h })).json().uploadId as string;
  const c = (await app.inject({ method: "POST", url: `${G(ev.token)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json();
  return { cid: c.compositionId as string, url: c.url as string, up };
}

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool); app = await buildApp(pool);
  sup = await login("dl@t.test", "super_admin");
  ev = await mkEvent("Downloads"); evOther = (await mkEvent("Other")).id;
  other = await login("dl2@t.test", "event_manager"); await pool.query("INSERT INTO user_event_roles SELECT id,$1,'event_manager' FROM users WHERE email='dl2@t.test'", [evOther]);
  frame = (await adm(sup, "POST", `/api/v1/events/${ev.id}/frames`, { name: "F", format: "4x6", preset: "single" })).json().frame.id;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("pictures are downloaded from storage, not through the function", () => {
  it("the guest's signed link redirects to a short-lived signed storage address, inline for viewing and as an attachment for saving", async () => {
    const p = await picture("#336699");
    const key = (await pool.query("SELECT storage_key FROM final_compositions WHERE id=$1", [p.cid])).rows[0].storage_key as string;
    const view = await app.inject({ method: "GET", url: p.url });
    expect(view.statusCode).toBe(302);
    const u = new URL(view.headers.location as string);
    expect(keyOfLocation(view.headers.location as string)).toBe(key);                                 // exactly this picture
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("response-content-type")).toBe("image/jpeg");
    expect(u.searchParams.get("response-content-disposition")).toBe("inline");
    expect(view.headers["x-robots-tag"]).toBe("noindex");
    const save = await app.inject({ method: "GET", url: p.url + "&dl=1" });
    expect(new URL(save.headers.location as string).searchParams.get("response-content-disposition")).toBe('attachment; filename="photo.jpg"');
    // the stored bytes behind the address are the picture
    expect((await storage.getFile(key)).length).toBeGreaterThan(1000);
  });

  it("an edited or expired link gets no redirect and no hint of the storage address", async () => {
    const p = await picture("#993366");
    for (const url of [p.url.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(40)), p.url.replace(/exp=\d+/, "exp=1"), p.url.replace(/c\/[0-9a-f-]+/, "c/00000000-0000-4000-8000-000000000000")]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(404); expect(r.headers.location).toBeUndefined(); expect(r.payload).not.toMatch(/r2\.cloudflarestorage|X-Amz/);
    }
  });

  it("staff of the event are redirected to the picture and the original; staff of another event and anonymous visitors get nothing", async () => {
    const p = await picture("#118855");
    const img = await adm(sup, "GET", `/api/v1/events/${ev.id}/compositions/${p.cid}/image`);
    expect(img.statusCode).toBe(302); expect(img.headers.location).toMatch(/^https:\/\/bkt\.acct\.r2\.cloudflarestorage\.com\/events\/.+\/finals\//);
    const orig = await adm(sup, "GET", `/api/v1/events/${ev.id}/uploads/${p.up}/original`);
    expect(orig.statusCode).toBe(302); expect(keyOfLocation(orig.headers.location as string)).toMatch(/\/originals\//);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='photo_original_view' AND entity_id=$1", [p.up])).rowCount).toBe(1);   // viewing an original is still audited
    for (const url of [`/api/v1/events/${ev.id}/compositions/${p.cid}/image`, `/api/v1/events/${ev.id}/uploads/${p.up}/original`]) {
      const r = await adm(other, "GET", url); expect(r.statusCode).toBe(403); expect(r.headers.location).toBeUndefined();
      const a = await app.inject({ method: "GET", url }); expect(a.statusCode).toBe(401); expect(a.headers.location).toBeUndefined();
    }
  });

  it("the mosaic download redirects to the kept rendering as an attachment", async () => {
    const master = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#aa5522" } }).jpeg().toBuffer();
    expect((await app.inject({ method: "POST", url: `/api/v1/events/${ev.id}/mosaic/master`, payload: master, headers: { cookie: sup.cookie, "x-rsp-csrf": sup.csrf, "content-type": "image/jpeg" } })).statusCode).toBe(201);
    const r = await adm(sup, "GET", `/api/v1/events/${ev.id}/mosaic/download`);
    expect(r.statusCode).toBe(302);
    const u = new URL(r.headers.location as string);
    expect(keyOfLocation(r.headers.location as string)).toMatch(new RegExp(`^events/${ev.id}/mosaic/render/[0-9a-f]+-\\d+\\.jpg$`));
    expect(u.searchParams.get("response-content-disposition")).toBe(`attachment; filename="mosaic-${ev.id.slice(0, 8)}.jpg"`);
    expect((await storage.getFile(keyOfLocation(r.headers.location as string))).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    // the small preview still comes straight back
    expect((await adm(sup, "GET", `/api/v1/events/${ev.id}/mosaic/image?w=800`)).statusCode).toBe(200);
  });
});

describe("the ZIP export is written to storage and downloaded from there", () => {
  it("builds a valid archive of the approved pictures, redirects to it, and keeps only the newest export", async () => {
    const a = await picture("#ff0000"), b = await picture("#00ff00"), c = await picture("#0000ff");
    await adm(sup, "POST", `/api/v1/events/${ev.id}/compositions/bulk`, { ids: [a.cid, b.cid], action: "approve" });
    void c;
    const r = await adm(sup, "GET", `/api/v1/events/${ev.id}/compositions-export`);
    expect(r.statusCode).toBe(302);
    const key = keyOfLocation(r.headers.location as string);
    expect(key).toMatch(new RegExp(`^exports/${ev.id}/[0-9a-f]{32}\\.zip$`));
    expect(new URL(r.headers.location as string).searchParams.get("response-content-disposition")).toBe('attachment; filename="photos.zip"');
    const files = unzipSync(new Uint8Array(await storage.getFile(key)));
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(2);
    for (const bytes of Object.values(files)) expect(Buffer.from(bytes).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    const again = keyOfLocation((await adm(sup, "GET", `/api/v1/events/${ev.id}/compositions-export`)).headers.location as string);
    expect(again).not.toBe(key);
    expect(await storage.listFiles(`exports/${ev.id}`)).toEqual([again.split("/").pop()]);       // the previous export was removed
  });

  it("an archive larger than one upload part is sent as a multipart upload and arrives complete", async () => {
    // three 6 MB "pictures" (incompressible bytes, stored as they are): the archive is ~18 MB, i.e. three 8 MB parts
    const rnd = (n: number) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 65536) b.fill(i & 255, i, Math.min(n, i + 65536)); return b; };
    const big = await mkEvent("Big Export");
    const sid = (await pool.query("INSERT INTO guest_sessions(event_id,guest_code) VALUES ($1,'GBIG01') RETURNING id", [big.id])).rows[0].id;
    const fr = (await adm(sup, "POST", `/api/v1/events/${big.id}/frames`, { name: "F", format: "4x6", preset: "single" })).json().frame.id;
    const sent: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
      const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), rnd(6 * 1024 * 1024)]); sent.push(data);
      const up = (await pool.query("INSERT INTO photo_uploads(event_id,session_id,storage_key,mime,bytes,width,height,sha256,slot) VALUES ($1,$2,$3,'image/jpeg',1,10,10,$4,1) RETURNING id", [big.id, sid, `events/${big.id}/originals/u${i}.jpg`, "u" + i])).rows[0].id;
      const key = `events/${big.id}/finals/f${i}.jpg`; await storage.writeStable(key, data);
      await pool.query("INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256,moderation) VALUES ($1,$2,$3,$4,1,1,$5,'approved')", [big.id, up, fr, key, "f" + i]);
    }
    const before = fake.calls.filter((c) => c === "CreateMultipartUploadCommand").length;
    const r = await adm(sup, "GET", `/api/v1/events/${big.id}/compositions-export`);
    expect(r.statusCode).toBe(302);
    expect(fake.calls.filter((c) => c === "CreateMultipartUploadCommand").length).toBe(before + 1);
    const files = unzipSync(new Uint8Array(await storage.getFile(keyOfLocation(r.headers.location as string))));
    const got = Object.values(files).map((b) => Buffer.from(b));
    expect(got).toHaveLength(3); for (const s of sent) expect(got.some((g) => g.equals(s))).toBe(true);        // every picture arrived byte for byte
  });

  it("only people who may operate the event can export", async () => {
    expect((await adm(other, "GET", `/api/v1/events/${ev.id}/compositions-export`)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/v1/events/${ev.id}/compositions-export` })).statusCode).toBe(401);
  });
});

describe("local-disk storage keeps answering with the bytes themselves", () => {
  it("the same routes return the file directly (no redirect) when there is no object storage", async () => {
    storage.setStorageBackend(new DiskBackend(fs.mkdtempSync(path.join(os.tmpdir(), "rsp-disk-dl-"))));
    try {
      const p = await picture("#445566");
      const r = await app.inject({ method: "GET", url: p.url });
      expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toBe("image/jpeg"); expect(r.headers.location).toBeUndefined();
      expect(r.rawPayload.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
      const dl = await app.inject({ method: "GET", url: p.url + "&dl=1" });
      expect(dl.headers["content-disposition"]).toBe('attachment; filename="photo.jpg"');
    } finally { storage.setStorageBackend(new S3Backend(fake, "bkt", "", fake)); }
  });
});
