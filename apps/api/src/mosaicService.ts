import sharp, { type OverlayOptions } from "sharp";
import { createHash } from "node:crypto";
import {
  assignTiles, cellRect, decodeColors, encodeColors, gridFor, mosaicOutputSize, resolveMosaicSettings,
  type MosaicSettings, type Rgb,
} from "@rsp/shared";
import type { Pool } from "./db";
import { withTx } from "./db";
import { deleteFile, getFile, listFiles, writeStable } from "./storage";
import { ELIGIBLE } from "./routes/wall";

const TILE_THUMB = 320;           // cached square thumbnail of each picture; rendering never re-reads the big final image
const BATCH = 150;                // pictures placed per sync call, so one request never works for long
const MAX_MASTER_PIXELS = 100_000_000;

export const mosaicTileKey = (eventId: string, cid: string) => `events/${eventId}/mosaic/tiles/${cid}.jpg`;
const renderDir = (eventId: string) => `events/${eventId}/mosaic/render`;

export interface Project {
  id: string; event_id: string; master_storage_key: string | null; master_width: number | null; master_height: number | null;
  cols: number | null; rows: number | null; cell_colors: string | null; grid_version: number; mosaic_token: string; settings: unknown; updated_at: Date;
  enabled: boolean; branding: any; tile_count: number;
}

export async function ensureProject(pool: Pool, eventId: string): Promise<Project> {
  await pool.query("INSERT INTO mosaic_projects(event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING", [eventId]);
  return (await loadProject(pool, eventId))!;
}
export async function loadProject(pool: Pool, eventId: string): Promise<Project | null> {
  return (await pool.query(
    `SELECT p.*, s.mosaic_enabled AS enabled, s.branding FROM mosaic_projects p JOIN event_settings s ON s.event_id=p.event_id WHERE p.event_id=$1`, [eventId])).rows[0] ?? null;
}

/** Average colour of every cell of the master, for a grid chosen from its shape. */
export async function analyseMaster(master: Buffer, tileTarget: number) {
  const meta = await sharp(master, { limitInputPixels: MAX_MASTER_PIXELS }).rotate().metadata();
  // metadata() ignores rotation: swap for EXIF orientations 5-8 so the grid matches what is actually drawn
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height! : meta.width!, height = swap ? meta.width! : meta.height!;
  const { cols, rows } = gridFor(width, height, tileTarget);
  const { data } = await sharp(master, { limitInputPixels: MAX_MASTER_PIXELS }).rotate().removeAlpha().resize(cols, rows, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const colors: Rgb[] = [];
  for (let i = 0; i < cols * rows; i++) colors.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
  return { width, height, cols, rows, colors: encodeColors(colors) };
}

/** New master or new tile target: the grid changes, so every picture is placed again. */
export async function setGrid(pool: Pool, eventId: string, master: Buffer, tileTarget: number, masterKey?: string, extra: { width?: number; height?: number } = {}) {
  const g = await analyseMaster(master, tileTarget);
  await withTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mosaic:${eventId}`]);
    await tx.query(
      `UPDATE mosaic_projects SET master_storage_key=COALESCE($2,master_storage_key), master_width=$3, master_height=$4, cols=$5, rows=$6, cell_colors=$7,
              tile_count=$8, grid_version=grid_version+1, status='ready', updated_at=now() WHERE event_id=$1`,
      [eventId, masterKey ?? null, extra.width ?? g.width, extra.height ?? g.height, g.cols, g.rows, g.colors, tileTarget]);
    await tx.query("DELETE FROM mosaic_tiles WHERE event_id=$1", [eventId]);
  });
  return g;
}

export async function clearTiles(pool: Pool, eventId: string) {
  await withTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mosaic:${eventId}`]);
    await tx.query("DELETE FROM mosaic_tiles WHERE event_id=$1", [eventId]);
    await tx.query("UPDATE mosaic_projects SET updated_at=now() WHERE event_id=$1", [eventId]);
  });
}

export interface SyncResult { cells: number; filled: number; eligible: number; left: number }

/**
 * Brings the tiles in line with the pictures that are allowed on the mosaic RIGHT NOW: tiles of pictures that became ineligible
 * (deleted, rejected, hidden, opted out, moderation switched on) are freed, and new pictures take the closest free cell.
 * Serialised per event, so two displays asking at once cannot place one picture twice.
 */
export async function syncMosaic(pool: Pool, eventId: string): Promise<SyncResult> {
  const p0 = await loadProject(pool, eventId);
  if (!p0?.master_storage_key || !p0.cols || !p0.rows) return { cells: 0, filled: 0, eligible: 0, left: 0 };
  const settings = resolveMosaicSettings(p0.settings);
  return withTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mosaic:${eventId}`]);
    const pr = (await tx.query("SELECT id,cols,rows,cell_colors FROM mosaic_projects WHERE event_id=$1", [eventId])).rows[0];
    const cells = decodeColors(pr.cell_colors); const total = pr.cols * pr.rows;
    const eligible = (await tx.query(
      `SELECT c.id, c.storage_key FROM final_compositions c JOIN guest_sessions s ON s.id=c.session_id
        WHERE ${ELIGIBLE("$2")} ORDER BY COALESCE(c.finalized_at,c.created_at), c.id`, [eventId, settings.moderationRequired])).rows as { id: string; storage_key: string }[];
    await tx.query("DELETE FROM mosaic_tiles WHERE mosaic_id=$1 AND NOT (composition_id = ANY($2::uuid[]))", [pr.id, eligible.map((r) => r.id)]);
    const tiles = (await tx.query("SELECT composition_id, cell FROM mosaic_tiles WHERE mosaic_id=$1", [pr.id])).rows;
    const tiled = new Set<string>(tiles.map((t) => t.composition_id)); const taken = new Set<number>(tiles.map((t) => t.cell as number));
    let filled = tiles.length;

    const waiting = eligible.filter((r) => !tiled.has(r.id));
    const batch = taken.size < total ? waiting.slice(0, BATCH) : [];
    const prepared: { id: string; color: Rgb; thumb: Buffer }[] = [];
    for (const r of batch) {
      try {
        const thumb = await sharp(await getFile(r.storage_key)).rotate().resize(TILE_THUMB, TILE_THUMB, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 85 }).toBuffer();
        const px = await sharp(thumb).removeAlpha().resize(1, 1, { fit: "fill" }).raw().toBuffer();
        prepared.push({ id: r.id, color: [px[0], px[1], px[2]], thumb });
      } catch { /* an unreadable file is skipped, it must not block the others */ }
    }
    const spots = assignTiles(cells, taken, prepared.map((x) => x.color));
    let placed = 0;
    for (let i = 0; i < prepared.length; i++) {
      if (spots[i] < 0) break;                                                  // mosaic is full
      await writeStable(mosaicTileKey(eventId, prepared[i].id), prepared[i].thumb);
      await tx.query("INSERT INTO mosaic_tiles(composition_id,event_id,mosaic_id,cell,color) VALUES ($1,$2,$3,$4,$5)",
        [prepared[i].id, eventId, pr.id, spots[i], encodeColors([prepared[i].color])]);
      placed++;
    }
    filled += placed;
    const left = filled < total ? Math.max(0, waiting.length - batch.length) : 0;
    return { cells: total, filled, eligible: eligible.length, left };
  });
}

/** Identifies exactly what a render would show, so a cached file is reused only while nothing visible changed. */
export async function currentVersion(pool: Pool, p: Project) {
  const s = resolveMosaicSettings(p.settings);
  const tiles = (await pool.query("SELECT cell, composition_id FROM mosaic_tiles WHERE mosaic_id=$1 ORDER BY cell", [p.id])).rows;
  const logoKey = p.branding?.eventLogo ?? null;
  const version = createHash("sha1").update(JSON.stringify([p.master_storage_key, p.cols, p.rows, p.grid_version, s.tintPct, s.empty, s.logo, logoKey, tiles])).digest("hex").slice(0, 16);
  return { version, tiles: tiles.map((t) => ({ cell: t.cell as number, id: t.composition_id as string })), logoKey, settings: s };
}

async function draw(opts: {
  master: Buffer; cols: number; rows: number; width: number; masterW: number; masterH: number; colors: Rgb[];
  tiles: { cell: number; thumb: Buffer }[]; s: MosaicSettings; logo: Buffer | null;
}): Promise<Buffer> {
  const { width: W, height: H } = mosaicOutputSize(opts.masterW, opts.masterH, opts.width);
  let base = sharp(opts.master, { limitInputPixels: MAX_MASTER_PIXELS }).rotate().removeAlpha().resize(W, H, { fit: "fill" });
  if (opts.s.empty === "dim") base = base.modulate({ brightness: 0.45, saturation: 0.85 });
  const baseRaw = await base.raw().toBuffer();                                   // dimming is finished before anything is drawn on top

  const ops: OverlayOptions[] = [];
  for (const t of opts.tiles) {
    const r = cellRect(t.cell, opts.cols, opts.rows, W, H);
    ops.push({ input: await sharp(t.thumb).resize(r.w, r.h, { fit: "cover" }).toBuffer(), left: r.x, top: r.y });
  }
  if (opts.s.tintPct > 0 && opts.tiles.length) {
    // Pull each picture toward its cell's colour so the master stays recognisable from a distance.
    const rects = opts.tiles.map((t) => {
      const r = cellRect(t.cell, opts.cols, opts.rows, W, H); const c = opts.colors[t.cell] ?? [128, 128, 128];
      return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="rgb(${c[0]},${c[1]},${c[2]})"/>`;
    }).join("");
    ops.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges"><g fill-opacity="${opts.s.tintPct / 100}">${rects}</g></svg>`), left: 0, top: 0 });
  }
  if (opts.logo && opts.s.logo.position !== "none") {
    const bw = Math.max(8, Math.round((W * opts.s.logo.sizePct) / 100)); const bh = Math.max(8, Math.min(Math.round(bw * 0.6), Math.round(H * 0.4)));
    let img = await sharp(opts.logo, { density: 300 }).rotate().resize(bw, bh, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    let w = bw, h = bh;
    if (opts.s.logo.plate) {
      const pad = Math.round(bw * 0.06); w = bw + pad * 2; h = bh + pad * 2;
      img = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.88 } } }).composite([{ input: img, left: pad, top: pad }]).png().toBuffer();
    }
    const m = Math.round(W * 0.03); const pos = opts.s.logo.position;
    const left = pos === "center" ? Math.round((W - w) / 2) : pos.endsWith("left") ? m : W - w - m;
    const top = pos === "center" ? Math.round((H - h) / 2) : pos.startsWith("top") ? m : H - h - m;
    ops.push({ input: img, left: Math.max(0, left), top: Math.max(0, top) });
  }
  return sharp(baseRaw, { raw: { width: W, height: H, channels: 3 } }).composite(ops).jpeg({ quality: 88 }).toBuffer();
}

const inflight = new Map<string, Promise<Buffer>>();

/** The current mosaic as a JPEG `width` pixels wide. Cached per picture-set; concurrent requests share one render. */
export async function renderCurrent(pool: Pool, eventId: string, width: number): Promise<{ buffer: Buffer; version: string; width: number; height: number } | null> {
  const p = await loadProject(pool, eventId);
  if (!p?.master_storage_key || !p.cols || !p.rows || !p.master_width || !p.master_height) return null;
  const v = await currentVersion(pool, p);
  const size = mosaicOutputSize(p.master_width, p.master_height, width);
  const key = `${renderDir(eventId)}/${v.version}-${size.width}.jpg`;
  try { return { buffer: await getFile(key), version: v.version, ...size }; } catch { /* not rendered yet */ }
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      const colors = decodeColors(p.cell_colors);
      const tiles: { cell: number; thumb: Buffer }[] = [];
      for (const t of v.tiles) { try { tiles.push({ cell: t.cell, thumb: await getFile(mosaicTileKey(eventId, t.id)) }); } catch { /* missing thumbnail: that cell stays empty */ } }
      let logo: Buffer | null = null;
      if (v.logoKey) { try { logo = await getFile(v.logoKey); } catch { logo = null; } }
      const out = await draw({ master: await getFile(p.master_storage_key!), cols: p.cols!, rows: p.rows!, width, masterW: p.master_width!, masterH: p.master_height!, colors, tiles, s: v.settings, logo });
      await writeStable(key, out);
      for (const f of await listFiles(renderDir(eventId))) if (!f.startsWith(`${v.version}-`)) await deleteFile(`${renderDir(eventId)}/${f}`).catch(() => {});   // old versions are never needed again
      return out;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return { buffer: await job, version: v.version, ...size };
}
