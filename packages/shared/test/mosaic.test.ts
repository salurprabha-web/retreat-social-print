import { describe, it, expect } from "vitest";
import { DEFAULT_MOSAIC, MOSAIC_MAX_CELLS, assignTiles, cellRect, colorDistance, decodeColors, encodeColors, gridFor, mosaicOutputSize, mosaicPercent, mosaicSettingsSchema, resolveMosaicSettings, type Rgb } from "../src";

describe("grid", () => {
  it("follows the master's shape with about the wanted number of cells", () => {
    const g = gridFor(3000, 2000, 1000);
    expect(Math.abs(g.cols * g.rows - 1000)).toBeLessThan(60);
    expect(g.cols / g.rows).toBeGreaterThan(1.3); expect(g.cols / g.rows).toBeLessThan(1.7);
    const sq = gridFor(1000, 1000, 100); expect(sq).toEqual({ cols: 10, rows: 10 });
    const tall = gridFor(1000, 4000, 100); expect(tall.rows).toBeGreaterThan(tall.cols * 3);
  });
  it("never returns an empty or oversized grid", () => {
    expect(gridFor(1, 10000, 25).cols).toBeGreaterThanOrEqual(1);
    const huge = gridFor(4000, 1000, 5000); expect(huge.cols * huge.rows).toBeLessThanOrEqual(MOSAIC_MAX_CELLS);
  });
  it("cell rectangles tile the image exactly", () => {
    const cols = 7, rows = 5, W = 1003, H = 611; let area = 0;
    for (let i = 0; i < cols * rows; i++) { const r = cellRect(i, cols, rows, W, H); area += r.w * r.h; expect(r.w).toBeGreaterThan(0); }
    expect(area).toBe(W * H);
    expect(cellRect(cols * rows - 1, cols, rows, W, H)).toMatchObject({ x: Math.round((6 * W) / 7), y: Math.round((4 * H) / 5) });
  });
  it("output size keeps the shape and respects the pixel budget", () => {
    expect(mosaicOutputSize(3000, 2000, 4800)).toEqual({ width: 4800, height: 3200 });
    const big = mosaicOutputSize(3000, 2000, 10000, 20_000_000);
    expect(big.width * big.height).toBeLessThanOrEqual(20_000_000); expect(Math.abs(big.height / big.width - 2 / 3)).toBeLessThan(0.01);
  });
});

describe("tile assignment", () => {
  const red: Rgb = [220, 30, 30], blue: Rgb = [30, 30, 220], green: Rgb = [30, 200, 30];
  const cells: Rgb[] = [blue, red, green, red];
  it("distance is zero for equal colours and larger for different ones", () => {
    expect(colorDistance(red, red)).toBe(0); expect(colorDistance(red, blue)).toBeGreaterThan(colorDistance(red, [200, 40, 40]));
  });
  it("each photo takes the closest free cell, lowest index on a tie, and cells are never shared", () => {
    const three = assignTiles(cells, new Set(), [red, red, red]);
    expect(three.slice(0, 2)).toEqual([1, 3]);                      // both red cells, lowest first
    expect([0, 2]).toContain(three[2]);                              // third red takes the best of what is left
    expect(new Set(three).size).toBe(3);
    expect(assignTiles(cells, new Set(), [blue])).toEqual([0]);
    expect(assignTiles(cells, new Set([1]), [red])).toEqual([3]);
  });
  it("returns -1 when the mosaic is full, and does not change the taken set", () => {
    const taken = new Set([0, 1, 2]);
    expect(assignTiles(cells, taken, [red, red])).toEqual([3, -1]);
    expect([...taken]).toEqual([0, 1, 2]);
    expect(assignTiles([], new Set(), [red])).toEqual([-1]);
  });
  it("is deterministic", () => {
    const ps: Rgb[] = [red, blue, green, red, blue];
    expect(assignTiles(cells, new Set(), ps)).toEqual(assignTiles(cells, new Set(), ps));
  });
});

describe("colours and settings", () => {
  it("round-trips colours through the compact text form", () => {
    const cs: Rgb[] = [[0, 0, 0], [255, 128, 7], [18, 52, 86]];
    expect(decodeColors(encodeColors(cs))).toEqual(cs);
    expect(decodeColors(null)).toEqual([]); expect(decodeColors("12345")).toEqual([]);
  });
  it("percent is whole, capped, and safe for an empty grid", () => {
    expect(mosaicPercent(0, 0)).toBe(0); expect(mosaicPercent(1, 3)).toBe(33); expect(mosaicPercent(5, 3)).toBe(100);
  });
  it("validates ranges and repairs partial settings", () => {
    expect(mosaicSettingsSchema.safeParse(DEFAULT_MOSAIC).success).toBe(true);
    expect(mosaicSettingsSchema.safeParse({ ...DEFAULT_MOSAIC, tileTarget: 5 }).success).toBe(false);
    expect(mosaicSettingsSchema.safeParse({ ...DEFAULT_MOSAIC, tintPct: 90 }).success).toBe(false);
    expect(mosaicSettingsSchema.safeParse({ ...DEFAULT_MOSAIC, logo: { position: "middle", sizePct: 10, plate: true } }).success).toBe(false);
    expect(resolveMosaicSettings(undefined)).toEqual(DEFAULT_MOSAIC);
    expect(resolveMosaicSettings({ tintPct: 10, logo: { position: "center" } }).logo).toEqual({ position: "center", sizePct: 14, plate: true });
    expect(resolveMosaicSettings({ tintPct: 999 })).toEqual(DEFAULT_MOSAIC);
  });
});
