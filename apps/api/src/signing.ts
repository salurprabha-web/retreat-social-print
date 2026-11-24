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
