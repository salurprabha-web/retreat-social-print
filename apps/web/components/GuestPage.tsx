"use client";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import QRCode from "qrcode";
import { DEVICE_INFO, FONT_STACKS, fillTokens, type Device, type EventInfo, type PageComponent, type PageDefinition } from "@rsp/shared";

export interface GuestPageProps {
  def: PageDefinition; event: EventInfo; device: Device;
  assetUrl: (name: string) => string;
  logoUrl: (kind: "event" | "client") => string | null;   // null = no logo uploaded
  guestUrl: string;
  minHeight?: number;                                      // real screen height in design pixels (public page)
  builder?: boolean;                                      // show placeholders for empty things
  onStart?: () => void;
  wrap?: (c: PageComponent, node: ReactNode, index: number) => ReactNode;
  tail?: ReactNode;                                        // drop zone etc. in builder
}

const PAD = { compact: 10, normal: 18, relaxed: 30 } as const;
const str = (c: PageComponent, k: string) => (typeof c.props[k] === "string" ? (c.props[k] as string) : "");

function Qr({ text, color }: { text: string; color: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(text, { margin: 1, width: 360, color: { dark: color, light: "#ffffff" } }).then(setSrc).catch(() => setSrc("")); }, [text, color]);
  return src ? <img src={src} alt="QR code" style={{ width: "100%", maxWidth: 220, background: "#fff", padding: 8, borderRadius: 8 }} /> : null;
}

function Countdown({ target, label, color }: { target: Date | null; label: string; color: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!target || isNaN(+target)) return <div style={{ opacity: .7 }}>{label} (set a date)</div>;
  const ms = +target - now;
  if (ms <= 0) return <div style={{ color, fontWeight: 700 }}>Happening now</div>;
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
  return <div><div style={{ opacity: .8, fontSize: ".8em" }}>{label}</div><div style={{ color, fontWeight: 700, fontSize: "1.6em" }}>{d}d {h}h {m}m {s}s</div></div>;
}

function Deco({ style, color }: { style: string; color: string }) {
  const c = color;
  const svg: Record<string, ReactNode> = {
    line: <line x1="10" y1="10" x2="190" y2="10" stroke={c} strokeWidth="2" />,
    dots: [30, 70, 100, 130, 170].map((x) => <circle key={x} cx={x} cy="10" r={x === 100 ? 4 : 2.5} fill={c} />),
    diamond: <><line x1="10" y1="10" x2="85" y2="10" stroke={c} /><rect x="94" y="4" width="12" height="12" transform="rotate(45 100 10)" fill={c} /><line x1="115" y1="10" x2="190" y2="10" stroke={c} /></>,
    wave: <path d="M5 10 Q 25 -2 45 10 T 85 10 T 125 10 T 165 10 T 205 10" fill="none" stroke={c} strokeWidth="2" />,
    confetti: [[20, 6, 0], [50, 14, 30], [80, 5, 60], [110, 15, 10], [140, 6, 45], [170, 13, 80]].map(([x, y, r], i) => <rect key={i} x={x} y={y} width="8" height="4" fill={c} opacity={i % 2 ? .6 : 1} transform={`rotate(${r} ${x} ${y})`} />),
    "frame-corners": <path d="M10 18 V4 H24 M190 18 V4 H176" fill="none" stroke={c} strokeWidth="2" />,
  };
  return <svg viewBox="0 0 200 20" style={{ width: "min(100%, 260px)", height: 22, display: "block", margin: "0 auto" }} aria-hidden>{svg[style] ?? svg.line}</svg>;
}

function renderComponent(c: PageComponent, p: GuestPageProps): ReactNode {
  const { def, event } = p; const t = def.theme;
  const text = (k: string) => fillTokens(str(c, k), event);
  switch (c.type) {
    case "logo": {
      const u = p.logoUrl(str(c, "which") === "client" ? "client" : "event");
      return u ? <img src={u} alt={`${str(c, "which")} logo`} style={{ maxWidth: "100%", maxHeight: "6em", objectFit: "contain" }} />
        : p.builder ? <div className="ph">{str(c, "which") === "client" ? "Client" : "Event"} logo (upload under Branding)</div> : null;
    }
    case "image": {
      const s = str(c, "src");
      return s ? <img src={p.assetUrl(s)} alt={str(c, "alt")} style={{ width: "100%", borderRadius: 8 }} /> : p.builder ? <div className="ph">Image: choose a file</div> : null;
    }
    case "heading": return <h1 style={{ margin: 0, fontSize: `${(Number(c.props.size) || 100) * 0.022}em`, lineHeight: 1.15, color: str(c, "color") || undefined }}>{text("text")}</h1>;
    case "paragraph": return <p style={{ margin: 0, whiteSpace: "pre-line", color: str(c, "color") || undefined, opacity: .92 }}>{text("text")}</p>;
    case "button": {
      const b = t.button; const link = str(c, "action") === "link" && str(c, "href");
      const style: CSSProperties = {
        background: b.color, color: b.textColor, border: 0, padding: ".8em 2.2em", fontSize: "1.1em", fontWeight: 700, cursor: "pointer",
        borderRadius: b.shape === "pill" ? 999 : b.shape === "rounded" ? 12 : 0, fontFamily: "inherit", textDecoration: "none", display: "inline-block",
        width: "auto", margin: 0,
      };
      const cls = b.animation === "none" ? "" : `btn-${b.animation}`;
      return link
        ? <a className={cls} style={style} href={str(c, "href")} target="_blank" rel="noopener noreferrer">{text("label")}</a>
        : <button type="button" className={cls} style={style} onClick={p.onStart}>{text("label")}</button>;
    }
    case "qr": return <div><Qr text={p.guestUrl} color="#000000" /><div style={{ marginTop: 6, fontSize: ".85em", opacity: .85 }}>{text("caption")}</div></div>;
    case "hashtag": return <div style={{ color: t.accentColor, fontWeight: 700, fontSize: "1.2em" }}>{text("text")}</div>;
    case "sponsor": {
      const s = str(c, "src");
      const img = s ? <img src={p.assetUrl(s)} alt="Sponsor" style={{ maxHeight: "4em", maxWidth: "100%" }} /> : p.builder ? <div className="ph">Sponsor logo</div> : null;
      return <div><div style={{ fontSize: ".8em", opacity: .75, marginBottom: 4 }}>{text("label")}</div>
        {str(c, "href") && img ? <a href={str(c, "href")} target="_blank" rel="noopener noreferrer">{img}</a> : img}</div>;
    }
    case "countdown": {
      const raw = str(c, "target") || event.eventDate || "";
      return <Countdown target={raw ? new Date(raw + "T00:00:00") : null} label={text("label")} color={t.accentColor} />;
    }
    case "decorative": return <Deco style={str(c, "style")} color={str(c, "color") || t.accentColor} />;
    case "video": {
      const u = str(c, "url");
      return u ? <video src={u} controls playsInline style={{ width: "100%", borderRadius: 8 }} /> : p.builder ? <div className="ph">Video: add a link to an .mp4 file</div> : null;
    }
    case "instructions": {
      const lines = text("text").split("\n").filter(Boolean);
      return <div style={{ textAlign: "left", display: "inline-block", maxWidth: "100%" }}>
        <div style={{ fontWeight: 700, marginBottom: 6, textAlign: "center" }}>{text("title")}</div>
        <ol style={{ margin: 0, paddingLeft: "1.4em" }}>{lines.map((l, i) => <li key={i}>{l}</li>)}</ol></div>;
    }
    case "footer": return <div style={{ fontSize: ".8em", opacity: .8 }}>{text("text")}
      {str(c, "termsUrl") && <> &middot; <a style={{ color: "inherit" }} href={str(c, "termsUrl")} target="_blank" rel="noopener noreferrer">Terms</a></>}
      {str(c, "privacyUrl") && <> &middot; <a style={{ color: "inherit" }} href={str(c, "privacyUrl")} target="_blank" rel="noopener noreferrer">Privacy</a></>}</div>;
    case "social": {
      const h = str(c, "instagram").replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "");
      return <div>{text("label")} {h && <a style={{ color: t.accentColor, fontWeight: 700 }} href={`https://instagram.com/${h}`} target="_blank" rel="noopener noreferrer">@{h}</a>}</div>;
    }
  }
}

export function GuestPage(p: GuestPageProps) {
  const { def, device } = p; const t = def.theme; const info = DEVICE_INFO[device];
  const bg = t.background;
  const bgStyle: CSSProperties = bg.type === "color" ? { background: bg.color }
    : bg.type === "gradient" ? { background: `linear-gradient(${bg.gradientAngle}deg, ${bg.gradientFrom}, ${bg.gradientTo})`, ...(bg.animation === "gradient-shift" ? { backgroundSize: "200% 200%" } : {}) }
    : { background: bg.image ? `url(${p.assetUrl(bg.image)}) center/cover` : bg.color };
  const animCls = bg.animation === "gradient-shift" ? "bg-shift" : bg.animation === "slow-zoom" ? "bg-zoom" : "";
  const pad = PAD[t.spacing];
  const gap = t.spacing === "compact" ? 6 : t.spacing === "relaxed" ? 22 : 12;
  const comps = def.welcome.components.filter((c) => p.builder || !c.hideOn.includes(device));
  const minH = Math.max(info.height, p.minHeight ?? 0);
  return (
    <div style={{ position: "relative", width: info.width, minHeight: minH, overflow: "hidden", color: t.textColor, fontFamily: FONT_STACKS[t.fontFamily], fontSize: t.baseFontSize * info.fontFactor, textAlign: t.align }}>
      <div className={animCls} style={{ position: "absolute", inset: 0, ...bgStyle }} />
      {bg.type === "image" && bg.image && <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${bg.overlay})` }} />}
      {t.border !== "none" && <div style={{ position: "absolute", inset: "2%", pointerEvents: "none", border: t.border === "thin" ? `2px solid ${t.borderColor}` : t.border === "double" ? `8px double ${t.borderColor}` : `10px ridge ${t.borderColor}`, borderRadius: t.border === "ornate" ? 18 : 4 }} />}
      <div style={{ position: "relative", minHeight: minH, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: `${pad * 2}px ${pad}px`, gap }}>
        {comps.map((c, i) => {
          const hidden = c.hideOn.includes(device);
          const node = (
            <div key={c.id} style={{ width: `${c.scale[device] ?? 100}%`, maxWidth: 760 * info.fontFactor, padding: `${c.paddingY}px ${c.marginX}px`, opacity: hidden ? 0.3 : 1, outline: hidden ? "1px dashed currentColor" : undefined }}>
              {renderComponent(c, p)}
            </div>
          );
          return p.wrap ? p.wrap(c, node, i) : node;
        })}
        {p.tail}
      </div>
    </div>
  );
}
