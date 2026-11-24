"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { FONT_STACKS } from "@rsp/shared";

interface Display {
  eventName: string; hashtag: string | null; path: string; hasLogo: boolean;
  style: { fg: string; bg: string; logo: boolean; margin: number };
  theme: { background: { type: string; color: string; gradientFrom: string; gradientTo: string; gradientAngle: number }; textColor: string; accentColor: string; fontFamily: keyof typeof FONT_STACKS } | null;
}

/** Full-screen QR for 22-inch kiosks and 43-inch displays: everything is sized in vmin so one page fits any screen. */
export default function QrDisplay() {
  const { code } = useParams<{ code: string }>();
  const [d, setD] = useState<Display | null>(null); const [gone, setGone] = useState(false);
  const [img, setImg] = useState(""); const [fs, setFs] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => fetch(`/api/v1/public/q/${code}/display`).then(async (r) => { if (!live) return; if (r.ok) { setD(await r.json()); setGone(false); } else setGone(true); }).catch(() => {});
    load(); const t = setInterval(load, 60000);          // notices when the code is turned off or expires
    return () => { live = false; clearInterval(t); };
  }, [code]);
  useEffect(() => {
    if (!d) return;
    QRCode.toDataURL(`${window.location.origin}${d.path}`, { width: 1400, margin: d.style.margin, errorCorrectionLevel: d.style.logo && d.hasLogo ? "H" : "M", color: { dark: d.style.fg, light: d.style.bg } }).then(setImg).catch(() => {});
  }, [d]);
  useEffect(() => { const h = () => setFs(!!document.fullscreenElement); document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h); }, []);

  if (gone) return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", textAlign: "center", fontFamily: "system-ui", padding: 24 }}><div><h1>This QR code is not active</h1><p>It may have been turned off, expired or replaced.</p></div></div>;
  if (!d) return null;
  const t = d.theme;
  const bg = !t ? "#ffffff" : t.background.type === "gradient" ? `linear-gradient(${t.background.gradientAngle}deg, ${t.background.gradientFrom}, ${t.background.gradientTo})` : t.background.color;
  return (
    <div style={{ minHeight: "100vh", background: bg, color: t?.textColor ?? "#111", fontFamily: FONT_STACKS[t?.fontFamily ?? "sans"], display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2.2vmin", textAlign: "center", padding: "3vmin", cursor: fs ? "none" : "default" }}>
      {d.hasLogo && <img src={`/api/v1/public/q/${code}/logo`} alt="" style={{ maxHeight: "11vmin", maxWidth: "50vmin", objectFit: "contain" }} />}
      <h1 style={{ margin: 0, fontSize: "6vmin", lineHeight: 1.1 }}>{d.eventName}</h1>
      <div style={{ fontSize: "3.4vmin", opacity: .9 }}>Scan to take your photo</div>
      <div style={{ position: "relative", width: "min(58vmin, 100%)", aspectRatio: "1", background: "#fff", padding: "1.2vmin", borderRadius: "1.6vmin", boxShadow: "0 1vmin 4vmin rgba(0,0,0,.3)" }}>
        {img && <img src={img} alt="QR code to start" style={{ width: "100%", height: "100%", display: "block" }} />}
        {d.style.logo && d.hasLogo && <img src={`/api/v1/public/q/${code}/logo`} alt="" style={{ position: "absolute", left: "50%", top: "50%", width: "20%", height: "20%", transform: "translate(-50%,-50%)", objectFit: "contain", background: d.style.bg, padding: "1%", boxSizing: "content-box" }} />}
      </div>
      {d.hashtag && <div style={{ fontSize: "4.4vmin", fontWeight: 700, color: t?.accentColor }}>#{d.hashtag}</div>}
      {!fs && <button onClick={() => document.documentElement.requestFullscreen?.()} style={{ position: "fixed", right: 16, bottom: 16, width: "auto", margin: 0, padding: "8px 14px", opacity: .5 }}>Full screen</button>}
    </div>
  );
}
