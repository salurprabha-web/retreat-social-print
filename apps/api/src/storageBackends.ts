import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
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
}

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
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    }
    await this.delete(prefix);      // the prefix may itself be a single file
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
