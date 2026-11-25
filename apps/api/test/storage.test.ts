import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { DiskBackend, S3Backend, checkKey, type StorageBackend } from "../src/storageBackends";
import { FakeS3 } from "./helpers/fakeS3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const signer = new S3Client({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" } });

// The same contract tests run against both backends: whatever callers rely on must hold for each.
const makers: [string, () => StorageBackend][] = [
  ["disk", () => new DiskBackend(fs.mkdtempSync(path.join(tmp, "d-")))],
  ["s3 (paginated, 3 per page)", () => new S3Backend(new FakeS3(3), "bkt", "", signer)],
  ["s3 with a key prefix", () => new S3Backend(new FakeS3(3), "bkt", "env1/", signer)],
];

describe.each(makers)("storage contract: %s", (_n, make) => {
  let b: StorageBackend;
  beforeEach(() => { b = make(); });

  it("stores and reads back exactly the bytes", async () => {
    const data = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    await b.put("events/e1/originals/a.jpg", data);
    expect((await b.get("events/e1/originals/a.jpg")).equals(data)).toBe(true);
    expect(await b.stat("events/e1/originals/a.jpg")).toBe(7);
  });

  it("a missing file THROWS with code ENOENT on read (callers use this as 'not cached yet') and is null on stat", async () => {
    await expect(b.get("events/e1/none.jpg")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await b.stat("events/e1/none.jpg")).toBeNull();
  });

  it("deleting a missing file is not an error; deleting removes the file", async () => {
    await b.delete("events/e1/none.jpg");
    await b.put("events/e1/x.png", Buffer.from("x")); await b.delete("events/e1/x.png");
    expect(await b.stat("events/e1/x.png")).toBeNull();
  });

  it("overwrites a stable key", async () => {
    await b.put("events/e1/thumbs/t.jpg", Buffer.from("one")); await b.put("events/e1/thumbs/t.jpg", Buffer.from("three"));
    expect((await b.get("events/e1/thumbs/t.jpg")).toString()).toBe("three");
  });

  it("lists only the files directly inside a folder, across pages", async () => {
    for (let i = 0; i < 8; i++) await b.put(`events/e1/finals/f${i}.jpg`, Buffer.from("x"));
    await b.put("events/e1/finals/sub/deep.jpg", Buffer.from("x"));
    await b.put("events/e1/finals2/other.jpg", Buffer.from("x"));          // a folder whose name merely starts the same
    const names = (await b.list("events/e1/finals")).sort();
    expect(names).toEqual(Array.from({ length: 8 }, (_, i) => `f${i}.jpg`));
    expect(await b.list("events/e1/nothing")).toEqual([]);
  });

  it("deletePrefix removes everything below it (several pages) and nothing beside it", async () => {
    for (let i = 0; i < 10; i++) await b.put(`events/e1/thumbs/t${i}.jpg`, Buffer.from("x"));
    await b.put("events/e1/mosaic/tiles/a.jpg", Buffer.from("x"));
    await b.put("events/e10/thumbs/keep.jpg", Buffer.from("x"));            // different event whose id starts the same
    await b.put("events/e2/thumbs/keep.jpg", Buffer.from("x"));
    await b.deletePrefix("events/e1");
    expect(await b.list("events/e1/thumbs")).toEqual([]);
    expect(await b.stat("events/e1/mosaic/tiles/a.jpg")).toBeNull();
    expect(await b.stat("events/e10/thumbs/keep.jpg")).toBe(1);
    expect(await b.stat("events/e2/thumbs/keep.jpg")).toBe(1);
  });

  it("streams a file, and a stream of a missing file fails with ENOENT", async () => {
    await b.put("events/e1/finals/s.jpg", Buffer.from("streamed bytes"));
    const chunks: Buffer[] = []; for await (const c of b.stream("events/e1/finals/s.jpg")) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe("streamed bytes");
    await expect((async () => { for await (const _ of b.stream("events/e1/finals/none.jpg")) { /* empty */ } })()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses keys that could leave the storage area", async () => {
    for (const k of ["../secret", "events/../../x", "/abs/path", "a//b", "a\\b", "a/./b", "x\0y", ""]) {
      await expect(Promise.resolve().then(() => b.put(k, Buffer.from("x")))).rejects.toThrow();
    }
  });
});

describe("S3 backend specifics", () => {
  it("deletes in batches of at most 1000 keys", async () => {
    const f = new FakeS3(1000); const b = new S3Backend(f, "bkt", "", signer);
    for (let i = 0; i < 2300; i++) f.objects.set(`events/big/o${i}.jpg`, { body: Buffer.from("x") });
    await b.deletePrefix("events/big");
    expect(f.objects.size).toBe(0);
    expect(f.calls.filter((c) => c === "DeleteObjectsCommand").length).toBe(3);
  });

  it("sets a content type from the extension", async () => {
    const f = new FakeS3(); const b = new S3Backend(f, "bkt", "", signer);
    await b.put("events/e/a.jpg", Buffer.from("x")); await b.put("events/e/b.svg", Buffer.from("x")); await b.put("events/e/c.bin", Buffer.from("x"));
    expect([...f.objects.values()].map((o) => o.contentType)).toEqual(["image/jpeg", "image/svg+xml", "application/octet-stream"]);
  });

  it("makes a short-lived signed address bound to one key, with the download name", async () => {
    const b = new S3Backend(new FakeS3(), "bkt", "", signer);
    const u = new URL((await b.presignGet("events/e1/finals/a.jpg", { expiresIn: 300, filename: "photo.jpg" }))!);
    expect(u.hostname).toBe("bkt.acct.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/events/e1/finals/a.jpg");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get("response-content-disposition")).toBe('attachment; filename="photo.jpg"');
    expect(u.searchParams.get("response-content-type")).toBe("image/jpeg");
    // a different key gives a different signature (the address cannot be pointed at another file)
    const v = new URL((await b.presignGet("events/e1/finals/b.jpg", { expiresIn: 300 }))!);
    expect(v.searchParams.get("X-Amz-Signature")).not.toBe(u.searchParams.get("X-Amz-Signature"));
  });

  it("disk cannot make a direct address (the caller serves the bytes)", async () => {
    expect(await new DiskBackend(tmp).presignGet()).toBeNull();
  });

  it("key checker accepts the keys the platform makes", () => {
    expect(checkKey("events/6f1c1b52-0f2d-4a07-9d3a-1f6b0c2f7e11/finals/abc123.jpg")).toBeTruthy();
  });
});
