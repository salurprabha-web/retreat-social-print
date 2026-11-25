import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { S3Client } from "@aws-sdk/client-s3";
import { MAX_UPLOADS_PER_SESSION, type PageDefinition } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { S3Backend, DiskBackend } from "../src/storageBackends";
import { FakeS3 } from "./helpers/fakeS3";

// This suite always runs on the S3 backend (in-memory stand-in), whatever TEST_STORAGE says: the direct upload exists only there.
const fake = new FakeS3();
const signer = new S3Client({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" } });
(globalThis as any).__rspStorageFactory = () => new S3Backend(fake, "bkt", "", signer);
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-d-"));
const { buildApp } = await import("../src/app");
const { signUploadTicket } = await import("../src/signing");
const storage = await import("../src/storage");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S; let evA: string, evB: string, tokA: string, tokB: string;
const PW = "correct horse battery";
const adm = (s: S, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: s.cookie, "x-rsp-csrf": s.csrf } });
const G = (t: string) => `/api/v1/public/g/${t}`;
const newSession = async (t: string) => (await app.inject({ method: "POST", url: `${G(t)}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
const post = (t: string, sid: string | null, what: string, body: unknown) =>
  app.inject({ method: "POST", url: `${G(t)}/photo/${what}`, payload: body as any, headers: sid ? { "x-guest-session": sid } : {} });
const jpeg = (w = 2000, h = 3000, color = "#c33") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();

/** What the phone does: take the signed address from upload-url and PUT the bytes there. (The stand-in has no HTTP, so the object is written directly, at the key the address names.) */
const keyOfUrl = (u: string) => decodeURIComponent(new URL(u).pathname.slice(1));
async function directUpload(tok: string, sid: string, data: Buffer, slot = 1) {
  const r = await post(tok, sid, "upload-url", { bytes: data.length, slot });
  if (r.statusCode !== 200) return { r, confirm: null as any, key: "" };
  const j = r.json(); const key = keyOfUrl(j.upload.url);
  fake.objects.set(key, { body: data, contentType: j.upload.headers["Content-Type"] });
  const confirm = await post(tok, sid, "confirm", { ticket: j.ticket });
  return { r, confirm, key, ticket: j.ticket as string };
}
const incoming = () => [...fake.objects.keys()].filter((k) => k.startsWith("incoming/"));

async function publishEvent(name: string) {
  const e = (await adm(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition as PageDefinition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return { id: e.id as string, token: e.guestToken as string };
}

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool); app = await buildApp(pool);
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ('du@t.test','du',$1,'super_admin') RETURNING id", [await hashPassword(PW)])).rows[0].id; void id;
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "du@t.test", password: PW } });
  sup = { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf };
  const a = await publishEvent("Direct A"), b = await publishEvent("Direct B");
  evA = a.id; tokA = a.token; evB = b.id; tokB = b.token;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("direct upload to object storage", () => {
  it("hands out a one-file signed address: short life, size and type signed, key inside the event's incoming folder", async () => {
    const sid = await newSession(tokA); const data = await jpeg(400, 300);
    const r = await post(tokA, sid, "upload-url", { bytes: data.length, slot: 2 });
    expect(r.statusCode).toBe(200);
    const j = r.json(); const u = new URL(j.upload.url);
    expect(j.upload.method).toBe("PUT");
    expect(keyOfUrl(j.upload.url)).toMatch(new RegExp(`^incoming/${evA}/[0-9a-f]{32}$`));
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toMatch(/content-length/);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toMatch(/content-type/);
    expect(typeof j.ticket).toBe("string");
  });

  it("works end to end: the original is stored untouched in the event's originals, the unfinished copy is gone, the answer is the same as the plain upload", async () => {
    const sid = await newSession(tokA); const data = await jpeg(2000, 3000, "#2255aa");
    const { confirm, key } = await directUpload(tokA, sid, data);
    expect(confirm.statusCode).toBe(201);
    const c = confirm.json(); expect(c).toMatchObject({ width: 2000, height: 3000, lowResolution: false, bytes: data.length });
    const row = (await pool.query("SELECT event_id,session_id,storage_key,mime,bytes,sha256,slot FROM photo_uploads WHERE id=$1", [c.uploadId])).rows[0];
    expect(row.event_id).toBe(evA); expect(row.session_id).toBe(sid); expect(row.mime).toBe("image/jpeg"); expect(row.slot).toBe(1);
    expect(row.storage_key).toMatch(new RegExp(`^events/${evA}/originals/[0-9a-f]{32}\\.jpg$`));
    expect((await storage.getFile(row.storage_key)).equals(data)).toBe(true);
    expect(fake.objects.has(key)).toBe(false);
  });

  it("applies the same checks as the plain route: the same photo again is a duplicate, a replaced photo removes the old one", async () => {
    const sid = await newSession(tokA); const one = await jpeg(1800, 1200, "#111");
    const a = (await directUpload(tokA, sid, one)).confirm.json();
    const b = (await directUpload(tokA, sid, one)).confirm.json();
    expect(b.duplicate).toBe(true); expect(b.uploadId).toBe(a.uploadId);
    const two = await jpeg(1800, 1200, "#eee");
    const c = (await directUpload(tokA, sid, two)).confirm.json();
    expect(c.uploadId).not.toBe(a.uploadId);
    expect(await storage.statFile((await pool.query("SELECT storage_key FROM photo_uploads WHERE id=$1", [a.uploadId])).rows[0].storage_key)).toBeNull();   // replaced: old file deleted
  });

  it("refuses to hand out an address for a bad request", async () => {
    const sid = await newSession(tokA);
    expect((await post(tokA, null, "upload-url", { bytes: 1000 })).statusCode).toBe(401);                       // no guest session
    expect((await post(tokA, "00000000-0000-4000-8000-000000000000", "upload-url", { bytes: 1000 })).statusCode).toBe(401);
    expect((await post(tokA, sid, "upload-url", { bytes: 0 })).statusCode).toBe(400);
    expect((await post(tokA, sid, "upload-url", { bytes: -5 })).statusCode).toBe(400);
    expect((await post(tokA, sid, "upload-url", { bytes: "9" })).statusCode).toBe(400);
    expect((await post(tokA, sid, "upload-url", { bytes: 100, slot: 9 })).statusCode).toBe(400);
    expect((await post(tokA, sid, "upload-url", {})).statusCode).toBe(400);
    const tooBig = await post(tokA, sid, "upload-url", { bytes: 26 * 1024 * 1024 });                            // this event allows 25 MB
    expect(tooBig.statusCode).toBe(413); expect(tooBig.json().maxMb).toBe(25);
    expect((await post("0".repeat(24), sid, "upload-url", { bytes: 1000 })).statusCode).toBe(404);              // unknown event link
    expect((await post(tokB, sid, "upload-url", { bytes: 1000 })).statusCode).toBe(401);                        // session of another event
  });

  it("stops at the per-session photo limit", async () => {
    const sid = await newSession(tokB);
    for (let i = 0; i < MAX_UPLOADS_PER_SESSION; i++) await pool.query("INSERT INTO photo_uploads(event_id,session_id,storage_key,mime,bytes,width,height,sha256,slot) VALUES ($1,$2,$3,'image/jpeg',1,10,10,$4,1)", [evB, sid, `events/${evB}/originals/x${i}.jpg`, `h${i}`]);
    expect((await post(tokB, sid, "upload-url", { bytes: 1000 })).statusCode).toBe(429);
  });

  it("confirm rejects a ticket that is edited, expired, from another guest, another event, or points outside the event's incoming folder", async () => {
    const sid = await newSession(tokA); const other = await newSession(tokA);
    const j = (await post(tokA, sid, "upload-url", { bytes: 1000 })).json();
    const ok = await post(tokA, sid, "confirm", { ticket: j.ticket });
    expect(ok.statusCode).toBe(404);                                                                             // genuine ticket, nothing uploaded yet
    const [body, sig] = (j.ticket as string).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), k: `incoming/${evA}/${"a".repeat(32)}` })).toString("base64url");
    for (const t of [forged + "." + sig, body + "." + "A".repeat(sig.length), body, "", "x.y.z", 42, null, { a: 1 }]) expect((await post(tokA, sid, "confirm", { ticket: t })).statusCode, String(t)).toBe(400);
    expect((await post(tokA, other, "confirm", { ticket: j.ticket })).statusCode).toBe(400);                    // another guest's ticket
    expect((await post(tokB, await newSession(tokB), "confirm", { ticket: j.ticket })).statusCode).toBe(400);   // another event's page
    const expired = signUploadTicket({ e: evA, s: sid, slot: 1, k: `incoming/${evA}/${"b".repeat(32)}`, n: 10 }, -60);
    expect((await post(tokA, sid, "confirm", { ticket: expired })).statusCode).toBe(400);
    const outside = signUploadTicket({ e: evA, s: sid, slot: 1, k: `events/${evA}/originals/${"c".repeat(32)}.jpg`, n: 10 });   // would let a guest "finish" (and delete) a stored file
    fake.objects.set(`events/${evA}/originals/${"c".repeat(32)}.jpg`, { body: Buffer.alloc(10) });
    expect((await post(tokA, sid, "confirm", { ticket: outside })).statusCode).toBe(400);
    expect(fake.objects.has(`events/${evA}/originals/${"c".repeat(32)}.jpg`)).toBe(true);                       // and nothing was deleted
    const otherEvent = signUploadTicket({ e: evA, s: sid, slot: 1, k: `incoming/${evB}/${"d".repeat(32)}`, n: 10 });
    expect((await post(tokA, sid, "confirm", { ticket: otherEvent })).statusCode).toBe(400);
  });

  it("confirm refuses and cleans up when what arrived is not an acceptable photo", async () => {
    const sid = await newSession(tokA); const before = (await pool.query("SELECT count(*)::int c FROM photo_uploads WHERE session_id=$1", [sid])).rows[0].c;
    const cases: [string, Buffer, number, string][] = [
      ["html", Buffer.from("<html><script>alert(1)</script></html>"), 415, "unsupported_image"],
      ["php", Buffer.from("<?php system($_GET['c']); ?>"), 415, "unsupported_image"],
      ["gif", Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;", "binary"), 415, "unsupported_image"],
      ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), 415, "unsupported_image"],
      ["truncated jpeg", (await jpeg(800, 800)).subarray(0, 600), 415, "unsupported_image"],
      ["heic", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(40)]), 415, "heic_unsupported"],
      ["decompression bomb (121 megapixels)", await sharp({ create: { width: 11000, height: 11000, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer(), 415, "unsupported_image"],
    ];
    for (const [name, data, status, error] of cases) {
      const { confirm } = await directUpload(tokA, sid, data);
      expect(confirm.statusCode, name).toBe(status); expect(confirm.json().error, name).toBe(error);
    }
    expect(incoming()).toEqual([]);                                                                              // no unfinished file is left behind
    expect((await pool.query("SELECT count(*)::int c FROM photo_uploads WHERE session_id=$1", [sid])).rows[0].c).toBe(before);
    expect([...fake.objects.keys()].filter((k) => k.startsWith(`events/${evA}/originals/`) && k.includes(sid))).toEqual([]);
  });

  it("confirm refuses a file whose size is not the declared size, and deletes it", async () => {
    const sid = await newSession(tokA); const data = await jpeg(500, 500);
    const j = (await post(tokA, sid, "upload-url", { bytes: data.length })).json();
    fake.objects.set(keyOfUrl(j.upload.url), { body: Buffer.concat([data, Buffer.alloc(10)]) });                // 10 bytes more than declared
    const c = await post(tokA, sid, "confirm", { ticket: j.ticket });
    expect(c.statusCode).toBe(413); expect(incoming()).toEqual([]);
  });

  it("a ticket works once: finishing twice finds nothing the second time and records one photo", async () => {
    const sid = await newSession(tokA); const data = await jpeg(900, 600, "#7a3");
    const first = await directUpload(tokA, sid, data);
    expect(first.confirm.statusCode).toBe(201);
    const again = await post(tokA, sid, "confirm", { ticket: first.ticket });
    expect(again.statusCode).toBe(404); expect(again.json().error).toBe("upload_not_found");
    expect((await pool.query("SELECT count(*)::int c FROM photo_uploads WHERE session_id=$1 AND deleted_at IS NULL", [sid])).rows[0].c).toBe(1);
  });

  it("flags low resolution and reads EXIF orientation like the plain route", async () => {
    const sid = await newSession(tokA);
    const small = (await directUpload(tokA, sid, await jpeg(800, 600, "#456"))).confirm.json();
    expect(small.lowResolution).toBe(true);
    const rotated = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#654" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = (await directUpload(tokA, sid, rotated, 2)).confirm.json();
    expect([r.width, r.height]).toEqual([1200, 1600]);
  });

  it("on local-disk storage there is no direct address: the answer says so and the client uses the plain route", async () => {
    const before = (storage as any);
    storage.setStorageBackend(new DiskBackend(fs.mkdtempSync(path.join(os.tmpdir(), "rsp-disk-d-"))));
    try {
      const sid = await newSession(tokA);
      const r = await post(tokA, sid, "upload-url", { bytes: 1000 });
      expect(r.statusCode).toBe(501); expect(r.json().error).toBe("direct_upload_unavailable");
    } finally { storage.setStorageBackend(new S3Backend(fake, "bkt", "", signer)); void before; }
  });
});

describe("mosaic master, direct upload (staff)", () => {
  const url = (ev: string, what: string) => `/api/v1/events/${ev}/mosaic/master/${what}`;
  const noise = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } } as any).png().toBuffer();
  async function master(ev: string, data: Buffer, who = sup) {
    const r = await adm(who, "POST", url(ev, "upload-url"), { bytes: data.length });
    if (r.statusCode !== 200) return { r, confirm: null as any };
    const j = r.json(); fake.objects.set(keyOfUrl(j.upload.url), { body: data });
    return { r, confirm: await adm(who, "POST", url(ev, "confirm"), { ticket: j.ticket }), ticket: j.ticket as string };
  }

  it("installs a master larger than the plain upload route accepts, keeps the bytes untouched, and removes the unfinished copy", async () => {
    const data = await noise(1800, 1800);
    expect(data.length).toBeGreaterThan(4.2 * 1024 * 1024);                                   // over the 4 MB the plain route takes
    const { confirm } = await master(evA, data);
    expect(confirm.statusCode).toBe(201);
    const key = (await pool.query("SELECT master_storage_key k FROM mosaic_projects WHERE event_id=$1", [evA])).rows[0].k as string;
    expect(key).toMatch(new RegExp(`^events/${evA}/mosaic/[0-9a-f]{32}\.png$`));
    expect((await storage.getFile(key)).equals(data)).toBe(true);
    expect(incoming()).toEqual([]);
    const plain = await adm(sup, "POST", `/api/v1/events/${evA}/mosaic/master`, undefined);
    expect([400, 415]).toContain(plain.statusCode);                                           // (the plain route is still there; it just cannot carry big files)
  });

  it("replacing the master removes the old one", async () => {
    const oldKey = (await pool.query("SELECT master_storage_key k FROM mosaic_projects WHERE event_id=$1", [evA])).rows[0].k as string;
    const { confirm } = await master(evA, await sharp({ create: { width: 900, height: 600, channels: 3, background: "#4a8" } }).jpeg().toBuffer());
    expect(confirm.statusCode).toBe(201);
    expect(await storage.statFile(oldKey)).toBeNull();
  });

  it("refuses bad requests and bad files, and cleans up", async () => {
    expect((await adm(sup, "POST", url(evA, "upload-url"), { bytes: 26 * 1024 * 1024 })).statusCode).toBe(413);
    expect((await adm(sup, "POST", url(evA, "upload-url"), { bytes: 0 })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: url(evA, "upload-url"), payload: { bytes: 10 } })).statusCode).toBe(401);          // not signed in
    for (const [name, data, status, error] of [
      ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"/>'), 415, "unsupported_image"],
      ["text", Buffer.from("not an image at all"), 415, "unsupported_image"],
      ["tiny", await sharp({ create: { width: 100, height: 100, channels: 3, background: "#000" } }).png().toBuffer(), 422, "master_too_small"],
    ] as [string, Buffer, number, string][]) {
      const { confirm } = await master(evA, data);
      expect(confirm.statusCode, name).toBe(status); expect(confirm.json().error, name).toBe(error);
    }
    expect(incoming()).toEqual([]);
  });

  it("a ticket cannot be used on another event or by another person, and works once", async () => {
    const data = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#a48" } }).png().toBuffer();
    const j = (await adm(sup, "POST", url(evA, "upload-url"), { bytes: data.length })).json();
    fake.objects.set(keyOfUrl(j.upload.url), { body: data });
    expect((await adm(sup, "POST", url(evB, "confirm"), { ticket: j.ticket })).statusCode).toBe(400);                // another event
    await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ('du2@t.test','du2',$1,'super_admin')", [await hashPassword(PW)]);
    const l2 = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "du2@t.test", password: PW } });
    const sup2 = { cookie: (l2.headers["set-cookie"] as string).split(";")[0], csrf: l2.json().csrf };
    expect((await adm(sup2, "POST", url(evA, "confirm"), { ticket: j.ticket })).statusCode).toBe(400);               // another person
    expect((await adm(sup, "POST", url(evA, "confirm"), { ticket: j.ticket })).statusCode).toBe(201);
    expect((await adm(sup, "POST", url(evA, "confirm"), { ticket: j.ticket })).statusCode).toBe(404);                // second time: nothing left
  });
});
