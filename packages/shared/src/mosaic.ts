import { z } from "zod";

/** Photo mosaic: a master image is cut into a grid; each finished guest picture takes the free cell whose colour fits it best. */
export type Rgb = readonly [number, number, number];

export const MOSAIC_LOGO_POSITIONS = ["none", "center", "top-left", "top-right", "bottom-left", "bottom-right"] as const;
export const MOSAIC_PREVIEW_WIDTHS = [800, 1600, 2400] as const;
export const MOSAIC_MAX_PIXELS = 50_000_000;
export const MOSAIC_MAX_CELLS = 6000;

export const mosaicSettingsSchema = z.object({
  enabled: z.boolean(),
  tileTarget: z.number().int().min(25).max(5000),             // wanted number of tiles; the real grid follows the master's shape
  outputWidth: z.number().int().min(1600).max(10000),         // width in pixels of the downloadable file
  moderationRequired: z.boolean(),
  tintPct: z.number().int().min(0).max(70),                   // how strongly a tile is pulled toward its cell's colour
  empty: z.enum(["dim", "master"]),                           // how cells that have no picture yet look
  logo: z.object({ position: z.enum(MOSAIC_LOGO_POSITIONS), sizePct: z.number().int().min(5).max(40), plate: z.boolean() }),
  title: z.string().trim().max(100),
  showProgress: z.boolean(),
});
export type MosaicSettings = z.infer<typeof mosaicSettingsSchema>;

export const DEFAULT_MOSAIC: MosaicSettings = {
  enabled: false, tileTarget: 1000, outputWidth: 4800, moderationRequired: true, tintPct: 30, empty: "dim",
  logo: { position: "none", sizePct: 14, plate: true }, title: "Our community mosaic", showProgress: true,
};

/** Grid whose cells are close to square for a master of this shape, with about `target` cells. */
export function gridFor(masterW: number, masterH: number, target: number): { cols: number; rows: number } {
  const aspect = masterW / Math.max(1, masterH);
  let cols = Math.max(1, Math.round(Math.sqrt(target * aspect)));
  let rows = Math.max(1, Math.round(target / cols));
  while (cols * rows > MOSAIC_MAX_CELLS) { if (cols >= rows) cols--; else rows--; }
  return { cols, rows };
}

/** Output size that keeps the master's shape and stays inside the pixel budget (so a huge request cannot exhaust memory). */
export function mosaicOutputSize(masterW: number, masterH: number, width: number, maxPixels = MOSAIC_MAX_PIXELS) {
  const ratio = masterH / Math.max(1, masterW);
  let w = Math.max(16, Math.round(width));
  if (w * Math.round(w * ratio) > maxPixels) w = Math.floor(Math.sqrt(maxPixels / ratio));
  return { width: w, height: Math.max(1, Math.round(w * ratio)) };
}

/** Pixel rectangle of one cell. Boundaries are rounded once, so neighbouring cells share edges exactly: no gaps, no overlaps. */
export function cellRect(index: number, cols: number, rows: number, W: number, H: number) {
  const c = index % cols, r = Math.floor(index / cols);
  const x0 = Math.round((c * W) / cols), x1 = Math.round(((c + 1) * W) / cols);
  const y0 = Math.round((r * H) / rows), y1 = Math.round(((r + 1) * H) / rows);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Perceptual-ish colour distance ("redmean"): cheap, and much closer to what the eye sees than plain RGB. */
export function colorDistance(a: Rgb, b: Rgb): number {
  const rm = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

/**
 * Gives each photo (in the order supplied) the free cell with the closest colour. Deterministic: ties go to the lowest cell.
 * `taken` is not modified. Photos that find no free cell get -1.
 */
export function assignTiles(cells: readonly Rgb[], taken: ReadonlySet<number>, photos: readonly Rgb[]): number[] {
  const used = new Set(taken); const out: number[] = [];
  for (const p of photos) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < cells.length; i++) {
      if (used.has(i)) continue;
      const d = colorDistance(p, cells[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) used.add(best);
    out.push(best);
  }
  return out;
}

export const encodeColors = (cs: readonly Rgb[]) => cs.map((c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")).join("");
export function decodeColors(hex: string | null | undefined): Rgb[] {
  const out: Rgb[] = []; const s = hex ?? "";
  for (let i = 0; i + 6 <= s.length; i += 6) out.push([parseInt(s.slice(i, i + 2), 16), parseInt(s.slice(i + 2, i + 4), 16), parseInt(s.slice(i + 4, i + 6), 16)]);
  return out;
}

export const mosaicPercent = (filled: number, cells: number) => (cells > 0 ? Math.min(100, Math.floor((filled / cells) * 100)) : 0);

/** Settings with anything missing filled in, so older rows and partial saves never break the display. */
export function resolveMosaicSettings(raw: unknown): MosaicSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<MosaicSettings>;
  const merged = { ...DEFAULT_MOSAIC, ...r, logo: { ...DEFAULT_MOSAIC.logo, ...(r.logo ?? {}) } };
  const ok = mosaicSettingsSchema.safeParse(merged);
  return ok.success ? ok.data : DEFAULT_MOSAIC;
}
