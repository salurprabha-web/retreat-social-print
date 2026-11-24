import { describe, it, expect } from "vitest";
import { buildCaption, hashtagLine, resolveShare, shareSettingsSchema, whatsappUrl, DEFAULT_LABELS } from "../src";

const E = { name: "Rao Engagement", hashtag: "RaoEngaged", eventDate: "2026-12-05", clientName: "Rao Family" };

describe("caption", () => {
  it("uses the product caption by default", () => {
    expect(buildCaption(null, E)).toBe("Captured a special moment at Rao Engagement!\nThank you for being part of this experience.\n#RaoEngaged #RetreatArcade");
  });
  it("leaves no stray # when the event has no hashtag, and cleans a typed # or spaces", () => {
    expect(buildCaption(null, { ...E, hashtag: null })).toBe("Captured a special moment at Rao Engagement!\nThank you for being part of this experience.\n#RetreatArcade");
    expect(buildCaption("Hi {{event.hashtag}}", { ...E, hashtag: "#Rao Engaged!" })).toBe("Hi RaoEngaged");
  });
  it("supports custom templates, the Instagram handle and sponsor hashtags without duplicating", () => {
    expect(buildCaption("{{event.name}} with {{event.instagram}} #{{event.hashtag}}", E, { instagram: "@retreat.arcade", sponsorHashtags: ["Acme", "RaoEngaged"] }))
      .toBe("Rao Engagement with @retreat.arcade #RaoEngaged #Acme");
    expect(buildCaption("x {{event.instagram}}", E)).toBe("x");
  });
  it("cannot inject markup or tokens through event data", () => {
    const c = buildCaption("{{event.name}}", { ...E, name: "<b>{{event.client}}</b>" });
    expect(c).toBe("<b>{{event.client}}</b>");   // plain text, rendered as text by React and by share sheets
  });
  it("builds the hashtag line and a WhatsApp link", () => {
    expect(hashtagLine(E, ["Acme", "#Beta"])).toBe("#RaoEngaged #Acme #Beta");
    expect(hashtagLine({ ...E, hashtag: null })).toBe("");
    expect(whatsappUrl("a b\n#c")).toBe("https://wa.me/?text=a%20b%0A%23c");
  });
});

describe("share settings", () => {
  it("fills defaults and only lets admins override non-empty labels", () => {
    const r = resolveShare({ labels: { instagram: "Post it!", download: "" }, channels: { whatsapp: false } });
    expect(r.labels.instagram).toBe("Post it!"); expect(r.labels.download).toBe(DEFAULT_LABELS.download);
    expect(r.channels).toMatchObject({ whatsapp: false, instagram: true, download: true });
    expect(resolveShare(null).sponsorHashtags).toEqual([]);
  });
  it("validates sponsor hashtags and lengths", () => {
    const base = { instructions: "", sponsorHashtags: [], labels: {}, channels: {} };
    expect(shareSettingsSchema.safeParse(base).success).toBe(true);
    expect(shareSettingsSchema.safeParse({ ...base, sponsorHashtags: ["bad tag"] }).success).toBe(false);
    expect(shareSettingsSchema.safeParse({ ...base, sponsorHashtags: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    expect(shareSettingsSchema.safeParse({ ...base, instructions: "x".repeat(601) }).success).toBe(false);
  });
});
