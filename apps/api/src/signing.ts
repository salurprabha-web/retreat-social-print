import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

/** Expiring, tamper-proof photo links. The id is a random UUID AND the link is signed, so URLs can be neither guessed nor edited. */
const mac = (id: string, exp: number) => createHmac("sha256", config.urlSecret).update(`${id}.${exp}`).digest("hex").slice(0, 40);

export function signCompositionPath(id: string, ttlHours = config.compositionUrlTtlHours, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + Math.round(ttlHours * 3600);
  return `/api/v1/public/c/${id}?exp=${exp}&sig=${mac(id, exp)}`;
}

export function verifyComposition(id: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
  const e = Number(exp);
  if (!Number.isInteger(e) || typeof sig !== "string" || sig.length !== 40 || e < Math.floor(now / 1000)) return false;
  return timingSafeEqual(Buffer.from(mac(id, e)), Buffer.from(sig));
}

/**
 * Upload ticket: issued when a browser is allowed to upload ONE file straight to storage, and required to finish the upload.
 * It binds the event, the guest session, the slot, the storage key and the declared size, and it expires. It cannot be edited or reused for
 * another key, session or event.
 */
export interface UploadTicket { e: string; s: string; slot: number; k: string; n: number; x: number }
const ticketMac = (body: string) => createHmac("sha256", config.urlSecret).update("upload-ticket:" + body).digest("base64url");

export function signUploadTicket(t: Omit<UploadTicket, "x">, ttlSeconds = 900, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...t, x: Math.floor(now / 1000) + ttlSeconds })).toString("base64url");
  return body + "." + ticketMac(body);
}

export function verifyUploadTicket(ticket: unknown, now = Date.now()): UploadTicket | null {
  if (typeof ticket !== "string" || ticket.length > 1024) return null;
  const [body, sig, extra] = ticket.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(ticketMac(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadTicket;
    if (typeof t.e !== "string" || typeof t.s !== "string" || typeof t.k !== "string" || !Number.isInteger(t.n) || !Number.isInteger(t.slot) || !Number.isInteger(t.x)) return null;
    return t.x < Math.floor(now / 1000) ? null : t;
  } catch { return null; }
}
