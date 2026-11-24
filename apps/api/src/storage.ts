import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config";

/** Local-disk storage. Keys are random and never derived from user input; the interface is what an S3 backend would implement. */
const root = () => path.resolve(config.storageDir);

function resolveKey(key: string): string {
  const p = path.resolve(root(), key);
  if (!p.startsWith(root() + path.sep)) throw new Error("invalid storage key");
  return p;
}

export async function putFile(prefix: string, ext: string, data: Buffer): Promise<string> {
  const key = `${prefix}/${randomBytes(16).toString("hex")}.${ext}`;
  const p = resolveKey(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data, { flag: "wx" });
  return key;
}

export const getFile = (key: string) => fs.readFile(resolveKey(key));
export const deleteFile = (key: string) => fs.rm(resolveKey(key), { force: true });
export const deletePrefix = (prefix: string) => fs.rm(resolveKey(prefix), { recursive: true, force: true });

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
  if (/<\s*(script|foreignobject|iframe|object|embed|animate|set)\b/.test(s)) return false;
  if (/\bon[a-z]+\s*=/.test(s)) return false;
  if (/javascript:|data:text\/html|<!entity|<!doctype/.test(s)) return false;
  for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/g)) {
    if (!(m[1].startsWith("#") || m[1].startsWith("data:image/png") || m[1].startsWith("data:image/jpeg"))) return false;
  }
  if (/url\(\s*["']?(?!#)/.test(s)) return false;
  return true;
}

/** Read a stored file as a stream (large exports must not be held in memory). */
export const streamFile = (key: string) => createReadStream(resolveKey(key));

/** Write a file under a caller-chosen (stable) key, e.g. a cached thumbnail. Never used for guest-supplied names. */
export async function writeStable(key: string, data: Buffer): Promise<void> {
  const p = resolveKey(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
}
