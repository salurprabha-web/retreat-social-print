import { z } from "zod";
import { cleanTag } from "./share";

export const MAX_SPONSORS_PER_EVENT = 20;
const https = z.string().trim().max(500).refine((u) => /^https:\/\/[^\s]+$/.test(u), "must start with https://");

/** Where a sponsor's logo appears. Printed logos are placed by adding a "Sponsor logo" layer to a frame of that sponsor. */
export const sponsorPlacementSchema = z.object({ guest: z.boolean(), wall: z.boolean() });
export type SponsorPlacement = z.infer<typeof sponsorPlacementSchema>;
export const DEFAULT_PLACEMENT: SponsorPlacement = { guest: true, wall: true };
export const resolvePlacement = (raw: unknown): SponsorPlacement => {
  const r = sponsorPlacementSchema.partial().safeParse(raw && typeof raw === "object" ? raw : {});
  return { ...DEFAULT_PLACEMENT, ...(r.success ? r.data : {}) };
};

export const sponsorInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: https.nullable(),
  hashtag: z.string().trim().max(41).regex(/^#?[A-Za-z0-9_]*$/, "letters, numbers and underscore only").nullable(),
  active: z.boolean(),
  placement: sponsorPlacementSchema,
});
export type SponsorInput = z.infer<typeof sponsorInputSchema>;

export interface SponsorLite { id: string; hashtag: string | null }

/**
 * Sponsor hashtags added to a guest's caption. A sponsor with frames of its own only tags pictures made in those frames;
 * a sponsor with no frames tags every picture of the event. `sponsors` must already be limited to active ones.
 */
export function sponsorTagsFor(sponsors: readonly SponsorLite[], frames: readonly { id: string; sponsorId: string | null }[], frameId: string | null): string[] {
  const out: string[] = [];
  for (const s of sponsors) {
    const t = cleanTag(s.hashtag); if (!t) continue;
    const own = frames.filter((f) => f.sponsorId === s.id);
    const applies = own.length === 0 || (frameId !== null && own.some((f) => f.id === frameId));
    if (applies && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
