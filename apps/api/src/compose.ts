import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import {
  coverLayout, fillTokens,
  type EventInfo, type FrameLayer, type PhotoAdjust,
} from "@rsp/shared";
import { fontFamilies, registerFonts } from "./fonts";

/**
 * The ONE renderer for the final image. Download, share, photo wall and print all use the file it produces; the browser preview
 * (FrameCanvas) follows the same geometry, so what a guest approves is what prints.
 */
export interface SlotImage { data: Buffer; width: number; height: number /* after EXIF orientation */; adjust: PhotoAdjust }
export interface ComposeInput {
  widthPx: number; heightPx: number; layers: FrameLayer[]; event: EventInfo;
  photos: Map<number, SlotImage>;
  asset(name: string): Promise<Buffer | null>;
  logo(kind: "event" | "client"): Promise<Buffer | null>;
}
type Raw = { data: Buffer; width: number; height: number };

const MAX_SOURCE_SIDE = 8000;                        // plenty for 300 DPI up to 6x8 even when zoomed; bounds memory
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

async function toRaw(s: sharp.Sharp): Promise<Raw> {
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const fromRaw = (r: Raw) => sharp(r.data, { raw: { width: r.width, height: r.height, channels: 4 } });
const svg = (w: number, h: number, body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const rasterSvg = (w: number, h: number, body: string) => toRaw(sharp(svg(w, h, body), { density: 72 }));

/** Same rule the browser applies to a CSS percentage radius: a circle-cornered radius of (radius x slot width), never past half a side. */
const corner = (radius: number, w: number, h: number) => Math.max(0, Math.min(radius * w, w / 2, h / 2));

async function renderShape(l: Extract<FrameLayer, { type: "shape" }>, w: number, h: number): Promise<Raw> {
  if (l.shape === "ellipse") return rasterSvg(w, h, `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${l.fill}"/>`);
  const r = corner(l.radius, w, h);
  return rasterSvg(w, h, `<rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${l.fill}"/>`);
}

async function renderImage(buf: Buffer, w: number, h: number, fit: "contain" | "cover" | "stretch"): Promise<Raw> {
  return toRaw(sharp(buf, { density: 300 }).rotate().resize(w, h, { fit: fit === "stretch" ? "fill" : fit, background: CLEAR }));
}

/** Greedy word wrap like CSS `white-space: pre-wrap` (breaks at spaces and newlines only). */
export function wrapLines(ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/ +/).filter((x) => x.length);
    if (!words.length) { out.push(""); continue; }
    let line = words[0];
    for (const word of words.slice(1)) {
      const t = `${line} ${word}`;
      if (ctx.measureText(t).width <= maxW) line = t; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

async function renderText(l: Extract<FrameLayer, { type: "text" }>, w: number, h: number, canvasH: number, event: EventInfo): Promise<Raw> {
  registerFonts();
  const size = (canvasH * l.sizePct) / 100;
  const c = createCanvas(w, h); const x = c.getContext("2d");
  x.font = `${size}px ${fontFamilies(l.fontFamily, l.bold, l.italic)}`;
  x.fillStyle = l.color; x.textBaseline = "alphabetic"; x.textAlign = l.align;
  const m = x.measureText("Hg") as unknown as { fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number };
  const A = m.fontBoundingBoxAscent ?? size * 0.95, D = m.fontBoundingBoxDescent ?? size * 0.25;
  const lh = size * 1.1;                                  // matches line-height: 1.1 in the preview
  const lines = wrapLines(x, fillTokens(l.text, event), w);
  const top = (h - lines.length * lh) / 2;                // vertically centred in the box, overflow clipped like the preview
  const X = l.align === "left" ? 0 : l.align === "right" ? w : w / 2;
  lines.forEach((line, i) => x.fillText(line, X, top + i * lh + (lh - (A + D)) / 2 + A));
  return toRaw(sharp(c.toBuffer("image/png")));
}

async function renderPhoto(l: Extract<FrameLayer, { type: "photo" }>, w: number, h: number, p: SlotImage): Promise<Raw> {
  const a = p.adjust;
  const L = coverLayout(p.width, p.height, a, h / w);
  // A: orient (EXIF) and cap the size. B: guest rotation (lossless quarter turns). C: crop the visible window, resample once.
  const A = await toRaw(sharp(p.data, { limitInputPixels: 400_000_000 }).rotate().resize(MAX_SOURCE_SIDE, MAX_SOURCE_SIDE, { fit: "inside", withoutEnlargement: true }));
  const B = a.rotate ? await toRaw(fromRaw(A).rotate(a.rotate)) : A;
  const drawW = Math.max(w, L.drawW * w);                              // photo width in slot pixels
  const f = B.width / drawW;                                           // source px per slot px
  const cropL = Math.max(0, -L.left * w), cropT = Math.max(0, -L.top * w);
  const left = Math.min(B.width - 1, Math.round(cropL * f)), top = Math.min(B.height - 1, Math.round(cropT * f));
  const width = Math.max(1, Math.min(B.width - left, Math.round(w * f))), height = Math.max(1, Math.min(B.height - top, Math.round(h * f)));
  let out = await toRaw(fromRaw(B).extract({ left, top, width, height }).resize(w, h, { fit: "fill", kernel: "lanczos3" }));
  const r = corner(l.radius, w, h);
  if (r > 0) out = await toRaw(fromRaw(out).composite([{ input: svg(w, h, `<rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/>`), blend: "dest-in" }]));
  return out;
}

function ring(w: number, h: number, bw: number, radius: number, color: string): Promise<Raw> {
  const r = corner(radius, w, h);
  return rasterSvg(w, h, `<rect x="${bw / 2}" y="${bw / 2}" width="${Math.max(1, w - bw)}" height="${Math.max(1, h - bw)}" rx="${Math.max(0, r - bw / 2)}" ry="${Math.max(0, r - bw / 2)}" fill="none" stroke="${color}" stroke-width="${bw}"/>`);
}

async function withOpacity(r: Raw, opacity: number): Promise<Raw> {
  if (opacity >= 1) return r;
  return toRaw(fromRaw(r).composite([{ input: Buffer.from([255, 255, 255, Math.round(255 * opacity)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: "dest-in" }]));
}

export async function composeFrame(inp: ComposeInput): Promise<{ buffer: Buffer; width: number; height: number }> {
  const W = inp.widthPx, H = inp.heightPx;
  const ops: sharp.OverlayOptions[] = [];
  for (const l of inp.layers) {
    if (l.hidden) continue;
    const w = Math.round(l.w * W), h = Math.round(l.h * H);
    if (w < 1 || h < 1) continue;
    let layer: Raw | null = null;
    switch (l.type) {
      case "shape": layer = await renderShape(l, w, h); break;
      case "text": layer = await renderText(l, w, h, H, inp.event); break;
      case "image": { const b = l.src ? await inp.asset(l.src) : null; layer = b ? await renderImage(b, w, h, l.fit) : null; break; }
      case "logo": { const b = await inp.logo(l.which); layer = b ? await renderImage(b, w, h, "contain") : null; break; }
      case "photo": {
        const p = inp.photos.get(l.slot);
        if (!p) throw new Error(`no photo supplied for slot ${l.slot}`);
        layer = await renderPhoto(l, w, h, p);
        if (l.borderColor && l.borderWidth > 0) {
          const rg = await ring(w, h, Math.max(1, Math.round(l.borderWidth * W)), l.radius, l.borderColor);
          layer = await toRaw(fromRaw(layer).composite([{ input: rg.data, raw: { width: rg.width, height: rg.height, channels: 4 } }]));
        }
        break;
      }
    }
    if (!layer) continue;
    layer = await withOpacity(layer, l.opacity);
    // Rotate about the layer's centre (same as the preview), then place; anything outside the canvas is cropped away.
    let left = Math.round(l.x * W), top = Math.round(l.y * H);
    if (l.rotation % 360 !== 0) {
      const rot = await toRaw(fromRaw(layer).rotate(l.rotation, { background: CLEAR }));
      left = Math.round((l.x + l.w / 2) * W - rot.width / 2); top = Math.round((l.y + l.h / 2) * H - rot.height / 2);
      layer = rot;
    }
    const x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(W, left + layer.width), y1 = Math.min(H, top + layer.height);
    if (x1 <= x0 || y1 <= y0) continue;
    if (x0 !== left || y0 !== top || x1 !== left + layer.width || y1 !== top + layer.height)
      layer = await toRaw(fromRaw(layer).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }));
    ops.push({ input: layer.data, raw: { width: layer.width, height: layer.height, channels: 4 }, left: x0, top: y0 });
  }
  const buffer = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(ops).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).withMetadata({ density: 300 }).toBuffer();
  return { buffer, width: W, height: H };
}
