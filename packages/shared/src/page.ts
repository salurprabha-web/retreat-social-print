import { z } from "zod";

/* ---------- Devices (preview + responsive overrides) ---------- */
export const DEVICES = ["mobile", "tablet", "desktop", "kiosk22", "display43"] as const;
export type Device = (typeof DEVICES)[number];
export const DEVICE_INFO: Record<Device, { label: string; width: number; height: number; fontFactor: number }> = {
  mobile: { label: "Mobile", width: 390, height: 780, fontFactor: 1 },
  tablet: { label: "Tablet", width: 820, height: 1100, fontFactor: 1.15 },
  desktop: { label: "Desktop", width: 1280, height: 760, fontFactor: 1.2 },
  kiosk22: { label: "22\" touchscreen", width: 1920, height: 1080, fontFactor: 1.7 },
  display43: { label: "43\" display", width: 3840, height: 2160, fontFactor: 3.2 },
};
export function deviceForWidth(w: number): Device {
  return w < 640 ? "mobile" : w < 1024 ? "tablet" : w < 1700 ? "desktop" : w < 2800 ? "kiosk22" : "display43";
}

/* ---------- Theme ---------- */
export const FONTS = ["sans", "serif", "elegant", "display", "rounded", "mono", "condensed", "script"] as const;
export type FontKey = (typeof FONTS)[number];
/**
 * Bundled open-licence (OFL) fonts. The SAME files are loaded in the browser (preview) and registered on the server
 * (final print render), so what the guest sees is what prints. `bold`/`italic` say which real faces exist: a style a font
 * does not have is never faked, so preview and print cannot disagree.
 */
export const FONT_META: Record<FontKey, { family: string; pkg: string; bold: boolean; italic: boolean; generic: string }> = {
  sans: { family: "Inter", pkg: "inter", bold: true, italic: true, generic: "system-ui, sans-serif" },
  serif: { family: "Lora", pkg: "lora", bold: true, italic: true, generic: "Georgia, serif" },
  elegant: { family: "Playfair Display", pkg: "playfair-display", bold: true, italic: true, generic: "Georgia, serif" },
  display: { family: "Bebas Neue", pkg: "bebas-neue", bold: false, italic: false, generic: "Impact, sans-serif" },
  rounded: { family: "Nunito", pkg: "nunito", bold: true, italic: true, generic: "system-ui, sans-serif" },
  mono: { family: "JetBrains Mono", pkg: "jetbrains-mono", bold: true, italic: true, generic: "ui-monospace, monospace" },
  condensed: { family: "Oswald", pkg: "oswald", bold: true, italic: false, generic: "'Arial Narrow', sans-serif" },
  script: { family: "Dancing Script", pkg: "dancing-script", bold: true, italic: false, generic: "cursive" },
};
/** Devanagari (Hindi/Marathi) glyphs come from this fallback in both browser and print render. */
export const FALLBACK_FONT = "Noto Sans Devanagari";
export const FONT_STACKS: Record<FontKey, string> = Object.fromEntries(
  FONTS.map((k) => [k, `'${FONT_META[k].family}', '${FALLBACK_FONT}', ${FONT_META[k].generic}`]),
) as Record<FontKey, string>;
export const fontStyleFor = (key: FontKey, bold: boolean, italic: boolean) => ({ weight: bold && FONT_META[key].bold ? 700 : 400, italic: italic && FONT_META[key].italic });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const assetName = z.string().regex(/^[a-f0-9]{32}\.(png|jpg|webp|svg)$/);

export const themeSchema = z.object({
  background: z.object({
    type: z.enum(["color", "gradient", "image"]),
    color, gradientFrom: color, gradientTo: color, gradientAngle: z.number().int().min(0).max(360),
    image: assetName.nullable(), overlay: z.number().min(0).max(0.9),
    animation: z.enum(["none", "gradient-shift", "slow-zoom"]),
  }),
  textColor: color, accentColor: color,
  fontFamily: z.enum(FONTS), baseFontSize: z.number().int().min(12).max(28),
  align: z.enum(["left", "center", "right"]),
  spacing: z.enum(["compact", "normal", "relaxed"]),
  border: z.enum(["none", "thin", "double", "ornate"]), borderColor: color,
  button: z.object({
    color, textColor: color, shape: z.enum(["pill", "rounded", "square"]),
    animation: z.enum(["none", "pulse", "bounce", "glow"]),
  }),
});
export type Theme = z.infer<typeof themeSchema>;

/* ---------- Components ---------- */
export const COMPONENT_TYPES = [
  "logo", "image", "heading", "paragraph", "button", "qr", "hashtag", "sponsor", "countdown",
  "decorative", "video", "instructions", "footer", "social",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

const propVal = z.union([z.string().max(1000), z.number(), z.boolean()]);
export const componentSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(COMPONENT_TYPES),
  props: z.record(z.string().max(40), propVal).refine((o) => Object.keys(o).length <= 24, "too many props"),
  hideOn: z.array(z.enum(DEVICES)).max(5).default([]),
  scale: z.partialRecord(z.enum(DEVICES), z.number().min(10).max(100)).default({}),   // width % per device
  paddingY: z.number().int().min(0).max(120).default(8),
  marginX: z.number().int().min(0).max(120).default(0),
});
export type PageComponent = z.infer<typeof componentSchema>;

/* Fields the property panel shows for each component type. */
export type PropField = { key: string; label: string; kind: "text" | "textarea" | "color" | "number" | "select" | "image" | "url"; options?: string[]; max?: number };
export const PROP_FIELDS: Record<ComponentType, PropField[]> = {
  logo: [{ key: "which", label: "Logo", kind: "select", options: ["event", "client"] }],
  image: [{ key: "src", label: "Image", kind: "image" }, { key: "alt", label: "Alt text", kind: "text" }],
  heading: [{ key: "text", label: "Text", kind: "text" }, { key: "size", label: "Size (%)", kind: "number" }, { key: "color", label: "Colour (blank = theme)", kind: "color" }],
  paragraph: [{ key: "text", label: "Text", kind: "textarea" }, { key: "color", label: "Colour (blank = theme)", kind: "color" }],
  button: [{ key: "label", label: "Button text", kind: "text" }, { key: "action", label: "Action", kind: "select", options: ["start", "link"] }, { key: "href", label: "Link (https://...)", kind: "url" }],
  qr: [{ key: "caption", label: "Caption", kind: "text" }],
  hashtag: [{ key: "text", label: "Text", kind: "text" }],
  sponsor: [{ key: "label", label: "Label", kind: "text" }, { key: "src", label: "Sponsor logo", kind: "image" }, { key: "href", label: "Link (https://...)", kind: "url" }],
  countdown: [{ key: "label", label: "Label", kind: "text" }, { key: "target", label: "Target date (YYYY-MM-DD, blank = event date)", kind: "text" }],
  decorative: [{ key: "style", label: "Style", kind: "select", options: ["line", "dots", "diamond", "wave", "confetti", "frame-corners"] }, { key: "color", label: "Colour (blank = accent)", kind: "color" }],
  video: [{ key: "url", label: "Video link (https://...)", kind: "url" }],
  instructions: [{ key: "title", label: "Title", kind: "text" }, { key: "text", label: "Steps (one per line)", kind: "textarea" }],
  footer: [{ key: "text", label: "Footer text", kind: "text" }, { key: "termsUrl", label: "Terms link", kind: "url" }, { key: "privacyUrl", label: "Privacy link", kind: "url" }],
  social: [{ key: "label", label: "Label", kind: "text" }, { key: "instagram", label: "Instagram handle", kind: "text" }],
};

const DEFAULT_PROPS: Record<ComponentType, Record<string, string | number | boolean>> = {
  logo: { which: "event" }, image: { src: "", alt: "" }, heading: { text: "{{event.name}}", size: 100, color: "" },
  paragraph: { text: "Take a photo, pick a frame, share it and print it.", color: "" },
  button: { label: "START", action: "start", href: "" }, qr: { caption: "Scan to join" }, hashtag: { text: "#{{event.hashtag}}" },
  sponsor: { label: "Presented by", src: "", href: "" }, countdown: { label: "Event starts in", target: "" },
  decorative: { style: "line", color: "" }, video: { url: "" },
  instructions: { title: "How it works", text: "Take or upload a photo\nChoose a frame\nShare and print" },
  footer: { text: "{{event.client}}", termsUrl: "", privacyUrl: "" }, social: { label: "Follow us", instagram: "" },
};
export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export function newComponent(type: ComponentType, props: Record<string, string | number | boolean> = {}): PageComponent {
  return { id: newId(), type, props: { ...DEFAULT_PROPS[type], ...props }, hideOn: [], scale: {}, paddingY: 8, marginX: 0 };
}

/* ---------- Journey ---------- */
export const STEP_IDS = ["welcome", "details", "capture", "frame", "edit", "preview", "share", "success"] as const;
export type StepId = (typeof STEP_IDS)[number];
export const stepSchema = z.object({
  id: z.enum(STEP_IDS), enabled: z.boolean(),
  title: z.string().max(120), instructions: z.string().max(500), buttonLabel: z.string().max(40),
});
export const FIELD_TYPES = ["name", "phone", "email", "department", "company", "consent", "campaign"] as const;
export const fieldSchema = z.object({
  id: z.string().min(1).max(40), type: z.enum(FIELD_TYPES), label: z.string().max(120), required: z.boolean(),
});

export const pageDefinitionSchema = z.object({
  schema: z.literal(1),
  theme: themeSchema,
  welcome: z.object({ components: z.array(componentSchema).max(40) }),
  journey: z.object({
    steps: z.array(stepSchema).max(8),
    idleSeconds: z.number().int().min(0).max(3600),       // 0 = no idle screen
    timeoutSeconds: z.number().int().min(0).max(3600),    // 0 = never reset the session
    autoAdvanceSeconds: z.number().int().min(0).max(60),  // 0 = manual
  }),
  fields: z.array(fieldSchema).max(12),
  messages: z.object({ success: z.string().max(300), idleTitle: z.string().max(120) }),
}).superRefine((d, ctx) => {
  const ids = d.journey.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate journey step", path: ["journey", "steps"] });
  const cap = d.journey.steps.find((s) => s.id === "capture");
  if (!cap || !cap.enabled) ctx.addIssue({ code: "custom", message: "The photo capture step must stay enabled", path: ["journey", "steps"] });
  const seen = new Set<string>();
  d.fields.forEach((f, i) => { if (seen.has(f.id)) ctx.addIssue({ code: "custom", message: "duplicate field id", path: ["fields", i] }); seen.add(f.id); });
  d.welcome.components.forEach((c, i) => {
    for (const [k, v] of Object.entries(c.props)) {
      if (typeof v !== "string" || v === "") continue;
      if ((k === "href" || k === "url" || k === "termsUrl" || k === "privacyUrl") && !/^(https:\/\/|\/|#|mailto:|tel:)/i.test(v))
        ctx.addIssue({ code: "custom", message: `${k} must start with https://`, path: ["welcome", "components", i, "props", k] });
      if (k === "src" && !/^[a-f0-9]{32}\.(png|jpg|webp|svg)$/.test(v))
        ctx.addIssue({ code: "custom", message: "invalid image reference", path: ["welcome", "components", i, "props", k] });
      if ((k === "color") && !/^#[0-9a-fA-F]{6}$/.test(v))
        ctx.addIssue({ code: "custom", message: "invalid colour", path: ["welcome", "components", i, "props", k] });
    }
  });
});
export type PageDefinition = z.infer<typeof pageDefinitionSchema>;

export const DEFAULT_STEPS: PageDefinition["journey"]["steps"] = [
  { id: "welcome", enabled: true, title: "Welcome", instructions: "", buttonLabel: "START" },
  { id: "details", enabled: false, title: "About you", instructions: "Optional: tell us a little about you.", buttonLabel: "Continue" },
  { id: "capture", enabled: true, title: "Add your photo", instructions: "Take a photo or choose one from your gallery.", buttonLabel: "Continue" },
  { id: "frame", enabled: true, title: "Choose a frame", instructions: "Tap a frame you like.", buttonLabel: "Continue" },
  { id: "edit", enabled: true, title: "Adjust your photo", instructions: "Drag to move, pinch to zoom.", buttonLabel: "Preview" },
  { id: "preview", enabled: true, title: "Looking good!", instructions: "Happy with it? Tap Finish.", buttonLabel: "Finish" },
  { id: "share", enabled: true, title: "Share your photo", instructions: "Download it or share it on Instagram.", buttonLabel: "Done" },
  { id: "success", enabled: true, title: "Thank you!", instructions: "", buttonLabel: "Start again" },
];

/** Replace {{event.*}} tokens. Rendering is always through React text nodes, so values are never interpreted as HTML. */
export interface EventInfo { name: string; hashtag: string | null; eventDate: string | null; clientName: string | null }
export function fillTokens(s: string, e: EventInfo): string {
  return s.replace(/\{\{event\.(name|hashtag|date|client)\}\}/g, (_m, k: string) =>
    ({ name: e.name, hashtag: e.hashtag ?? "", date: e.eventDate ?? "", client: e.clientName ?? "" } as Record<string, string>)[k] ?? "");
}

/** Remove every reference to uploaded files (used when a design is saved as a reusable template). */
export function stripAssets(d: PageDefinition): PageDefinition {
  const c: PageDefinition = JSON.parse(JSON.stringify(d));
  c.theme.background.image = null;
  if (c.theme.background.type === "image") c.theme.background.type = "gradient";
  for (const comp of c.welcome.components) if (typeof comp.props.src === "string") comp.props.src = "";
  return c;
}
