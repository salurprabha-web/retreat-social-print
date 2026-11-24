"use client";
import type { CSSProperties, ReactNode } from "react";
import { DEVICE_INFO, FONT_STACKS, type Device, type PageDefinition } from "@rsp/shared";

/** The themed canvas (background, border, font) shared by every guest screen after the landing page. */
export function ThemeFrame({ def, device, minHeight, assetUrl, children }: {
  def: PageDefinition; device: Device; minHeight: number; assetUrl: (n: string) => string; children: ReactNode;
}) {
  const t = def.theme; const bg = t.background; const info = DEVICE_INFO[device];
  const bgStyle: CSSProperties = bg.type === "color" ? { background: bg.color }
    : bg.type === "gradient" ? { background: `linear-gradient(${bg.gradientAngle}deg, ${bg.gradientFrom}, ${bg.gradientTo})`, ...(bg.animation === "gradient-shift" ? { backgroundSize: "200% 200%" } : {}) }
    : { background: bg.image ? `url(${assetUrl(bg.image)}) center/cover` : bg.color };
  const anim = bg.animation === "gradient-shift" ? "bg-shift" : bg.animation === "slow-zoom" ? "bg-zoom" : "";
  const minH = Math.max(info.height, minHeight);
  return (
    <div style={{ position: "relative", width: info.width, minHeight: minH, overflow: "hidden", color: t.textColor, fontFamily: FONT_STACKS[t.fontFamily], fontSize: t.baseFontSize * info.fontFactor, textAlign: t.align }}>
      <div className={anim} style={{ position: "absolute", inset: 0, ...bgStyle }} />
      {bg.type === "image" && bg.image && <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${bg.overlay})` }} />}
      {t.border !== "none" && <div style={{ position: "absolute", inset: "2%", pointerEvents: "none", borderRadius: t.border === "ornate" ? 18 : 4,
        border: t.border === "thin" ? `2px solid ${t.borderColor}` : t.border === "double" ? `8px double ${t.borderColor}` : `10px ridge ${t.borderColor}` }} />}
      <div style={{ position: "relative", minHeight: minH, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "6% 7%", gap: 14 }}>
        {children}
      </div>
    </div>
  );
}
