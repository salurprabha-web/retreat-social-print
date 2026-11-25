import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { Upload } from "@aws-sdk/lib-storage";
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, CopyObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Where files live. Two implementations: the local disk (development, tests, the Docker deployment, offline venue servers) and
 * S3-compatible object storage (Cloudflare R2 for the Vercel deployment). Callers use the functions in storage.ts, never these directly.
 * Contract that callers rely on: `get` THROWS (code ENOENT) for a missing key, `list` returns files only (direct children), `delete` of a
 * missing key is not an error.
 */
export interface PresignGetOptions { expiresIn: number; filename?: string; inline?: boolean; contentType?: string }
export interface StorageBackend {
  readonly kind: "disk" | "s3";
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  stream(key: string): Readable;
  list(prefix: string): Promise<string[]>;
  stat(key: string): Promise<number | null>;
  /** A short-lived address the browser can fetch directly from the store. Null when the backend cannot (disk). */
  presignGet(key: string, o: PresignGetOptions): Promise<string | null>;
  /** A short-lived address the browser can PUT a file to directly. The size and type are part of the signature. Null when the backend cannot (disk). */
  presignPut(key: string, o: PresignPutOptions): Promise<{ url: string; headers: Record<string, string> } | null>;
  /** Stores a stream of any size without holding it in memory (large exports). */
  putStream(key: string, data: Readable): Promise<void>;
  /** Server-side copy inside the store (no bytes pass through this process). */
  copy(from: string, to: string): Promise<void>;
}
export interface PresignPutOptions { expiresIn: number; contentType: string; contentLength: number }

/** Keys are made by the server, but they are validated anyway: no traversal, no empty parts, no control characters. */
export function checkKey(key: string): string {
  if (!key || key.length > 512 || key.startsWith("/") || /[\\\0]/.test(key) || key.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error("invalid storage key");
  return key;
}

const missing = (key: string) => Object.assign(new Error(`stored file not found: ${key}`), { code: "ENOENT", path: key });

/* ---------- disk ---------- */
export class DiskBackend implements StorageBackend {
  readonly kind = "disk" as const;
  private readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private resolve(key: string): string {
    const p = path.resolve(this.root, checkKey(key));
    if (!p.startsWith(this.root + path.sep)) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) { const p = this.resolve(key); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); }
  get(key: string) { return fs.readFile(this.resolve(key)); }
  delete(key: string) { return fs.rm(this.resolve(key), { force: true }); }
  deletePrefix(prefix: string) { return fs.rm(this.resolve(prefix), { recursive: true, force: true }); }
  stream(key: string) { return createReadStream(this.resolve(key)); }
  async list(prefix: string) { try { return (await fs.readdir(this.resolve(prefix), { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name); } catch { return []; } }
  async stat(key: string) { try { return (await fs.stat(this.resolve(key))).size; } catch { return null; } }
  async presignGet() { return null; }
  async presignPut() { return null; }
  async putStream(key: string, data: Readable) { const p = this.resolve(key); await fs.mkdir(path.dirname(p), { recursive: true }); await pipeline(data, createWriteStream(p)); }
  async copy(from: string, to: string) { const t = this.resolve(to); await fs.mkdir(path.dirname(t), { recursive: true }); await fs.copyFile(this.resolve(from), t); }
}

/* ---------- S3-compatible ---------- */
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml", zip: "application/zip", json: "application/json" };
const mimeOf = (key: string) => MIME[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** The part of the S3 client this module uses; lets tests supply an in-memory stand-in. */
export interface S3Like { send(command: any): Promise<any> }

export class S3Backend implements StorageBackend {
  readonly kind = "s3" as const;
  /** `signer` must be a real S3Client (presigning is local computation, no network); defaults to `client`. */
  constructor(private readonly client: S3Like, private readonly bucket: string, private readonly prefix = "", private readonly signer: S3Client = client as S3Client) {}
  private k(key: string) { return this.prefix + checkKey(key); }
  private p(prefix: string) { return this.prefix + checkKey(prefix) + "/"; }

  async put(key: string, data: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: data, ContentType: mimeOf(key), ContentLength: data.length }));
  }
  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return Buffer.from(await r.Body.transformToByteArray());
    } catch (e: any) { if (isMissing(e)) throw missing(key); throw e; }
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) })); }
  async deletePrefix(prefix: string) {
    // List everything first, then delete: removing objects while paging through the listing must never make pages skip keys.
    const keys: string[] = []; let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.p(prefix), ContinuationToken: token }));
      for (const o of r.Contents ?? []) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    // Batches of up to 1000. Some S3-compatible stores refuse the batch call (it needs a checksum header they may not accept), so whatever the
    // batch did not delete is deleted one object at a time: slower, but it works everywhere.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      try {
        const r = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
        const failed: string[] = (r?.Errors ?? []).map((e: any) => e.Key);
        if (failed.length) await this.deleteEach(failed);
      } catch { await this.deleteEach(chunk); }
    }
    await this.delete(prefix);      // the prefix may itself be a single file
  }
  private async deleteEach(keys: string[]) {
    for (let i = 0; i < keys.length; i += 25) await Promise.all(keys.slice(i, i + 25).map((Key) => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }))));
  }
  stream(key: string) {
    const out = new PassThrough();
    this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }))
      .then((r) => (r.Body as Readable).on("error", (e: Error) => out.destroy(e)).pipe(out))
      .catch((e: any) => out.destroy(isMissing(e) ? missing(key) : e));
    return out;
  }
  async list(prefix: string) {
    const names: string[] = []; let token: string | undefined; const pre = this.p(prefix);
    try {
      do {
        const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: pre, Delimiter: "/", ContinuationToken: token }));
        for (const o of r.Contents ?? []) { const n = String(o.Key).slice(pre.length); if (n && !n.includes("/")) names.push(n); }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
    } catch { return []; }
    return names;
  }
  async stat(key: string) {
    try { return Number((await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }))).ContentLength ?? 0); }
    catch (e: any) { if (isMissing(e)) return null; throw e; }
  }
  async putStream(key: string, data: Readable) {
    // Multipart upload: parts of 8 MB are sent as the stream produces them, so memory stays small however large the file is.
    // Some stream libraries (archiver) use their own stream classes, which the uploader does not recognise: hand it a standard Node stream.
    const body = new PassThrough();
    data.on("error", (e: Error) => body.destroy(e)); data.pipe(body);
    await new Upload({ client: this.client as S3Client, params: { Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: mimeOf(key) }, partSize: 8 * 1024 * 1024, queueSize: 3, leavePartsOnError: false }).done();
  }
  async copy(from: string, to: string) {
    try { await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: this.k(to), CopySource: encodeURIComponent(this.bucket + "/" + this.k(from)).replace(/%2F/g, "/") })); }
    catch (e: any) { if (isMissing(e)) throw missing(from); throw e; }
  }
  async presignPut(key: string, o: PresignPutOptions) {
    const url = await getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), ContentType: o.contentType, ContentLength: o.contentLength }),
      { expiresIn: o.expiresIn, signableHeaders: new Set(["content-type", "content-length"]) });
    return { url, headers: { "Content-Type": o.contentType } };
  }
  async presignGet(key: string, o: PresignGetOptions) {
    return getSignedUrl(this.signer, new GetObjectCommand({
      Bucket: this.bucket, Key: this.k(key),
      ResponseContentType: o.contentType ?? mimeOf(key),
      ResponseContentDisposition: o.filename ? `${o.inline ? "inline" : "attachment"}; filename="${o.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"` : o.inline ? "inline" : undefined,
    }), { expiresIn: o.expiresIn });
  }
}

function isMissing(e: any) { return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404; }

export interface S3Settings { endpoint?: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; prefix: string; forcePathStyle: boolean }

export function s3FromSettings(s: S3Settings): S3Backend {
  if (!s.bucket || !s.accessKeyId || !s.secretAccessKey) throw new Error("S3 storage needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
  const client = new S3Client({
    region: s.region, endpoint: s.endpoint || undefined, forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // R2 does not support the SDK's newer default checksums on every operation.
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  return new S3Backend(client, s.bucket, s.prefix ? s.prefix.replace(/^\/+|\/+$/g, "") + "/" : "");
}
