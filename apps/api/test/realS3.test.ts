import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { s3FromSettings, type S3Backend } from "../src/storageBackends";

/**
 * The S3 backend against a REAL S3-compatible server (the stand-in used elsewhere proves our logic, not the protocol).
 * Runs only when TEST_S3_ENDPOINT is set, e.g.:
 *   TEST_S3_ENDPOINT=http://localhost:9100 TEST_S3_KEY=minioadmin TEST_S3_SECRET=... pnpm --filter @rsp/api test realS3
 * MinIO speaks the same protocol as Cloudflare R2 for everything used here, but it is not R2: the real bucket must still be checked
 * (docs/VERCEL.md has the checklist).
 */
const endpoint = process.env.TEST_S3_ENDPOINT;
const bucket = "rsp-real-s3-" + randomBytes(4).toString("hex");
const raw = endpoint ? new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: { accessKeyId: process.env.TEST_S3_KEY!, secretAccessKey: process.env.TEST_S3_SECRET! } }) : null;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.runIf(!!endpoint)("S3 backend against a real S3-compatible server", () => {
  let b: S3Backend;
  beforeAll(async () => {
    await raw!.send(new CreateBucketCommand({ Bucket: bucket }));
    b = s3FromSettings({ endpoint, bucket, region: "us-east-1", accessKeyId: process.env.TEST_S3_KEY!, secretAccessKey: process.env.TEST_S3_SECRET!, prefix: "", forcePathStyle: true }) as S3Backend;
  });
  afterAll(async () => {
    let token: string | undefined;
    do {
      const l = await raw!.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      for (const o of l.Contents ?? []) await raw!.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key! }));
      token = l.IsTruncated ? l.NextContinuationToken : undefined;
    } while (token);
    await raw!.send(new DeleteBucketCommand({ Bucket: bucket }));
  });

  it("stores, reads, stats, lists (files only), copies and deletes like the disk does", async () => {
    const data = randomBytes(5000);
    await b.put("events/e1/finals/a.jpg", data);
    expect((await b.get("events/e1/finals/a.jpg")).equals(data)).toBe(true);
    expect(await b.stat("events/e1/finals/a.jpg")).toBe(5000);
    await expect(b.get("events/e1/finals/missing.jpg")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await b.stat("events/e1/finals/missing.jpg")).toBeNull();
    await b.put("events/e1/finals/sub/deep.jpg", Buffer.from("x"));
    expect(await b.list("events/e1/finals")).toEqual(["a.jpg"]);
    await b.copy("events/e1/finals/a.jpg", "events/e1/originals/copy.jpg");
    expect((await b.get("events/e1/originals/copy.jpg")).equals(data)).toBe(true);
    await expect(b.copy("events/e1/none.jpg", "events/e1/x.jpg")).rejects.toMatchObject({ code: "ENOENT" });
    await b.delete("events/e1/originals/copy.jpg"); await b.delete("events/e1/originals/copy.jpg");       // twice: not an error
    expect(await b.stat("events/e1/originals/copy.jpg")).toBeNull();
  });

  it("deletes a prefix of more than 1000 objects completely and leaves a sibling event alone", async () => {
    await Promise.all(Array.from({ length: 1100 }, (_, i) => b.put(`events/big/thumbs/t${i}.jpg`, Buffer.from("x"))));
    await b.put("events/big2/thumbs/keep.jpg", Buffer.from("k"));
    await b.deletePrefix("events/big");
    expect(await b.list("events/big/thumbs")).toEqual([]);
    expect(await b.stat("events/big2/thumbs/keep.jpg")).toBe(1);
  }, 120000);

  it("streams an object and sends a large stream as a multipart upload that arrives intact", async () => {
    const big = randomBytes(20 * 1024 * 1024);
    await b.putStream("exports/e1/big.zip", Readable.from([big.subarray(0, 7_000_000), big.subarray(7_000_000, 15_000_000), big.subarray(15_000_000)]));
    expect(await b.stat("exports/e1/big.zip")).toBe(big.length);
    const h = createHash("sha256"); for await (const c of b.stream("exports/e1/big.zip")) h.update(c as Buffer);
    expect(h.digest("hex")).toBe(sha(big));
    const chunks: Buffer[] = []; try { for await (const c of b.stream("exports/e1/none.zip")) chunks.push(c as Buffer); } catch (e: any) { expect(e.code).toBe("ENOENT"); return; }
    throw new Error("stream of a missing object must fail");
  }, 120000);

  it("a signed upload address accepts exactly the signed size and type, once it is used by the browser's own request", async () => {
    const data = randomBytes(300_000);
    const put = (await b.presignPut("incoming/e1/ok1", { expiresIn: 60, contentType: "application/octet-stream", contentLength: data.length }))!;
    const ok = await fetch(put.url, { method: "PUT", headers: put.headers, body: new Uint8Array(data) });
    expect(ok.status).toBe(200);
    expect((await b.get("incoming/e1/ok1")).equals(data)).toBe(true);
  });

  it("a signed upload address refuses a different size, a different type, a different key and an expired address", async () => {
    const data = randomBytes(1000);
    const put = (await b.presignPut("incoming/e1/guard", { expiresIn: 60, contentType: "application/octet-stream", contentLength: data.length }))!;
    // bigger than declared (the point of signing the size: a guest cannot declare 1 MB and send 100 MB)
    const bigger = await fetch(put.url, { method: "PUT", headers: put.headers, body: new Uint8Array(randomBytes(2000)) });
    expect(bigger.status, "bigger body").toBeGreaterThanOrEqual(400);
    // another content type
    const typed = await fetch(put.url, { method: "PUT", headers: { "Content-Type": "text/html" }, body: new Uint8Array(data) });
    expect(typed.status, "other type").toBeGreaterThanOrEqual(400);
    // another key under the same signature
    const moved = await fetch(put.url.replace("incoming/e1/guard", "incoming/e1/other"), { method: "PUT", headers: put.headers, body: new Uint8Array(data) });
    expect(moved.status, "other key").toBeGreaterThanOrEqual(400);
    expect(await b.stat("incoming/e1/other")).toBeNull();
    // expired
    const short = (await b.presignPut("incoming/e1/late", { expiresIn: 1, contentType: "application/octet-stream", contentLength: data.length }))!;
    await new Promise((r) => setTimeout(r, 2500));
    const late = await fetch(short.url, { method: "PUT", headers: short.headers, body: new Uint8Array(data) });
    expect(late.status, "expired").toBeGreaterThanOrEqual(400);
    expect(await b.stat("incoming/e1/late")).toBeNull();
    // and after all that, the genuine upload still works (the refusals did not use it up or damage anything)
    expect((await fetch(put.url, { method: "PUT", headers: put.headers, body: new Uint8Array(data) })).status).toBe(200);
  }, 30000);

  it("a signed download address serves the file with the chosen type and name, and only that file", async () => {
    const data = randomBytes(4000);
    await b.put("events/e1/finals/pic.jpg", data); await b.put("events/e1/finals/secret.jpg", Buffer.from("secret"));
    const url = (await b.presignGet("events/e1/finals/pic.jpg", { expiresIn: 60, filename: "photo.jpg" }))!;
    const r = await fetch(url);
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toBe("image/jpeg"); expect(r.headers.get("content-disposition")).toBe('attachment; filename="photo.jpg"');
    expect(Buffer.from(await r.arrayBuffer()).equals(data)).toBe(true);
    const inline = await fetch((await b.presignGet("events/e1/finals/pic.jpg", { expiresIn: 60, inline: true }))!);
    expect(inline.headers.get("content-disposition")).toBe("inline");
    const swapped = await fetch(url.replace("pic.jpg", "secret.jpg"));                      // pointing the same signature at another file
    expect(swapped.status).toBeGreaterThanOrEqual(400);
  });

  it("works with a key prefix (several installations in one bucket)", async () => {
    const p = s3FromSettings({ endpoint, bucket, region: "us-east-1", accessKeyId: process.env.TEST_S3_KEY!, secretAccessKey: process.env.TEST_S3_SECRET!, prefix: "tenant-a/", forcePathStyle: true }) as S3Backend;
    await p.put("events/e9/finals/a.jpg", Buffer.from("A"));
    expect(await b.stat("tenant-a/events/e9/finals/a.jpg")).toBe(1);
    expect(await p.list("events/e9/finals")).toEqual(["a.jpg"]);
    await p.deletePrefix("events/e9");
    expect(await b.stat("tenant-a/events/e9/finals/a.jpg")).toBeNull();
  });
});
