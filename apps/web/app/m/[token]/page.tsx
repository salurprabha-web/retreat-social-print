"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";

interface Info { version: string; event: { name: string; hashtag: string | null }; title: string; showProgress: boolean; aspect: number; progress: { filled: number; cells: number; percent: number }; joinPath: string }

const preload = (url: string) => new Promise<boolean>((res) => { const im = new Image(); const t = setTimeout(() => res(false), 15000); im.onload = () => { clearTimeout(t); res(true); }; im.onerror = () => { clearTimeout(t); res(false); }; im.src = url; });

/**
 * Live mosaic display. Opens from an unguessable link without a login and is sized in vmin/vh for any screen.
 * It keeps showing the last mosaic when the network drops, and swaps to the new picture only once that has fully loaded.
 */
export default function MosaicDisplay() {
  const { token } = useParams<{ token: string }>();
  const API = `/api/v1/public/m/${token}`;
  const [info, setInfo] = useState<Info | null>(null); const [gone, setGone] = useState(false); const [offline, setOffline] = useState(false);
  const [shown, setShown] = useState<{ url: string; version: string } | null>(null);
  const [qr, setQr] = useState(""); const [idle, setIdle] = useState(false); const [fs, setFs] = useState(false);
  const loading = useRef<string | null>(null); const lastOk = useRef(Date.now());
  const width = useMemo(() => (typeof window !== "undefined" && window.innerWidth * (window.devicePixelRatio || 1) > 2000 ? 2400 : 1600), []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (r.status === 404) { setGone(true); return; }
      if (!r.ok) throw new Error();
      const j = (await r.json()) as Info;
      lastOk.current = Date.now(); setOffline(false); setGone(false); setInfo(j);
      const url = `${API}/image?w=${width}&v=${j.version}`;
      if (loading.current !== j.version) {
        loading.current = j.version;
        if (await preload(url)) setShown({ url, version: j.version }); else loading.current = null;       // retry on the next check
      }
    } catch { if (Date.now() - lastOk.current > 15000) setOffline(true); }
  }, [API, width]);

  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const h = () => setFs(!!document.fullscreenElement); document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h); }, []);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>; const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3000); };
    wake(); window.addEventListener("mousemove", wake); window.addEventListener("keydown", wake); window.addEventListener("touchstart", wake);
    return () => { clearTimeout(t); window.removeEventListener("mousemove", wake); window.removeEventListener("keydown", wake); window.removeEventListener("touchstart", wake); };
  }, []);
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const get = async () => { try { lock = await (navigator as any).wakeLock?.request("screen"); } catch { /* not supported or refused */ } };
    get(); const v = () => { if (document.visibilityState === "visible") get(); }; document.addEventListener("visibilitychange", v);
    return () => { document.removeEventListener("visibilitychange", v); lock?.release().catch(() => {}); };
  }, []);
  useEffect(() => { if (info?.joinPath) QRCode.toDataURL(`${window.location.origin}${info.joinPath}`, { width: 500, margin: 1 }).then(setQr).catch(() => {}); }, [info?.joinPath]);

  if (gone) return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b1220", color: "#cbd5e1", fontFamily: "system-ui", textAlign: "center", padding: 24 }}><div><h1 style={{ fontSize: "5vmin" }}>The mosaic is not active</h1><p style={{ fontSize: "2.4vmin" }}>It is switched off, has no master image yet, the event is not live, or this link was replaced. This screen checks again by itself.</p></div></div>;
  if (!info) return <div style={{ minHeight: "100vh", background: "#0b1220" }} />;
  const p = info.progress;
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "radial-gradient(circle at 50% 40%, #16233a, #070b14)", color: "#f8fafc", fontFamily: "system-ui, sans-serif", cursor: idle ? "none" : "default" }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: "11vh", display: "flex", alignItems: "center", padding: "0 3vmin", gap: "2vmin", zIndex: 3 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "4vmin", fontWeight: 700, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{info.title || info.event.name}</div>
          {info.title && <div style={{ fontSize: "2.2vmin", opacity: .8 }}>{info.event.name}</div>}
        </div>
        {info.event.hashtag && <div style={{ fontSize: "3.6vmin", fontWeight: 700, color: "#f5b942" }}>{info.event.hashtag.startsWith("#") ? info.event.hashtag : `#${info.event.hashtag}`}</div>}
      </div>

      <div style={{ position: "absolute", left: "3vmin", right: "3vmin", top: "11vh", bottom: info.showProgress || qr ? "max(13vh, 21vmin)" : "3vmin", display: "grid", gridTemplate: "minmax(0, 1fr) / minmax(0, 1fr)", placeItems: "center" }}>
        {shown
          ? <img key={shown.version} src={shown.url} alt="Photo mosaic" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "1vmin", boxShadow: "0 1vmin 5vmin rgba(0,0,0,.55)", animation: "mFade .9s ease both" }} />
          : <div style={{ fontSize: "3vmin", opacity: .8 }}>Building the mosaic…</div>}
      </div>

      {info.showProgress && (
        <div style={{ position: "absolute", left: "3vmin", right: qr ? "21vmin" : "3vmin", bottom: "3vmin", zIndex: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "2.6vmin", marginBottom: ".8vmin" }}>
            <span><b>{p.filled.toLocaleString()}</b> of {p.cells.toLocaleString()} tiles</span><b>{p.percent}%</b>
          </div>
          <div style={{ height: "2vmin", background: "rgba(255,255,255,.18)", borderRadius: 99, overflow: "hidden" }} role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${p.percent}%`, height: "100%", background: "linear-gradient(90deg,#f5b942,#ffd98a)", transition: "width 1s ease" }} />
          </div>
        </div>
      )}
      {qr && (
        <div style={{ position: "absolute", right: "2vmin", bottom: "2vmin", zIndex: 4, background: "#fff", color: "#111", borderRadius: "1.4vmin", padding: "1vmin", textAlign: "center", boxShadow: "0 1vmin 3vmin rgba(0,0,0,.4)" }}>
          <img src={qr} alt="Scan to add your photo" style={{ width: "15vmin", height: "15vmin", display: "block" }} />
          <div style={{ fontSize: "1.8vmin", fontWeight: 700 }}>Add your photo</div>
        </div>
      )}
      {offline && <div style={{ position: "absolute", left: "2vmin", top: "12vh", zIndex: 4, fontSize: "1.8vmin", background: "rgba(0,0,0,.55)", color: "#fff", padding: ".6vmin 1.4vmin", borderRadius: 99 }}>Reconnecting…</div>}
      {!idle && (
        <button onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}))}
          style={{ position: "absolute", right: "2vmin", top: "1.6vmin", zIndex: 5, fontSize: "2vmin", padding: ".8vmin 1.8vmin", borderRadius: 8, border: "1px solid rgba(255,255,255,.4)", background: "rgba(0,0,0,.5)", color: "#fff", cursor: "pointer" }}>
          {fs ? "Exit full screen" : "Full screen"}
        </button>
      )}
      <style>{"@keyframes mFade{from{opacity:0}to{opacity:1}}"}</style>
    </div>
  );
}
