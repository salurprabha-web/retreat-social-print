import { z } from "zod";
import { FONTS } from "./page";

export const WALL_MODES = ["slideshow", "grid", "latest", "random"] as const;
export type WallMode = (typeof WALL_MODES)[number];
export const WALL_TRANSITIONS = ["fade", "slide", "zoom", "flip"] as const;
export const WALL_MODE_LABEL: Record<WallMode, string> = { slideshow: "Slideshow", grid: "Grid gallery", latest: "Latest + recent", random: "Random rotation" };
export const WALL_IMAGE_SIZES = [800, 1600, 2400] as const;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const wallStyleSchema = z.object({
  background: z.object({ type: z.enum(["color", "gradient"]), color, from: color, to: color, angle: z.number().int().min(0).max(360) }),
  textColor: color, accentColor: color, fontFamily: z.enum(FONTS),
  transition: z.enum(WALL_TRANSITIONS), fit: z.enum(["contain", "cover"]),
  gridColumns: z.number().int().min(2).max(8),
  showHeader: z.boolean(), showEventName: z.boolean(), showHashtag: z.boolean(), showEventLogo: z.boolean(), showClientLogo: z.boolean(), showJoinQr: z.boolean(),
  headline: z.string().trim().max(100),
  highlightSeconds: z.number().int().min(0).max(30),          // a brand-new picture is announced for this long (0 = no announcement)
});
export type WallStyle = z.infer<typeof wallStyleSchema>;

export const wallSettingsSchema = z.object({
  enabled: z.boolean(),
  moderationRequired: z.boolean(),
  displaySeconds: z.number().int().min(2).max(60),
  mode: z.enum(WALL_MODES),
  style: wallStyleSchema,
});
export type WallSettings = z.infer<typeof wallSettingsSchema>;

export const DEFAULT_WALL_STYLE: WallStyle = {
  background: { type: "gradient", color: "#0f1c2e", from: "#0b1220", to: "#1d3557", angle: 160 },
  textColor: "#f8fafc", accentColor: "#f5b942", fontFamily: "sans", transition: "fade", fit: "contain", gridColumns: 4,
  showHeader: true, showEventName: true, showHashtag: true, showEventLogo: true, showClientLogo: false, showJoinQr: true,
  headline: "Take your photo. See it here.", highlightSeconds: 8,
};

/** Fills anything missing (older events, partial saves) so the display never crashes on an incomplete style. */
export function resolveWallStyle(raw: unknown): WallStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<WallStyle>;
  const merged = { ...DEFAULT_WALL_STYLE, ...r, background: { ...DEFAULT_WALL_STYLE.background, ...(r.background ?? {}) } };
  const ok = wallStyleSchema.safeParse(merged);
  return ok.success ? ok.data : DEFAULT_WALL_STYLE;
}

/**
 * Which picture shows next on a slideshow: the newest one nobody has seen yet, else carry on through the rest, newest to oldest.
 * Pure so the same rule is tested here and used by the display.
 */
export function nextSlide(ids: readonly string[], currentId: string | null, seen: ReadonlySet<string>, rand: () => number = Math.random, mode: "sequential" | "random" = "sequential"): string | null {
  if (!ids.length) return null;
  const unseen = ids.find((id) => !seen.has(id));                       // ids are newest first
  if (unseen) return unseen;
  if (mode === "random") {
    const pool = ids.length > 1 ? ids.filter((i) => i !== currentId) : ids;
    return pool[Math.floor(rand() * pool.length)];
  }
  const at = currentId ? ids.indexOf(currentId) : -1;
  return ids[(at + 1) % ids.length];                                   // wraps around; a removed current picture simply restarts at the newest
}
