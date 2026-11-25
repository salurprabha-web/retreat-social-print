import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { S3Backend, DiskBackend } from "../src/storageBackends";
import { FakeS3 } from "./helpers/fakeS3";

// The cloud side of the offline sync on object storage (in-memory stand-in): signed file delivery and package export.
(globalThis as any).__rspNoFollow = true;   // these suites look at the redirects themselves
const fake = new FakeS3();
const signer = new S3Client({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" } });
const s3 = () => new S3Backend(fake, "bkt", "", signer);
(globalThis as any).__rspStorageFactory = s3;
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-s-"));
const { buildApp } = await import("../src/app");
const storage = await import("../src/storage");
const { client } = await import("../src/syncService");
const { signUploadTicket } = await import("../src/signing");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
let sup: { cookie: string; csrf: string }; let evA: string, evB: string; let tokA: string, tokB: string;
const PW = "correct horse battery";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const adm = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: sup.cookie, "x-rsp-csrf": sup.csrf } });
const sync = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
const keyOfUrl = (u: string) => decodeURIComponent(new URL(u).pathname.slice(1));
const incoming = () => [...fake.objects.keys()].filter((k) => k.startsWith("incoming/"));
const fkey = (ev: string, kind = "finals", name = "a".repeat(32), ext = "jpg") => `events/${ev}/${kind}/${name}.${ext}`;

async function deliver(token: string, key: string, data: Buffer, over: { sha?: string; size?: number } = {}) {
  const ask = await sync(token, "POST", "/api/v1/sync/file/upload-url", { key, size: over.size ?? data.length, sha256: over.sha ?? sha(data) });
  if (ask.statusCode !== 200) return { ask, done: null as any };
  const j = ask.json(); fake.objects.set(keyOfUrl(j.upload.url), { body: data });
  return { ask, done: await sync(token, "POST", "/api/v1/sync/file/confirm", { ticket: j.ticket, key, sha256: sha(data) }), ticket: j.ticket as string };
}

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool); app = await buildApp(pool);
  await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ('sd@t.test','sd',$1,'super_admin')", [await hashPassword(PW)]);
  const l = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "sd@t.test", password: PW } });
  sup = { cookie: (l.headers["set-cookie"] as string).split(";")[0], csrf: l.json().csrf };
  evA = (await adm("POST", "/api/v1/events", { name: "Sync A" })).json().event.id; evB = (await adm("POST", "/api/v1/events", { name: "Sync B" })).json().event.id;
  tokA = (await adm("POST", `/api/v1/events/${evA}/sync-credentials`, { name: "venue" })).json().token;
  tokB = (await adm("POST", `/api/v1/events/${evB}/sync-credentials`, { name: "venue" })).json().token;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("sync file delivery to object storage", () => {
  it("delivers a file through a signed address, checks its checksum, and leaves no unfinished copy", async () => {
    const data = Buffer.from("pretend this is a 20 MB final picture ".repeat(100)); const key = fkey(evA);
    const { ask, done } = await deliver(tokA, key, data);
    expect(new URL(ask.json().upload.url).searchParams.get("X-Amz-SignedHeaders")).toMatch(/content-length/);
    expect(done.statusCode).toBe(201);
    expect((await storage.getFile(key)).equals(data)).toBe(true);
    expect(incoming()).toEqual([]);
  });

  it("refuses a file whose checksum is wrong, and stores nothing", async () => {
    const data = Buffer.from("damaged in transit"); const key = fkey(evA, "originals", "b".repeat(32)); const claimed = sha(Buffer.from("something else"));
    const ask = (await sync(tokA, "POST", "/api/v1/sync/file/upload-url", { key, size: data.length, sha256: claimed })).json();
    fake.objects.set(keyOfUrl(ask.upload.url), { body: data });                                  // the bytes that really arrived are not the ones the sender checksummed
    const bad = await sync(tokA, "POST", "/api/v1/sync/file/confirm", { ticket: ask.ticket, key, sha256: claimed });
    expect(bad.statusCode).toBe(422); expect(bad.json().error).toBe("checksum_mismatch");
    expect(await storage.statFile(key)).toBeNull(); expect(incoming()).toEqual([]);
  });

  it("only accepts the picture folders of the credential's own event, with plain names", async () => {
    const data = Buffer.from("x");
    for (const key of [fkey(evB), fkey(evA, "branding"), fkey(evA, "finals", "../x"), `events/${evA}/finals/a/b.jpg`, `events/${evA}/finals/${"a".repeat(65)}.jpg`, "incoming/x", "../../etc/passwd", ""]) {
      const r = await sync(tokA, "POST", "/api/v1/sync/file/upload-url", { key, size: data.length, sha256: sha(data) });
      expect(r.statusCode, key).toBe(422);
    }
    expect((await sync(tokA, "POST", "/api/v1/sync/file/upload-url", { key: fkey(evA), size: 0, sha256: sha(data) })).statusCode).toBe(400);
    expect((await sync(tokA, "POST", "/api/v1/sync/file/upload-url", { key: fkey(evA), size: 101 * 1024 * 1024, sha256: sha(data) })).statusCode).toBe(400);
    expect((await sync(tokA, "POST", "/api/v1/sync/file/upload-url", { key: fkey(evA), size: 1, sha256: "nothex" })).statusCode).toBe(400);
  });

  it("needs a valid credential, and a ticket only works for the credential, event and file it was made for", async () => {
    const data = Buffer.from("ticket test"); const key = fkey(evA, "finals", "c".repeat(32));
    expect((await sync(null, "POST", "/api/v1/sync/file/upload-url", { key, size: 1, sha256: sha(data) })).statusCode).toBe(401);
    expect((await sync("sync_" + "0".repeat(48), "POST", "/api/v1/sync/file/confirm", { ticket: "x", key, sha256: sha(data) })).statusCode).toBe(401);
    const ask = (await sync(tokA, "POST", "/api/v1/sync/file/upload-url", { key, size: data.length, sha256: sha(data) })).json();
    fake.objects.set(keyOfUrl(ask.upload.url), { body: data });
    expect((await sync(tokB, "POST", "/api/v1/sync/file/confirm", { ticket: ask.ticket, key: fkey(evB), sha256: sha(data) })).statusCode).toBe(400);     // another event's credential
    expect((await sync(tokA, "POST", "/api/v1/sync/file/confirm", { ticket: ask.ticket.slice(0, -2) + "xx", key, sha256: sha(data) })).statusCode).toBe(400);
    const outside = signUploadTicket({ e: evA, s: "x", slot: 0, k: `events/${evA}/finals/${"d".repeat(32)}.jpg`, n: 1 });
    expect((await sync(tokA, "POST", "/api/v1/sync/file/confirm", { ticket: outside, key, sha256: sha(data) })).statusCode).toBe(400);
    const ok = await sync(tokA, "POST", "/api/v1/sync/file/confirm", { ticket: ask.ticket, key, sha256: sha(data) });
    expect(ok.statusCode).toBe(201);
    expect((await sync(tokA, "POST", "/api/v1/sync/file/confirm", { ticket: ask.ticket, key, sha256: sha(data) })).statusCode).toBe(404);          // once
  });

  it("a file of a different size than declared is refused and removed", async () => {
    const data = Buffer.from("sized"); const key = fkey(evA, "finals", "e".repeat(32));
    const ask = (await sync(tokA, "POST", "/api/v1/sync/file/upload-url", { key, size: data.length, sha256: sha(data) })).json();
    fake.objects.set(keyOfUrl(ask.upload.url), { body: Buffer.concat([data, Buffer.from("extra")]) });
    const r = await sync(tokA, "POST", "/api/v1/sync/file/confirm", { ticket: ask.ticket, key, sha256: sha(data) });
    expect(r.statusCode).toBe(413); expect(await storage.statFile(key)).toBeNull(); expect(incoming()).toEqual([]);
  });
});

describe("the venue server's sync client", () => {
  const CLOUD = "https://cloud.test";
  const stub = (log: string[]) => async (url: string, init: any): Promise<Response> => {
    if (url.startsWith(CLOUD)) {
      log.push(`${init.method} ${url.slice(CLOUD.length).split("?")[0]}`);
      const r = await app.inject({ method: init.method, url: url.slice(CLOUD.length), headers: init.headers, payload: init.body ? Buffer.from(init.body) : undefined });
      return new Response(new Uint8Array(r.rawPayload), { status: r.statusCode, headers: { "content-type": "application/json" } });
    }
    log.push(`${init.method} bucket`);                                                  // the storage address
    if (init.method === "PUT") fake.objects.set(keyOfUrl(url), { body: Buffer.from(init.body) });
    return new Response(null, { status: 200 });
  };

  it("sends a file straight to storage and has the cloud confirm it", async () => {
    const log: string[] = []; const data = Buffer.from("venue picture bytes ".repeat(50)); const key = fkey(evA, "finals", "f".repeat(32));
    const cl = client({ cloudUrl: CLOUD, tokens: [], fetchImpl: stub(log) as any } as any, tokA);
    await cl.putFile(key, data);
    expect(log).toEqual(["POST /api/v1/sync/file/upload-url", "PUT bucket", "POST /api/v1/sync/file/confirm"]);
    expect((await storage.getFile(key)).equals(data)).toBe(true);
  });

  it("falls back to the plain upload when the cloud keeps files on a disk", async () => {
    const log: string[] = []; const data = Buffer.from("plain route"); const key = fkey(evA, "finals", "9".repeat(32));
    storage.setStorageBackend(new DiskBackend(fs.mkdtempSync(path.join(os.tmpdir(), "rsp-disk-s-"))));
    try {
      const cl = client({ cloudUrl: CLOUD, tokens: [], fetchImpl: stub(log) as any } as any, tokA);
      await cl.putFile(key, data);
      expect(log).toEqual(["POST /api/v1/sync/file/upload-url", "PUT /api/v1/sync/file"]);
      expect((await storage.getFile(key)).equals(data)).toBe(true);
    } finally { storage.setStorageBackend(s3()); }
  });

  it("treats a storage outage as 'cannot reach the cloud' (retried later) and a storage refusal as a refusal", async () => {
    const data = Buffer.from("x"); const key = fkey(evA, "finals", "8".repeat(32));
    const down = async (url: string, init: any) => (url.startsWith(CLOUD) ? stub([])(url, init) : new Response("busy", { status: 503 }));
    const err = await client({ cloudUrl: CLOUD, tokens: [], fetchImpl: down as any } as any, tokA).putFile(key, data).catch((e) => e);
    expect(err.constructor.name).toBe("CloudDown"); expect(err.message).toBe("storage_http_503");
    const denied = async (url: string, init: any) => (url.startsWith(CLOUD) ? stub([])(url, init) : new Response("no", { status: 403 }));
    await expect(client({ cloudUrl: CLOUD, tokens: [], fetchImpl: denied as any } as any, tokA).putFile(key, data)).rejects.toMatchObject({ status: 403, code: "storage_refused" });
  });
});

describe("event package export on object storage", () => {
  it("saves the package in storage and redirects to a short-lived signed download address", async () => {
    const r = await adm("GET", `/api/v1/events/${evA}/offline/package`);
    expect(r.statusCode).toBe(302);
    const u = new URL(r.headers.location as string);
    expect(u.hostname).toBe("bkt.acct.r2.cloudflarestorage.com");
    expect(u.pathname).toMatch(new RegExp(`^/exports/${evA}/[0-9a-f]{32}\\.rspkg$`));
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("response-content-disposition")).toBe(`attachment; filename="event-${evA.slice(0, 8)}.rspkg"`);
    expect(await storage.statFile(decodeURIComponent(u.pathname.slice(1)))).toBeGreaterThan(0);
  });

  it("keeps one package per event: a new export replaces the old one", async () => {
    const first = new URL((await adm("GET", `/api/v1/events/${evA}/offline/package`)).headers.location as string).pathname;
    const second = new URL((await adm("GET", `/api/v1/events/${evA}/offline/package`)).headers.location as string).pathname;
    expect(second).not.toBe(first);
    expect((await storage.listFiles(`exports/${evA}`)).length).toBe(1);
  });

  it("needs edit rights on that event (anonymous and other events' people get nothing)", async () => {
    expect((await app.inject({ method: "GET", url: `/api/v1/events/${evA}/offline/package` })).statusCode).toBe(401);
  });

  it("on a local-disk cloud the package is still sent as the response body", async () => {
    storage.setStorageBackend(new DiskBackend(fs.mkdtempSync(path.join(os.tmpdir(), "rsp-disk-p-"))));
    try {
      const r = await adm("GET", `/api/v1/events/${evA}/offline/package`);
      expect(r.statusCode).toBe(200); expect(r.headers["content-disposition"]).toMatch(/\.rspkg"/); expect(r.rawPayload.length).toBeGreaterThan(100);
    } finally { storage.setStorageBackend(s3()); }
  });
});
