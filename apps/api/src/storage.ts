import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable } from "node:stream";
import { config } from "./config";
import { DiskBackend, s3FromSettings, checkKey, type StorageBackend, type PresignGetOptions, type PresignPutOptions } from "./storageBackends";

export type { StorageBackend } from "./storageBackends";
export { S3Backend, DiskBackend } from "./storageBackends";

/**
 * Storage facade. Every file the platform keeps goes through these functions; where the bytes really live (local disk, or S3-compatible
 * object storage such as Cloudflare R2) is decided by STORAGE_BACKEND. Keys are random and never derived from user input.
 * A server may carry its own storage folder (two servers in one process, as in the offline-mode tests): that always means local disk.
 */
export const storageContext = new AsyncLocalStorage<{ root: string }>();

let configured: StorageBackend | null = null;
const folders = new Map<string, DiskBackend>();

/** Test seam: a test file may install a factory (globalThis.__rspStorageFactory) to run the whole suite on another backend. */
function configuredBackend(): StorageBackend {
  if (configured) return configured;
  const factory = (globalThis as { __rspStorageFactory?: () => StorageBackend }).__rspStorageFactory;
  configured = factory ? factory() : config.storage.backend === "s3" ? s3FromSettings(config.storage.s3) : new DiskBackend(config.storageDir);
  return configured;
}
export function setStorageBackend(b: StorageBackend | null) { configured = b; }

function backend(): StorageBackend {
  const root = storageContext.getStore()?.root;
  if (!root) return configuredBackend();
  let d = folders.get(root); if (!d) { d = new DiskBackend(root); folders.set(root, d); }
  return d;
}
export const storageKind = () => backend().kind;

export async function putFile(prefix: string, ext: string, data: Buffer): Promise<string> {
  const key = `${checkKey(prefix)}/${randomBytes(16).toString("hex")}.${ext}`;
  await backend().put(key, data);
  return key;
}

export const getFile = (key: string): Promise<Buffer> => backend().get(key);
export const deleteFile = (key: string): Promise<void> => backend().delete(key);
export const deletePrefix = (prefix: string): Promise<void> => backend().deletePrefix(prefix);

export type ImageKind = { ext: "png" | "jpg" | "webp" | "svg"; mime: string };

/** Identify an upload by its CONTENT (never by the client-supplied type or file name). */
export function sniffImage(b: Buffer): ImageKind | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length > 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return { ext: "webp", mime: "image/webp" };
  const head = b.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { ext: "svg", mime: "image/svg+xml" };
  return null;
}

/** SVG can carry script. Reject (not "clean") anything active so what we store is exactly what was inspected. */
export function svgIsSafe(svg: string): boolean {
  const s = svg.toLowerCase();
  if (/<\s*(script|foreignobject|iframe|object|embed|animate|set|link|meta|base|audio|video)\b/.test(s)) return false;
  if (/\bon[a-z]+\s*=/.test(s)) return false;
  if (/javascript:|data:text\/html|<!entity|<!doctype|@import/.test(s)) return false;     // @import would let a stylesheet pull in a remote file
  for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/g)) {
    if (!(m[1].startsWith("#") || m[1].startsWith("data:image/png") || m[1].startsWith("data:image/jpeg"))) return false;
  }
  if (/url\(\s*["']?(?!#)/.test(s)) return false;
  return true;
}

/** Read a stored file as a stream (large exports must not be held in memory). */
export const streamFile = (key: string): Readable => backend().stream(key);

/** Write a file under a caller-chosen (stable) key, e.g. a cached thumbnail. Never used for guest-supplied names. */
export const writeStable = (key: string, data: Buffer): Promise<void> => backend().put(key, data);

/** Names of the files directly inside a storage folder (empty when it does not exist). */
export const listFiles = (prefix: string): Promise<string[]> => backend().list(prefix);

/** Size of a stored file, or null when it is not there. */
export const statFile = (key: string): Promise<number | null> => backend().stat(key);

/** A short-lived direct address for a stored file, or null when the backend cannot make one (local disk): the caller then serves the bytes itself. */
export const presignGet = (key: string, o: PresignGetOptions): Promise<string | null> => backend().presignGet(key, o);

/** A short-lived address a browser can PUT a file to directly (size and type are signed). Null on local disk: the caller then accepts the bytes itself. */
export const presignPut = (key: string, o: PresignPutOptions): Promise<{ url: string; headers: Record<string, string> } | null> => backend().presignPut(key, o);

/** Copy a stored file to another key without moving its bytes through this process. */
export const copyFile = (from: string, to: string): Promise<void> => backend().copy(from, to);
