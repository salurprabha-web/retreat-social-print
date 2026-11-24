import { describe, it, expect } from "vitest";
import { DEFAULT_PLACEMENT, resolvePlacement, sponsorInputSchema, sponsorTagsFor, layerSchema, frameInputSchema, presetLayers } from "../src";

const ok = { name: "Acme", url: "https://acme.test/x", hashtag: "#AcmeLive", active: true, placement: DEFAULT_PLACEMENT };
describe("sponsor input", () => {
  it("accepts a normal sponsor and nulls", () => {
    expect(sponsorInputSchema.safeParse(ok).success).toBe(true);
    expect(sponsorInputSchema.safeParse({ ...ok, url: null, hashtag: null }).success).toBe(true);
  });
  it("rejects unsafe links, odd hashtags and empty names", () => {
    for (const url of ["http://acme.test", "javascript:alert(1)", "//acme.test", "https://a b"]) expect(sponsorInputSchema.safeParse({ ...ok, url }).success).toBe(false);
    expect(sponsorInputSchema.safeParse({ ...ok, hashtag: "#two words" }).success).toBe(false);
    expect(sponsorInputSchema.safeParse({ ...ok, name: "  " }).success).toBe(false);
  });
  it("repairs placement defaults", () => {
    expect(resolvePlacement(undefined)).toEqual(DEFAULT_PLACEMENT);
    expect(resolvePlacement({ wall: false })).toEqual({ guest: true, wall: false });
    expect(resolvePlacement({ wall: "no" })).toEqual(DEFAULT_PLACEMENT);
  });
});

describe("sponsorTagsFor", () => {
  const sp = [{ id: "a", hashtag: "#AcmeLive" }, { id: "b", hashtag: "Beta" }, { id: "c", hashtag: null }];
  const frames = [{ id: "f1", sponsorId: "a" }, { id: "f2", sponsorId: null }];
  it("a sponsor without frames tags everyone; one with frames only tags its own frames", () => {
    expect(sponsorTagsFor(sp, frames, "f1")).toEqual(["AcmeLive", "Beta"]);
    expect(sponsorTagsFor(sp, frames, "f2")).toEqual(["Beta"]);
    expect(sponsorTagsFor(sp, frames, null)).toEqual(["Beta"]);
  });
  it("de-duplicates ignoring case", () => {
    expect(sponsorTagsFor([{ id: "x", hashtag: "Same" }, { id: "y", hashtag: "#same" }], [], null)).toEqual(["Same"]);
  });
});

describe("frames and sponsors", () => {
  it("a logo layer may point at the frame's sponsor", () => {
    const l = presetLayers("single", 1200, 1800);
    expect(layerSchema.safeParse({ ...l[0], type: "logo", which: "sponsor" }).success).toBe(true);
    expect(layerSchema.safeParse({ ...l[0], type: "logo", which: "nobody" }).success).toBe(false);
  });
  it("frame input takes an optional sponsor id", () => {
    const base = { name: "F", format: "4x6", orientation: "portrait", layers: presetLayers("single", 1200, 1800) };
    expect(frameInputSchema.safeParse({ ...base, sponsorId: null }).success).toBe(true);
    expect(frameInputSchema.safeParse({ ...base, sponsorId: "not-a-uuid" }).success).toBe(false);
    expect(frameInputSchema.safeParse(base).success).toBe(true);
  });
});
