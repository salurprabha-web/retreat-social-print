import { describe, it, expect } from "vitest";
import sharp, { type Sharp } from "sharp";
import { NO_ADJUST, newLayer, type EventInfo, type FrameLayer, type PhotoAdjust } from "@rsp/shared";
import { composeFrame, type SlotImage } from "../src/compose";

const EVENT: EventInfo = { name: "Rao Engagement", hashtag: "RaoEngaged", eventDate: "2026-12-05", clientName: "Rao Family" };
const W = 1200, H = 1800;

type RGB = [number, number, number];
const near = (a: RGB, b: RGB, tol = 30) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
async function sampler(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return (x: number, y: number): RGB => { const o = (Math.round(y) * info.width + Math.round(x)) * info.channels; return [data[o], data[o + 1], data[o + 2]]; };
}
const RED: RGB = [255, 0, 0], GREEN: RGB = [0, 255, 0], BLUE: RGB = [0, 0, 255], WHITE: RGB = [255, 255, 255];
const jpg = (s: Sharp) => s.jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
const solid = (w: number, h: number, c: string) => ({ create: { width: w, height: h, channels: 3 as const, background: c } });

/** left half red | right half green */
const leftRight = (w: number, h: number) => jpg(sharp(solid(w, h, "#ff0000")).composite([{ input: { create: { width: w / 2, height: h, channels: 3, background: "#00ff00" } }, left: w / 2, top: 0 }]));
/** top half red / bottom half blue */
const topBottom = (w: number, h: number) => jpg(sharp(solid(w, h, "#ff0000")).composite([{ input: { create: { width: w, height: h / 2, channels: 3, background: "#0000ff" } }, left: 0, top: h / 2 }]));

const slot = (n: number, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => newLayer("photo", { x, y, w, h }, { slot: n, ...extra });
const photo = (data: Buffer, width: number, height: number, adjust: Partial<PhotoAdjust> = {}): SlotImage => ({ data, width, height, adjust: { ...NO_ADJUST, ...adjust } });
async function render(layers: FrameLayer[], photos: Record<number, SlotImage> = {}, w = W, h = H) {
  return composeFrame({ widthPx: w, heightPx: h, layers, event: EVENT, photos: new Map(Object.entries(photos).map(([k, v]) => [+k, v])), asset: async () => null, logo: async () => null });
}
// A full-canvas portrait slot (aspect 1.5) with no margins: pixel (x,y) of the output = pixel of the slot.
const FULL = () => slot(1, 0, 0, 1, 1);

describe("output file", () => {
  it("is a JPEG at the exact frame size with 300 DPI metadata", async () => {
    const out = await render([FULL()], { 1: photo(await leftRight(3000, 2000), 3000, 2000) });
    const m = await sharp(out.buffer).metadata();
    expect(m.format).toBe("jpeg"); expect([m.width, m.height]).toEqual([W, H]); expect(m.density).toBe(300);
    expect([out.width, out.height]).toEqual([W, H]);
  });
  it("fails loudly when a photo slot has no photo", async () => { await expect(render([FULL()], {})).rejects.toThrow(/slot 1/); });
});

describe("photo placement (same maths as the guest editor)", () => {
  it("covers the slot, centred: a landscape photo shows its middle", async () => {
    const s = await sampler((await render([FULL()], { 1: photo(await leftRight(3000, 2000), 3000, 2000) })).buffer);
    expect(near(s(W * 0.25, H / 2), RED)).toBe(true); expect(near(s(W * 0.75, H / 2), GREEN)).toBe(true);
    expect(near(s(W * 0.45, 20), RED)).toBe(true); expect(near(s(W * 0.55, H - 20), GREEN)).toBe(true);
  });
  it("zoom + offset pans to the edges of the photo", async () => {
    const img = await leftRight(4000, 3000);
    const L = await sampler((await render([FULL()], { 1: photo(img, 4000, 3000, { zoom: 3, offsetX: -1 }) })).buffer);
    expect(near(L(10, 10), RED) && near(L(W - 10, H - 10), RED) && near(L(W / 2, H / 2), RED)).toBe(true);
    const R = await sampler((await render([FULL()], { 1: photo(img, 4000, 3000, { zoom: 3, offsetX: 1 }) })).buffer);
    expect(near(R(10, 10), GREEN) && near(R(W - 10, H - 10), GREEN) && near(R(W / 2, H / 2), GREEN)).toBe(true);
  });
  it("a 90 degree guest rotation turns the photo clockwise (top goes to the right)", async () => {
    const s = await sampler((await render([FULL()], { 1: photo(await topBottom(2000, 3000), 2000, 3000, { rotate: 90 }) })).buffer);
    expect(near(s(W * 0.9, H / 2), RED)).toBe(true); expect(near(s(W * 0.1, H / 2), BLUE)).toBe(true);
  });
  it("honours EXIF orientation of phone photos", async () => {
    // pixels: left red | right green, tagged orientation 6 (display rotated 90 clockwise) -> displayed: top red, bottom green
    const buf = await sharp(await leftRight(3000, 2000)).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).withMetadata({ orientation: 6 }).toBuffer();
    const s = await sampler((await render([FULL()], { 1: photo(buf, 2000, 3000) })).buffer);   // oriented dims are 2000x3000
    expect(near(s(W / 2, H * 0.2), RED)).toBe(true); expect(near(s(W / 2, H * 0.8), GREEN)).toBe(true);
  });
  it("rounds corners and draws borders on top without shrinking the photo", async () => {
    const out = await render([slot(1, 0.1, 0.1, 0.8, 0.8, { radius: 0.5 })], { 1: photo(await leftRight(3000, 2000), 3000, 2000) });
    const s = await sampler(out.buffer);
    expect(near(s(W * 0.1 + 2, H * 0.1 + 2), WHITE, 10)).toBe(true);        // clipped corner shows the white page
    expect(near(s(W * 0.3, H * 0.5), RED)).toBe(true);
    const b = await sampler((await render([slot(1, 0.1, 0.1, 0.8, 0.8, { borderColor: "#0000ff", borderWidth: 0.02 })], { 1: photo(await leftRight(3000, 2000), 3000, 2000) })).buffer);
    expect(near(b(W * 0.1 + 6, H * 0.5), BLUE)).toBe(true);                   // ring at the slot edge
    expect(near(b(W * 0.1 + 40, H * 0.5), RED)).toBe(true);                   // photo continues just inside the ring (24px ring)
  });
  it("renders a multi-slot frame, each slot with its own photo", async () => {
    const layers = [slot(1, 0, 0, 1, 0.5), slot(2, 0, 0.5, 1, 0.5)];
    const s = await sampler((await render(layers, { 1: photo(await jpg(sharp(solid(2000, 1000, "#ff0000"))), 2000, 1000), 2: photo(await jpg(sharp(solid(2000, 1000, "#0000ff"))), 2000, 1000) })).buffer);
    expect(near(s(100, 100), RED)).toBe(true); expect(near(s(100, H - 100), BLUE)).toBe(true);
  });
  it("handles 12-megapixel photos in a three-photo frame quickly", async () => {
    const big = await jpg(sharp(solid(4000, 3000, "#336699")));
    const layers = [slot(1, 0.05, 0.05, 0.9, 0.5), slot(2, 0.05, 0.57, 0.43, 0.3), slot(3, 0.52, 0.57, 0.43, 0.3)];
    const t0 = Date.now();
    await render(layers, { 1: photo(big, 4000, 3000, { zoom: 2 }), 2: photo(big, 4000, 3000), 3: photo(big, 4000, 3000, { rotate: 90 }) });
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

describe("shapes, rotation, opacity, clipping", () => {
  const box = (extra: Record<string, unknown>, o: Partial<{ x: number; y: number; w: number; h: number }> = {}) => newLayer("shape", { x: 0.45, y: 0.4, w: 0.1, h: 0.2, ...o }, { fill: "#ff0000", ...extra });
  it("draws shapes in layer order over the white page", async () => {
    const s = await sampler((await render([FULL(), box({ fill: "#0000ff" }, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 })], { 1: photo(await jpg(sharp(solid(2000, 3000, "#00ff00"))), 2000, 3000) })).buffer);
    expect(near(s(W / 2, H / 2), BLUE)).toBe(true); expect(near(s(50, 50), GREEN)).toBe(true);
  });
  it("rotates about the layer centre (a tall bar rotated 90 degrees becomes wide)", async () => {
    const s = await sampler((await render([newLayer("shape", { x: 0.45, y: 0.25, w: 0.1, h: 0.5 }, { fill: "#ff0000", rotation: 90 })], {})).buffer);
    expect(near(s(W / 2 + 380, H / 2), RED)).toBe(true);     // wide now
    expect(near(s(W / 2, H / 2 + 380), WHITE, 10)).toBe(true); // no longer tall
  });
  it("rotates a photo slot clockwise like the preview", async () => {
    const sq = slot(1, 0.25, 0.4167, 0.5, 0.3333, { rotation: 90 });   // ~600x600 px square
    const s = await sampler((await render([sq], { 1: photo(await topBottom(2000, 2000), 2000, 2000) })).buffer);
    expect(near(s(W / 2 + 200, H / 2), RED)).toBe(true); expect(near(s(W / 2 - 200, H / 2), BLUE)).toBe(true);
  });
  it("applies opacity", async () => {
    const s = await sampler((await render([box({ opacity: 0.5 })])).buffer);
    expect(near(s(W / 2, H / 2), [255, 128, 128], 12)).toBe(true);
  });
  it("crops layers that extend past the canvas instead of failing", async () => {
    const s = await sampler((await render([newLayer("shape", { x: -0.1, y: -0.1, w: 0.4, h: 0.4 }, { fill: "#ff0000" }), newLayer("shape", { x: 0.9, y: 0.9, w: 0.4, h: 0.4 }, { fill: "#0000ff" })])).buffer);
    expect(near(s(10, 10), RED)).toBe(true); expect(near(s(W - 10, H - 10), BLUE)).toBe(true);
  });
  it("skips hidden layers", async () => {
    const s = await sampler((await render([box({ hidden: true })])).buffer);
    expect(near(s(W / 2, H / 2), WHITE, 5)).toBe(true);
  });
});

describe("text with bundled fonts", () => {
  const txt = (extra: Record<string, unknown>) => newLayer("text", { x: 0.05, y: 0.4, w: 0.9, h: 0.15 }, { text: "Rao Engagement", color: "#000000", sizePct: 6, ...extra });
  async function ink(layer: FrameLayer) {
    const { data } = await sharp((await render([layer])).buffer).raw().toBuffer({ resolveWithObject: true });
    let dark = 0, sum = 0; for (let i = 0; i < data.length; i += 3) if (data[i] < 128) { dark++; sum += (i / 3) % W; }
    return { dark, mean: dark ? sum / dark : 0 };
  }
  it("draws text, replaces event tokens and centres it", async () => {
    const a = await ink(txt({ text: "{{event.name}}", align: "center" }));
    expect(a.dark).toBeGreaterThan(2000); expect(Math.abs(a.mean - W / 2)).toBeLessThan(60);
    const l = await ink(txt({ align: "left" })), r = await ink(txt({ align: "right" }));
    expect(l.mean).toBeLessThan(a.mean); expect(r.mean).toBeGreaterThan(a.mean);
  });
  it("every font renders differently, bold differs from regular, and Hindi renders", async () => {
    const seen = new Set<number>();
    for (const f of ["sans", "serif", "elegant", "display", "rounded", "mono", "condensed", "script"]) {
      const r = await ink(txt({ fontFamily: f })); expect(r.dark, f).toBeGreaterThan(500); seen.add(r.dark);
    }
    expect(seen.size).toBe(8);
    expect((await ink(txt({ bold: true }))).dark).toBeGreaterThan((await ink(txt({ bold: false }))).dark);
    expect((await ink(txt({ text: "राव शादी" }))).dark).toBeGreaterThan(1000);
  });
  it("wraps long text inside its box and clips overflow", async () => {
    const r = await ink(txt({ text: "A very long congratulations message for the happy couple and all of their guests", h: 0.3, y: 0.3 } as any));
    expect(r.dark).toBeGreaterThan(3000);
    const s = await sampler((await render([txt({ text: "WIDE WIDE WIDE WIDE", w: 0.2, x: 0.4, color: "#ff0000", sizePct: 9 })])).buffer);
    expect(near(s(20, H * 0.47), WHITE, 5)).toBe(true);      // nothing leaks outside the box
  });
});
