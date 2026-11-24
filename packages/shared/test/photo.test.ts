import { describe, it, expect } from "vitest";
import { coverLayout, offsetsFor, NO_ADJUST } from "../src/photo";

const A = 1.5; // 2:3 portrait box
describe("coverLayout", () => {
  it("always covers the box, for any photo shape, rotation and zoom", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [1000, 1000], [6000, 1000]])
      for (const rotate of [0, 90, 180, 270] as const)
        for (const zoom of [1, 2.5, 5]) for (const o of [-1, 0, 1]) {
          const l = coverLayout(w, h, { rotate, zoom, offsetX: o, offsetY: o }, A);
          expect(l.left).toBeLessThanOrEqual(1e-9); expect(l.left + l.drawW).toBeGreaterThanOrEqual(1 - 1e-9);
          expect(l.top).toBeLessThanOrEqual(1e-9); expect(l.top + l.drawH).toBeGreaterThanOrEqual(A - 1e-9);
        }
  });
  it("offset extremes put the image edge on the box edge", () => {
    const l = coverLayout(4000, 3000, { ...NO_ADJUST, offsetX: -1 }, A); expect(l.left).toBeCloseTo(0);
    const r = coverLayout(4000, 3000, { ...NO_ADJUST, offsetX: 1 }, A); expect(r.left + r.drawW).toBeCloseTo(1);
    const c = coverLayout(4000, 3000, NO_ADJUST, A); expect(c.left + c.drawW / 2).toBeCloseTo(0.5);
  });
  it("a 90 degree turn swaps the photo's width and height", () => {
    const a = coverLayout(4000, 3000, NO_ADJUST, A), b = coverLayout(3000, 4000, { ...NO_ADJUST, rotate: 90 }, A);
    expect(a.drawW).toBeCloseTo(b.drawW); expect(a.drawH).toBeCloseTo(b.drawH);
  });
  it("offsetsFor inverts coverLayout", () => {
    const adj = { rotate: 0 as const, zoom: 2, offsetX: 0.4, offsetY: -0.7 };
    const l = coverLayout(4000, 3000, adj, A);
    const o = offsetsFor(l, l.left, l.top);
    expect(o.offsetX).toBeCloseTo(0.4); expect(o.offsetY).toBeCloseTo(-0.7);
  });
});
