import { describe, it, expect } from "vitest";
import { PRESETS, frameInputSchema, frameSize, presetLayers, newLayer, type FrameFormat } from "../src";

describe("frame sizes at 300 DPI", () => {
  it("matches the print formats", () => {
    expect(frameSize("4x6", "portrait")).toEqual({ widthPx: 1200, heightPx: 1800 });
    expect(frameSize("5x7", "portrait")).toEqual({ widthPx: 1500, heightPx: 2100 });
    expect(frameSize("6x8", "portrait")).toEqual({ widthPx: 1800, heightPx: 2400 });
    expect(frameSize("2x6", "portrait")).toEqual({ widthPx: 600, heightPx: 1800 });
    expect(frameSize("A5", "portrait")).toEqual({ widthPx: 1748, heightPx: 2480 });
    expect(frameSize("4x6", "landscape")).toEqual({ widthPx: 1800, heightPx: 1200 });
    expect(frameSize("custom", "portrait", { wIn: 3.5, hIn: 5 })).toEqual({ widthPx: 1050, heightPx: 1500 });
  });
});

describe("presets", () => {
  const sizes: [FrameFormat, number, number][] = [["4x6", 1200, 1800], ["2x6", 600, 1800], ["6x8", 1800, 2400], ["4x6", 1800, 1200]];
  it("every preset on every size is a valid frame with the expected number of photo slots and no overlaps outside the canvas", () => {
    const expected = { single: 1, collage2: 2, trio: 3, quad: 4, strip: 3, polaroid: 1 } as const;
    for (const p of PRESETS) for (const [format, w, h] of sizes) {
      const layers = presetLayers(p, w, h);
      const r = frameInputSchema.safeParse({ name: p, format, layers });
      expect(r.success, `${p} ${w}x${h}`).toBe(true);
      const slots = layers.filter((l) => l.type === "photo");
      expect(slots).toHaveLength(expected[p]);
      for (const s of slots) { expect(s.x).toBeGreaterThanOrEqual(0); expect(s.y).toBeGreaterThanOrEqual(0); expect(s.x + s.w).toBeLessThanOrEqual(1.0001); expect(s.y + s.h).toBeLessThanOrEqual(1.0001); }
    }
  });
  it("photo slots in a preset never overlap each other", () => {
    for (const p of PRESETS) {
      const s = presetLayers(p, 1200, 1800).filter((l) => l.type === "photo");
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
        const a = s[i], b = s[j];
        const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
        expect(overlap, `${p} ${i} ${j}`).toBe(false);
      }
    }
  });
});

describe("frame validation", () => {
  const ok = { name: "x", format: "4x6" as const, layers: [newLayer("photo")] };
  it("needs a photo placeholder, unique slot numbers and unique layer ids", () => {
    expect(frameInputSchema.safeParse(ok).success).toBe(true);
    expect(frameInputSchema.safeParse({ ...ok, layers: [newLayer("text")] }).success).toBe(false);
    expect(frameInputSchema.safeParse({ ...ok, layers: [newLayer("photo"), newLayer("photo")] }).success).toBe(false);
    const a = newLayer("photo"); expect(frameInputSchema.safeParse({ ...ok, layers: [a, { ...a, slot: 2 }] }).success).toBe(false);
  });
  it("rejects bad asset names, out-of-range geometry and incomplete custom sizes", () => {
    expect(frameInputSchema.safeParse({ ...ok, layers: [newLayer("photo"), newLayer("image", {}, { src: "../x.png" })] }).success).toBe(false);
    expect(frameInputSchema.safeParse({ ...ok, layers: [newLayer("photo", { x: 5 })] }).success).toBe(false);
    expect(frameInputSchema.safeParse({ ...ok, format: "custom" }).success).toBe(false);
    expect(frameInputSchema.safeParse({ ...ok, format: "custom", customWidthIn: 3, customHeightIn: 5 }).success).toBe(true);
    expect(frameInputSchema.safeParse({ ...ok, layers: Array.from({ length: 61 }, () => newLayer("shape")).concat(newLayer("photo")) }).success).toBe(false);
  });
});
