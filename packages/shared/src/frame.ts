import { z } from "zod";
import { FONTS } from "./page";

/* ---------- Output formats (300 DPI print composition) ---------- */
export const DPI = 300;
export const FRAME_FORMATS = {
  "4x6": { label: "4 × 6 in", wIn: 4, hIn: 6 },
  "5x7": { label: "5 × 7 in", wIn: 5, hIn: 7 },
  "6x8": { label: "6 × 8 in", wIn: 6, hIn: 8 },
  "2x6": { label: "2 × 6 in (photo strip)", wIn: 2, hIn: 6 },
  A5: { label: "A5 (148 × 210 mm)", wIn: 148 / 25.4, hIn: 210 / 25.4 },
  custom: { label: "Custom size", wIn: 4, hIn: 6 },
} as const;
export type FrameFormat = keyof typeof FRAME_FORMATS;
export const FORMAT_KEYS = Object.keys(FRAME_FORMATS) as [FrameFormat, ...FrameFormat[]];

export function frameSize(format: FrameFormat, orientation: "portrait" | "landscape", custom?: { wIn: number; hIn: number }) {
  const f = format === "custom" && custom ? custom : FRAME_FORMATS[format];
  const w = Math.round(f.wIn * DPI), h = Math.round(f.hIn * DPI);
  return orientation === "landscape" ? { widthPx: Math.max(w, h), heightPx: Math.min(w, h) } : { widthPx: Math.min(w, h), heightPx: Math.max(w, h) };
}

/* ---------- Layers: geometry is a fraction of the canvas so one design works at any DPI ---------- */
const geo = {
  id: z.string().min(1).max(40),
  name: z.string().max(60).optional(),
  x: z.number().min(-0.25).max(1.25), y: z.number().min(-0.25).max(1.25),
  w: z.number().min(0.005).max(1.5), h: z.number().min(0.005).max(1.5),
  rotation: z.number().min(-360).max(360),
  opacity: z.number().min(0).max(1),
  locked: z.boolean().default(false), hidden: z.boolean().default(false),
};
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const asset = z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp|svg)$/);

export const layerSchema = z.discriminatedUnion("type", [
  z.object({ ...geo, type: z.literal("photo"), slot: z.number().int().min(1).max(8), radius: z.number().min(0).max(0.5), borderColor: color.nullable(), borderWidth: z.number().min(0).max(0.1) }),
  z.object({ ...geo, type: z.literal("image"), src: asset.nullable(), fit: z.enum(["contain", "cover", "stretch"]) }),
  z.object({ ...geo, type: z.literal("text"), text: z.string().max(200), color, fontFamily: z.enum(FONTS), sizePct: z.number().min(0.5).max(40), bold: z.boolean(), italic: z.boolean(), align: z.enum(["left", "center", "right"]) }),
  z.object({ ...geo, type: z.literal("shape"), shape: z.enum(["rect", "ellipse"]), fill: color, radius: z.number().min(0).max(0.5) }),
  z.object({ ...geo, type: z.literal("logo"), which: z.enum(["event", "client"]) }),
]);
export type FrameLayer = z.infer<typeof layerSchema>;
export type LayerType = FrameLayer["type"];

export const frameInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  format: z.enum(FORMAT_KEYS),
  orientation: z.enum(["portrait", "landscape"]).default("portrait"),
  customWidthIn: z.number().min(1).max(12).optional(),
  customHeightIn: z.number().min(1).max(12).optional(),
  active: z.boolean().default(true),
  layers: z.array(layerSchema).max(60),
}).superRefine((f, ctx) => {
  if (f.format === "custom" && (!f.customWidthIn || !f.customHeightIn)) ctx.addIssue({ code: "custom", message: "custom size needs width and height", path: ["customWidthIn"] });
  const slots = f.layers.filter((l) => l.type === "photo");
  if (!slots.length) ctx.addIssue({ code: "custom", message: "A frame needs at least one photo placeholder", path: ["layers"] });
  const nums = slots.map((l) => (l as any).slot as number);
  if (new Set(nums).size !== nums.length) ctx.addIssue({ code: "custom", message: "Photo placeholders must have different numbers", path: ["layers"] });
  const ids = f.layers.map((l) => l.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate layer id", path: ["layers"] });
});
export type FrameInput = z.infer<typeof frameInputSchema>;

export const customSize = (f: { format: FrameFormat; customWidthIn?: number; customHeightIn?: number }) =>
  f.format === "custom" ? { wIn: f.customWidthIn!, hIn: f.customHeightIn! } : undefined;

/* ---------- Layer helpers ---------- */
export const newLayerId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const base = (o: Partial<{ x: number; y: number; w: number; h: number }>) => ({ id: newLayerId(), x: o.x ?? 0.1, y: o.y ?? 0.1, w: o.w ?? 0.5, h: o.h ?? 0.2, rotation: 0, opacity: 1, locked: false, hidden: false });

export function newLayer(type: LayerType, o: Partial<{ x: number; y: number; w: number; h: number }> = {}, extra: Record<string, unknown> = {}): FrameLayer {
  switch (type) {
    case "photo": return { ...base({ w: 0.8, h: 0.6, ...o }), type, slot: 1, radius: 0, borderColor: null, borderWidth: 0, ...extra } as FrameLayer;
    case "image": return { ...base({ w: 0.4, h: 0.2, ...o }), type, src: null, fit: "contain", ...extra } as FrameLayer;
    case "text": return { ...base({ w: 0.8, h: 0.08, ...o }), type, text: "{{event.name}}", color: "#111111", fontFamily: "sans", sizePct: 4, bold: true, italic: false, align: "center", ...extra } as FrameLayer;
    case "shape": return { ...base({ w: 0.9, h: 0.9, ...o }), type, shape: "rect", fill: "#ffffff", radius: 0, ...extra } as FrameLayer;
    case "logo": return { ...base({ w: 0.3, h: 0.1, ...o }), type, which: "event", ...extra } as FrameLayer;
  }
}

export const PRESETS = ["single", "collage2", "trio", "quad", "strip", "polaroid"] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABEL: Record<Preset, string> = {
  single: "One large photo", collage2: "Two-photo collage", trio: "Three-photo layout", quad: "Four-photo grid", strip: "Photo strip", polaroid: "Polaroid",
};

/** Starter layouts. Slots are placed in canvas fractions with margins that look even on any paper size. */
export function presetLayers(kind: Preset, widthPx: number, heightPx: number): FrameLayer[] {
  const m = 0.05;                                   // margin as a fraction of the canvas WIDTH
  const mx = m, my = (m * widthPx) / heightPx;      // same physical margin vertically
  const cap = 0.12;                                 // caption band height (fraction of height)
  const bg = newLayer("shape", { x: 0, y: 0, w: 1, h: 1 }, { name: "Background", fill: "#ffffff" });
  const slot = (n: number, x: number, y: number, w: number, h: number) => newLayer("photo", { x, y, w, h }, { slot: n, name: `Photo ${n}` });
  const title = (y: number, h = 0.07, size = 3.2) => newLayer("text", { x: mx, y, w: 1 - 2 * mx, h }, { name: "Title", text: "{{event.name}}", sizePct: size });
  const tag = (y: number) => newLayer("text", { x: mx, y, w: 1 - 2 * mx, h: 0.05 }, { name: "Hashtag", text: "#{{event.hashtag}}", sizePct: 2.2, bold: false, color: "#555555" });
  const innerW = 1 - 2 * mx, top = my, bandTop = 1 - cap;
  const areaH = bandTop - top - my;                 // vertical space for photos above the caption
  const gap = 0.02;
  switch (kind) {
    case "single": return [bg, slot(1, mx, top, innerW, areaH), title(bandTop + 0.005), tag(bandTop + 0.065)];
    case "collage2": {
      const h = (areaH - gap) / 2;
      return [bg, slot(1, mx, top, innerW, h), slot(2, mx, top + h + gap, innerW, h), title(bandTop + 0.005), tag(bandTop + 0.065)];
    }
    case "trio": {
      const big = areaH * 0.58, small = areaH - big - gap, w2 = (innerW - gap) / 2;
      return [bg, slot(1, mx, top, innerW, big), slot(2, mx, top + big + gap, w2, small), slot(3, mx + w2 + gap, top + big + gap, w2, small), title(bandTop + 0.005), tag(bandTop + 0.065)];
    }
    case "quad": {
      const w2 = (innerW - gap) / 2, h2 = (areaH - gap) / 2;
      return [bg, slot(1, mx, top, w2, h2), slot(2, mx + w2 + gap, top, w2, h2), slot(3, mx, top + h2 + gap, w2, h2), slot(4, mx + w2 + gap, top + h2 + gap, w2, h2), title(bandTop + 0.005), tag(bandTop + 0.065)];
    }
    case "strip": {
      const n = 3, capS = 0.1, area = 1 - top - my - capS, h = (area - gap * (n - 1)) / n;
      return [bg, ...Array.from({ length: n }, (_, i) => slot(i + 1, mx, top + i * (h + gap), innerW, h)), newLayer("text", { x: mx, y: 1 - capS, w: innerW, h: 0.06 }, { name: "Title", text: "{{event.name}}", sizePct: 2.4 })];
    }
    case "polaroid": {
      // Square photo sized by whichever dimension limits it (works for portrait, landscape and strips).
      const pad = 0.04;                                         // card padding, fraction of the canvas width
      const capH = 0.2;                                         // caption area below the photo, fraction of height
      const s = Math.min((1 - 2 * mx) * widthPx, (1 - 2 * my - capH) * heightPx);   // photo side in px
      const sw = s / widthPx, sh = s / heightPx;
      const cardW = sw + 2 * pad * 0.5, cardH = sh + capH + pad * 0.5 * (widthPx / heightPx);
      const cx = (1 - sw) / 2, cardX = (1 - cardW) / 2, cardY = Math.max(0, (1 - cardH) / 2);
      const y0 = cardY + (pad * 0.5 * widthPx) / heightPx;
      return [
        newLayer("shape", { x: 0, y: 0, w: 1, h: 1 }, { name: "Background", fill: "#e9e6df" }),
        newLayer("shape", { x: cardX, y: cardY, w: cardW, h: Math.min(cardH, 1 - cardY) }, { name: "Polaroid card", fill: "#ffffff", radius: 0.01 }),
        slot(1, cx, y0, sw, sh),
        newLayer("text", { x: cx, y: y0 + sh + 0.02, w: sw, h: Math.min(0.08, capH - 0.04) }, { name: "Caption", text: "{{event.name}}", fontFamily: "script", sizePct: 4.4, bold: false }),
      ];
    }
  }
}
