import { z } from "zod";
import type { PageDefinition } from "./page";

/**
 * Non-destructive photo adjustments chosen by the guest. The ORIGINAL file is never modified; composition (Phase 7) applies
 * these to the original. Semantics are aspect-agnostic: the photo is first scaled to COVER the target area, then multiplied by
 * `zoom`, then panned by `offsetX/offsetY` (each -1..1 = the full available overflow on that axis).
 */
export const photoAdjustSchema = z.object({
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  zoom: z.number().min(1).max(5),
  offsetX: z.number().min(-1).max(1),
  offsetY: z.number().min(-1).max(1),
});
export type PhotoAdjust = z.infer<typeof photoAdjustSchema>;
export const NO_ADJUST: PhotoAdjust = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

/**
 * Where the (rotated) photo sits inside a box. All lengths are in units of the BOX WIDTH, `boxAspect` = box height / width.
 * The guest editor draws it with CSS percentages; the composition engine (Phase 7) multiplies by the real pixel width, so
 * what the guest sees is exactly what is printed. offset +1 shows the right/bottom edge, -1 the left/top edge.
 */
export function coverLayout(imgW: number, imgH: number, adj: PhotoAdjust, boxAspect: number) {
  const quarter = adj.rotate % 180 !== 0;
  const sw = quarter ? imgH : imgW, sh = quarter ? imgW : imgH;      // dimensions after rotation
  const ar = sw / sh;
  const drawW = Math.max(1, boxAspect * ar) * adj.zoom;               // "cover" scale, then zoom
  const drawH = drawW / ar;
  const ox = Math.max(0, drawW - 1), oy = Math.max(0, drawH - boxAspect);
  return { drawW, drawH, ox, oy, left: -(ox / 2) * (1 + adj.offsetX), top: -(oy / 2) * (1 + adj.offsetY) };
}
/** Inverse of the above: offsets that put the image's top-left at (left, top). */
export function offsetsFor(l: { ox: number; oy: number }, left: number, top: number) {
  const c = (n: number) => Math.min(1, Math.max(-1, n));
  return { offsetX: l.ox > 0 ? c(-(2 * left) / l.ox - 1) : 0, offsetY: l.oy > 0 ? c(-(2 * top) / l.oy - 1) : 0 };
}

export const ACCEPTED_PHOTO_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_UPLOADS_PER_SESSION = 10;

export interface GuestInput { consent: boolean; fields: Record<string, string> }

const RULES: Record<string, (v: string) => string | null> = {
  name: (v) => (v.length <= 80 ? null : "Name is too long"),
  phone: (v) => (/^[+()\d\s-]{7,20}$/.test(v) ? null : "Enter a valid phone number"),
  email: (v) => (v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : "Enter a valid email address"),
  department: (v) => (v.length <= 80 ? null : "Too long"),
  company: (v) => (v.length <= 80 ? null : "Too long"),
  campaign: (v) => (v.length <= 80 ? null : "Too long"),
  consent: (v) => (v === "true" ? null : "Please accept to continue"),
};

/**
 * Shared by the guest UI (instant feedback) and the API (the real check). Required fields are enforced only when the
 * "details" step is enabled; empty optional fields are simply not stored. Unknown field ids are rejected.
 */
export function validateGuestInput(def: PageDefinition, input: GuestInput, requireConsent: boolean): { ok: boolean; errors: Record<string, string>; clean: Record<string, string> } {
  const errors: Record<string, string> = {}; const clean: Record<string, string> = {};
  const detailsOn = def.journey.steps.some((s) => s.id === "details" && s.enabled);
  const known = new Map(def.fields.map((f) => [f.id, f]));
  for (const k of Object.keys(input.fields)) if (!known.has(k)) errors[k] = "Unknown field";
  if (detailsOn) {
    for (const f of def.fields) {
      const v = (input.fields[f.id] ?? "").trim();
      if (!v) { if (f.required) errors[f.id] = f.type === "consent" ? "Please accept to continue" : "This field is required"; continue; }
      const e = RULES[f.type](v);
      if (e) errors[f.id] = e; else clean[f.id] = v;
    }
  }
  if (requireConsent && input.consent !== true) errors._consent = "Please accept to continue";
  return { ok: Object.keys(errors).length === 0, errors, clean };
}
