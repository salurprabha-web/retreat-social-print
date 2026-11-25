/**
 * Measures the peak memory and time of the picture engine (compose) on realistic and worst-case jobs, one fresh process per job.
 *   pnpm --filter @rsp/api exec tsx scripts/compose-mem.ts
 * Used to size the serverless function (Vercel memory setting); numbers depend on the machine, so run it on the target when it matters.
 * Each photo is a real JPEG of noisy content at the stated size (noise keeps decode cost realistic; a flat colour would understate it).
 */
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { presetLayers, DPI } from "@rsp/shared";
import { composeFrame } from "../src/compose";

const SCENARIOS: { name: string; wIn: number; hIn: number; preset: "single" | "trio" | "quad" | "polaroid"; photos: [number, number][] }[] = [
  { name: "4x6, 1 photo 12 MP (typical phone)", wIn: 4, hIn: 6, preset: "single", photos: [[4000, 3000]] },
  { name: "4x6, 3 photos 12 MP", wIn: 4, hIn: 6, preset: "trio", photos: [[4000, 3000], [4000, 3000], [4000, 3000]] },
  { name: "6x8, 1 photo 24 MP", wIn: 6, hIn: 8, preset: "single", photos: [[6000, 4000]] },
  { name: "6x8, 4 photos 12 MP", wIn: 6, hIn: 8, preset: "quad", photos: Array(4).fill([4000, 3000]) },
  { name: "A5, 3 photos 24 MP", wIn: 148 / 25.4, hIn: 210 / 25.4, preset: "trio", photos: Array(3).fill([6000, 4000]) },
  { name: "12x12 custom (largest), 1 photo 48 MP", wIn: 12, hIn: 12, preset: "single", photos: [[8000, 6000]] },
];

async function noisyJpeg(w: number, h: number) {
  // cheap noise: a small random tile scaled up, then a fine pattern added by sharp's own noise generator at reduced size
  const base = await sharp({ create: { width: Math.round(w / 8), height: Math.round(h / 8), channels: 3, noise: { type: "gaussian", mean: 128, sigma: 50 } } } as any).resize(w, h, { kernel: "nearest" }).jpeg({ quality: 88 }).toBuffer();
  return base;
}

async function runOne(i: number) {
  const s = SCENARIOS[i];
  const widthPx = Math.round(s.wIn * DPI), heightPx = Math.round(s.hIn * DPI);
  const layers = presetLayers(s.preset, widthPx, heightPx);
  const photos = new Map<number, any>();
  for (let k = 0; k < s.photos.length; k++) {
    const [w, h] = s.photos[k]; photos.set(k + 1, { data: await noisyJpeg(w, h), width: w, height: h, adjust: { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 } });
  }
  if (global.gc) global.gc();
  const baseline = process.memoryUsage().rss; let peak = baseline;
  const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const t0 = Date.now();
  const out = await composeFrame({ widthPx, heightPx, layers, event: { name: "Mem test", hashtag: "mem", date: null } as any, photos, asset: async () => null, logo: async () => null });
  const ms = Date.now() - t0; clearInterval(t); peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({ name: s.name, output: `${out.width}x${out.height}`, outputMB: +(out.buffer.length / 1048576).toFixed(2), ms, baselineMB: Math.round(baseline / 1048576), peakMB: Math.round(peak / 1048576), addedMB: Math.round((peak - baseline) / 1048576) }));
}

const arg = process.argv[2];
if (arg === undefined) {
  console.log(`node ${process.version}, ${process.platform}/${process.arch}, cpus=${(await import("node:os")).cpus().length}`);
  for (let i = 0; i < SCENARIOS.length; i++) {
    const r = execFileSync(process.execPath, ["--import", "tsx", "--expose-gc", new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), String(i)], { encoding: "utf8", timeout: 300000 });
    const j = JSON.parse(r.trim().split("\n").pop()!);
    console.log(`${j.name.padEnd(42)} ${String(j.ms).padStart(6)} ms   peak ${String(j.peakMB).padStart(5)} MB (+${String(j.addedMB).padStart(4)} over start)   output ${j.output}, ${j.outputMB} MB`);
  }
} else await runOne(Number(arg));
