import { z } from "zod";
import type { EventInfo } from "./page";

/** What a guest can tap on the share screen. A tap is only ever an ATTEMPT; the platform never claims a post was published. */
export const SHARE_CHANNELS = ["instagram", "whatsapp", "native", "download", "copy_caption", "copy_hashtag"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

const tag = z.string().regex(/^[A-Za-z0-9_]{1,40}$/, "letters, numbers and underscore only");
const label = z.string().trim().max(40);

export const shareSettingsSchema = z.object({
  instructions: z.string().trim().max(600),
  sponsorHashtags: z.array(tag).max(5),
  labels: z.object({ instagram: label, download: label, copyCaption: label, copyHashtag: label, whatsapp: label, native: label }).partial(),
  channels: z.object({ instagram: z.boolean(), download: z.boolean(), copyCaption: z.boolean(), copyHashtag: z.boolean(), whatsapp: z.boolean(), native: z.boolean() }).partial(),
});
export type ShareSettings = z.infer<typeof shareSettingsSchema>;

export const DEFAULT_LABELS = {
  instagram: "Share on Instagram", download: "Download photo", copyCaption: "Copy caption", copyHashtag: "Copy hashtag", whatsapp: "Share on WhatsApp", native: "Share…",
};
export const DEFAULT_CAPTION = "Captured a special moment at {{event.name}}!\nThank you for being part of this experience.\n#{{event.hashtag}} #RetreatArcade";

/** Settings with every default filled in (what the guest screen actually uses). */
export function resolveShare(s: Partial<ShareSettings> | null | undefined) {
  const c = s?.channels ?? {};
  return {
    instructions: s?.instructions ?? "",
    sponsorHashtags: s?.sponsorHashtags ?? [],
    labels: { ...DEFAULT_LABELS, ...Object.fromEntries(Object.entries(s?.labels ?? {}).filter(([, v]) => v)) } as typeof DEFAULT_LABELS,
    channels: { instagram: c.instagram ?? true, download: c.download ?? true, copyCaption: c.copyCaption ?? true, copyHashtag: c.copyHashtag ?? true, whatsapp: c.whatsapp ?? true, native: c.native ?? true },
  };
}

export const cleanTag = (t: string | null | undefined) => (t ?? "").replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "");

/** Caption for the post. Tokens: {{event.name}} {{event.hashtag}} {{event.date}} {{event.client}} {{event.instagram}}. Empty tokens leave no stray "#". */
export function buildCaption(template: string | null | undefined, e: EventInfo, o: { instagram?: string | null; sponsorHashtags?: string[] } = {}): string {
  const handle = (o.instagram ?? "").replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "");
  const vals: Record<string, string> = { name: e.name, hashtag: cleanTag(e.hashtag), date: e.eventDate ?? "", client: e.clientName ?? "", instagram: handle ? `@${handle}` : "" };
  let text = (template?.trim() ? template : DEFAULT_CAPTION).replace(/\{\{event\.(name|hashtag|date|client|instagram)\}\}/g, (_m, k: string) => vals[k] ?? "");
  text = text.replace(/#(?=\s|$)/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const extra = (o.sponsorHashtags ?? []).map(cleanTag).filter(Boolean).map((t) => `#${t}`).filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
  return extra.length ? `${text} ${extra.join(" ")}` : text;
}

/** Hashtags the guest can copy on their own: the event hashtag first, then sponsors. */
export function hashtagLine(e: EventInfo, sponsorHashtags: string[] = []): string {
  return [cleanTag(e.hashtag), ...sponsorHashtags.map(cleanTag)].filter(Boolean).map((t) => `#${t}`).join(" ");
}

export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
