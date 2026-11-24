"use client";
import type { CSSProperties } from "react";
import { FONT_STACKS, coverLayout, fillTokens, fontStyleFor, type EventInfo, type FrameLayer, type PhotoAdjust } from "@rsp/shared";

export interface SlotPhoto { url: string; width: number; height: number; adjust?: PhotoAdjust }
export interface FrameCanvasProps {
  widthPx: number; heightPx: number; layers: FrameLayer[]; event: EventInfo;
  displayWidth: number;                                   // CSS px the frame is drawn at
  assetUrl: (name: string) => string;
  logoUrl: (kind: "event" | "client") => string | null;
  photos?: Record<number, SlotPhoto>;                     // by slot number; missing = placeholder
  showPlaceholders?: boolean;                             // false: empty slots render blank (final look without a photo)
}

const NO_ADJ: PhotoAdjust = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };

/** Draws a frame exactly as it will be composed: same layer order and fractions; sized by displayWidth. */
export function FrameCanvas({ widthPx, heightPx, layers, event, displayWidth, assetUrl, logoUrl, photos = {}, showPlaceholders = true }: FrameCanvasProps) {
  const W = displayWidth, H = (displayWidth * heightPx) / widthPx;
  return (
    <div style={{ position: "relative", width: W, height: H, overflow: "hidden", background: "#fff", flex: "none" }}>
      {layers.map((l) => {
        if (l.hidden) return null;
        const box: CSSProperties = {
          position: "absolute", left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: `${l.w * 100}%`, height: `${l.h * 100}%`,
          transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined, opacity: l.opacity, boxSizing: "border-box",
        };
        switch (l.type) {
          case "shape":
            return <div key={l.id} style={{ ...box, background: l.fill, borderRadius: l.shape === "ellipse" ? "50%" : `${l.radius * 100}%/${(l.radius * l.w * W) / Math.max(1, l.h * H) * 100}%` }} />;
          case "text":
            return (
              <div key={l.id} style={{ ...box, color: l.color, fontFamily: FONT_STACKS[l.fontFamily], fontSize: (H * l.sizePct) / 100, fontWeight: fontStyleFor(l.fontFamily, l.bold, l.italic).weight, fontStyle: fontStyleFor(l.fontFamily, l.bold, l.italic).italic ? "italic" : "normal",
                textAlign: l.align, display: "flex", alignItems: "center", justifyContent: l.align === "left" ? "flex-start" : l.align === "right" ? "flex-end" : "center", lineHeight: 1.1, overflow: "hidden", whiteSpace: "pre-wrap" }}>
                <span style={{ width: "100%" }}>{fillTokens(l.text, event)}</span>
              </div>
            );
          case "image":
            return l.src ? <img key={l.id} src={assetUrl(l.src)} alt="" draggable={false} style={{ ...box, objectFit: l.fit === "stretch" ? "fill" : l.fit }} />
              : <div key={l.id} style={{ ...box, border: "1px dashed #888", color: "#888", fontSize: 11, display: "grid", placeItems: "center" }}>Image</div>;
          case "logo": {
            const u = logoUrl(l.which);
            return u ? <img key={l.id} src={u} alt="" draggable={false} style={{ ...box, objectFit: "contain" }} />
              : <div key={l.id} style={{ ...box, border: "1px dashed #888", color: "#888", fontSize: 11, display: "grid", placeItems: "center" }}>{l.which} logo</div>;
          }
          case "photo": {
            const p = photos[l.slot];
            const bw = l.borderColor && l.borderWidth ? l.borderWidth * W : 0;
            // The border is drawn ON TOP of the photo (inside the slot) so the photo area never shrinks: the print render does the same.
            const style: CSSProperties = { ...box, overflow: "hidden", borderRadius: `${l.radius * 100}%/${(l.radius * l.w * W) / Math.max(1, l.h * H) * 100}%` };
            const ring = bw ? <div style={{ position: "absolute", inset: 0, border: `${bw}px solid ${l.borderColor}`, borderRadius: "inherit", boxSizing: "border-box", pointerEvents: "none" }} /> : null;
            if (p) {
              const a = p.adjust ?? NO_ADJ;
              const L = coverLayout(p.width, p.height, a, (l.h * H) / (l.w * W));
              const aspect = (l.h * H) / (l.w * W);
              const quarter = a.rotate % 180 !== 0;
              return (
                <div key={l.id} style={style}>
                  <img src={p.url} alt="" draggable={false} style={{ position: "absolute", left: `${(L.left + L.drawW / 2) * 100}%`, top: `${((L.top + L.drawH / 2) / aspect) * 100}%`,
                    width: `${(quarter ? L.drawH : L.drawW) * 100}%`, maxWidth: "none", transform: `translate(-50%, -50%) rotate(${a.rotate}deg)` }} />
                  {ring}
                </div>
              );
            }
            return showPlaceholders ? (
              <div key={l.id} style={{ ...style, background: "repeating-linear-gradient(45deg,#d7dde6,#d7dde6 10px,#e6ebf2 10px,#e6ebf2 20px)", display: "grid", placeItems: "center", color: "#5b6573", fontWeight: 700, fontSize: Math.max(10, W * 0.04) }}>
                Photo {l.slot}{ring}
              </div>
            ) : <div key={l.id} style={style}>{ring}</div>;
          }
        }
      })}
    </div>
  );
}

/** A neutral sample portrait for previewing a frame without a real guest photo. */
export const SAMPLE_PHOTO: SlotPhoto = {
  width: 1200, height: 1600,
  url: "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6c177"/><stop offset="1" stop-color="#7aa2f7"/></linearGradient></defs><rect width="1200" height="1600" fill="url(#g)"/><circle cx="600" cy="620" r="230" fill="#fff" opacity=".85"/><path d="M180 1600 C180 1150 400 960 600 960 C800 960 1020 1150 1020 1600Z" fill="#fff" opacity=".85"/></svg>'),
};
