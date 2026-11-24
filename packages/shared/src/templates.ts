import { DEFAULT_STEPS, newComponent, type PageDefinition, type Theme } from "./page";

type Look = {
  key: string; name: string; category: string;
  bg: Partial<Theme["background"]>; text: string; accent: string; font: Theme["fontFamily"]; align?: Theme["align"];
  border?: Theme["border"]; button?: Partial<Theme["button"]>; spacing?: Theme["spacing"];
  heading?: string; sub?: string; deco?: string;
};

const LOOKS: Look[] = [
  { key: "luxury-corporate", name: "Luxury corporate", category: "Corporate", bg: { type: "gradient", gradientFrom: "#0f1c2e", gradientTo: "#1d3557", gradientAngle: 160 },
    text: "#f1f5f9", accent: "#c9a227", font: "serif", border: "thin", button: { color: "#c9a227", textColor: "#0f1c2e", shape: "rounded" }, deco: "line", sub: "Capture the moment. Take it home." },
  { key: "minimal-white", name: "Minimal white", category: "Minimal", bg: { type: "color", color: "#ffffff" },
    text: "#111111", accent: "#111111", font: "sans", spacing: "relaxed", button: { color: "#111111", textColor: "#ffffff", shape: "square", animation: "none" }, deco: "line" },
  { key: "black-gold", name: "Black and gold", category: "Premium", bg: { type: "gradient", gradientFrom: "#000000", gradientTo: "#1a1405", gradientAngle: 180 },
    text: "#f5e7b2", accent: "#d4af37", font: "elegant", border: "double", button: { color: "#d4af37", textColor: "#000000", shape: "pill", animation: "glow" }, deco: "diamond" },
  { key: "futuristic-tech", name: "Futuristic technology", category: "Technology", bg: { type: "gradient", gradientFrom: "#050816", gradientTo: "#0b3d91", gradientAngle: 135, animation: "gradient-shift" },
    text: "#e6f7ff", accent: "#00e5ff", font: "mono", border: "thin", button: { color: "#00e5ff", textColor: "#050816", shape: "square", animation: "glow" }, deco: "frame-corners", sub: "Step into the photo experience." },
  { key: "wedding-elegance", name: "Wedding elegance", category: "Wedding", bg: { type: "gradient", gradientFrom: "#fdf6f0", gradientTo: "#f3dcd4", gradientAngle: 180 },
    text: "#5b3a3a", accent: "#b76e79", font: "script", spacing: "relaxed", border: "thin", button: { color: "#b76e79", textColor: "#ffffff", shape: "pill", animation: "pulse" }, deco: "dots", sub: "Celebrate with us - share your moment." },
  { key: "indian-wedding", name: "Traditional Indian wedding", category: "Wedding", bg: { type: "gradient", gradientFrom: "#7a0c1e", gradientTo: "#c2410c", gradientAngle: 160 },
    text: "#fff4d6", accent: "#ffcf4a", font: "elegant", border: "ornate", button: { color: "#ffcf4a", textColor: "#5a0a16", shape: "pill", animation: "pulse" }, deco: "diamond", sub: "Join the celebration." },
  { key: "festival", name: "Festival celebration", category: "Festival", bg: { type: "gradient", gradientFrom: "#ff512f", gradientTo: "#dd2476", gradientAngle: 135, animation: "gradient-shift" },
    text: "#ffffff", accent: "#ffe14d", font: "rounded", button: { color: "#ffe14d", textColor: "#3a0a1e", shape: "pill", animation: "bounce" }, deco: "confetti", sub: "Make it a memory!" },
  { key: "college-fest", name: "Colourful college fest", category: "College", bg: { type: "gradient", gradientFrom: "#7f00ff", gradientTo: "#00c6ff", gradientAngle: 120, animation: "gradient-shift" },
    text: "#ffffff", accent: "#fff700", font: "display", button: { color: "#fff700", textColor: "#2a0a5e", shape: "rounded", animation: "bounce" }, deco: "confetti", sub: "Your fest. Your photo." },
  { key: "modern-exhibition", name: "Modern exhibition", category: "Exhibition", bg: { type: "color", color: "#eef1f5" },
    text: "#1c2430", accent: "#e4572e", font: "condensed", button: { color: "#e4572e", textColor: "#ffffff", shape: "rounded", animation: "none" }, deco: "line", sub: "Visit us. Take a photo. Take it home." },
  { key: "product-launch", name: "Premium product launch", category: "Launch", bg: { type: "gradient", gradientFrom: "#111827", gradientTo: "#312e81", gradientAngle: 150, animation: "slow-zoom" },
    text: "#ffffff", accent: "#a78bfa", font: "sans", border: "none", button: { color: "#a78bfa", textColor: "#111827", shape: "pill", animation: "glow" }, deco: "wave", sub: "Be part of the launch." },
];

function build(l: Look): PageDefinition {
  const comps = [
    newComponent("logo", { which: "event" }),
    newComponent("heading", { text: l.heading ?? "{{event.name}}" }),
    newComponent("paragraph", { text: l.sub ?? "Take a photo, pick a frame, share it and print it." }),
    newComponent("decorative", { style: l.deco ?? "line" }),
    newComponent("hashtag"),
    newComponent("button"),
    newComponent("instructions"),
    newComponent("footer"),
  ];
  return {
    schema: 1,
    theme: {
      background: { type: "color", color: "#ffffff", gradientFrom: "#000000", gradientTo: "#333333", gradientAngle: 160, image: null, overlay: 0.35, animation: "none", ...l.bg },
      textColor: l.text, accentColor: l.accent, fontFamily: l.font, baseFontSize: 17, align: l.align ?? "center",
      spacing: l.spacing ?? "normal", border: l.border ?? "none", borderColor: l.accent,
      button: { color: l.accent, textColor: "#ffffff", shape: "pill", animation: "pulse", ...l.button },
    },
    welcome: { components: comps },
    journey: { steps: DEFAULT_STEPS.map((s) => ({ ...s })), idleSeconds: 0, timeoutSeconds: 120, autoAdvanceSeconds: 0 },
    fields: [],
    messages: { success: "Your photo is ready. Enjoy the event!", idleTitle: "Touch to start" },
  };
}

export const BUILTIN_TEMPLATES = LOOKS.map((l) => ({ key: l.key, name: l.name, category: l.category, definition: build(l) }));
export const DEFAULT_DEFINITION = (): PageDefinition => build(LOOKS[1]);
export const builtinByKey = (k: string) => BUILTIN_TEMPLATES.find((t) => t.key === k);
