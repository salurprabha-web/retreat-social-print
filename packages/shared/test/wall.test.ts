import { describe, it, expect } from "vitest";
import { DEFAULT_WALL_STYLE, nextSlide, resolveWallStyle, wallSettingsSchema, wallStyleSchema } from "../src";

describe("wall style", () => {
  it("defaults are valid, and a partial or broken style is repaired instead of crashing the display", () => {
    expect(wallStyleSchema.safeParse(DEFAULT_WALL_STYLE).success).toBe(true);
    expect(resolveWallStyle(undefined)).toEqual(DEFAULT_WALL_STYLE);
    expect(resolveWallStyle({ accentColor: "#112233" }).accentColor).toBe("#112233");
    expect(resolveWallStyle({ background: { color: "#000000" } }).background.angle).toBe(DEFAULT_WALL_STYLE.background.angle);
    expect(resolveWallStyle({ accentColor: "red" })).toEqual(DEFAULT_WALL_STYLE);
  });
  it("validates ranges", () => {
    const base = { enabled: true, moderationRequired: true, displaySeconds: 6, mode: "grid", style: DEFAULT_WALL_STYLE };
    expect(wallSettingsSchema.safeParse(base).success).toBe(true);
    expect(wallSettingsSchema.safeParse({ ...base, displaySeconds: 1 }).success).toBe(false);
    expect(wallSettingsSchema.safeParse({ ...base, mode: "carousel" }).success).toBe(false);
    expect(wallSettingsSchema.safeParse({ ...base, style: { ...DEFAULT_WALL_STYLE, gridColumns: 12 } }).success).toBe(false);
  });
});

describe("nextSlide", () => {
  const ids = ["new", "mid", "old"];
  it("shows the newest unseen picture first, whatever is on screen", () => {
    expect(nextSlide(ids, "old", new Set(["mid", "old"]))).toBe("new");
    expect(nextSlide(ids, "mid", new Set())).toBe("new");
  });
  it("then cycles newest to oldest and wraps", () => {
    const seen = new Set(ids);
    expect(nextSlide(ids, "new", seen)).toBe("mid"); expect(nextSlide(ids, "old", seen)).toBe("new");
  });
  it("restarts at the newest when the current picture was removed, and copes with empty and single lists", () => {
    expect(nextSlide(ids, "gone", new Set(ids))).toBe("new");
    expect(nextSlide([], null, new Set())).toBeNull();
    expect(nextSlide(["only"], "only", new Set(["only"]))).toBe("only");
  });
  it("random mode avoids repeating the current picture", () => {
    const seen = new Set(ids);
    for (let i = 0; i < 50; i++) expect(nextSlide(ids, "mid", seen, Math.random, "random")).not.toBe("mid");
    expect(nextSlide(ids, "mid", seen, () => 0, "random")).toBe("new");
  });
});
