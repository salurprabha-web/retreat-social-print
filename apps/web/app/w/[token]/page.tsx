"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { FONT_STACKS, nextSlide, type WallMode, type WallStyle } from "@rsp/shared";

interface Info { event: { name: string; hashtag: string | null }; settings: { displaySeconds: number; mode: WallMode; style: WallStyle }; logos: { event: boolean; client: boolean }; joinPath: string; sponsors?: { id: string; name: string }[] }
interface Photo { id: string; width: number; height: number; at: string }

const CSS = `
@keyframes wFadeIn{from{opacity:0}to{opacity:1}} @keyframes wFadeOut{from{opacity:1}to{opacity:0}}
@keyframes wSlideIn{from{transform:translateX(100%)}to{transform:none}} @keyframes wSlideOut{from{transform:none}to{transform:translateX(-100%)}}
@keyframes wZoomIn{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}} @keyframes wZoomOut{from{opacity:1}to{opacity:0;transform:scale(1.35)}}
@keyframes wFlipIn{from{opacity:0;transform:rotateY(90deg)}to{opacity:1;transform:none}} @keyframes wFlipOut{from{opacity:1}to{opacity:0;transform:rotateY(-90deg)}}
@keyframes wPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
.w-fade-in{animation:wFadeIn .9s ease both}.w-fade-out{animation:wFadeOut .9s ease both}
.w-slide-in{animation:wSlideIn .9s ease both}.w-slide-out{animation:wSlideOut .9s ease both}
.w-zoom-in{animation:wZoomIn .9s ease both}.w-zoom-out{animation:wZoomOut .9s ease both}
.w-flip-in{animation:wFlipIn .9s ease both}.w-flip-out{animation:wFlipOut .9s ease both}
`;

const preload = (url: string) => new Promise<void>((res) => { const im = new Image(); const t = setTimeout(res, 4000); im.onload = im.onerror = () => { clearTimeout(t); res(); }; im.src = url; });

/**
 * Photo wall display. Opens from an unguessable link, needs no login, and is sized in vmin/vh so one page fits a phone, a 22-inch kiosk or a 55-inch TV.
 * It keeps showing what it has if the network drops, and picks up again by itself (events: stream tick + a 5 second check).
 */
export default function WallDisplay() {
  const { token } = useParams<{ token: string }>();
  const API = `/api/v1/public/w/${token}`;
  const [info, setInfo] = useState<Info | null>(null); const [gone, setGone] = useState(false); const [offline, setOffline] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]); const [loaded, setLoaded] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [layers, setLayers] = useState<{ id: string; n: number }[]>([]);
  const [page, setPage] = useState(0);
  const [qr, setQr] = useState(""); const [idle, setIdle] = useState(false); const [fs, setFs] = useState(false);
  const [vp, setVp] = useState({ w: 1920, h: 1080 });
  const [spPage, setSpPage] = useState(0);

  const known = useRef<Set<string> | null>(null); const seen = useRef(new Set<string>());
  const infoRef = useRef<Info | null>(null); infoRef.current = info;
  const cur = useRef<string | null>(null); const counter = useRef(0); const shownQ = useRef<string[]>([]);
  const lastOk = useRef(Date.now());

  const big = useMemo(() => (typeof window !== "undefined" && window.innerWidth * (window.devicePixelRatio || 1) > 2600 ? 2400 : 1600), []);
  const img = (id: string, w: number) => `${API}/img/${id}?w=${w}`;
  const ids = useMemo(() => photos.map((p) => p.id), [photos]);
  const idsKey = ids.join(",");

  const queueShown = useCallback((list: string[]) => { shownQ.current.push(...list); if (shownQ.current.length > 300) shownQ.current.splice(0, shownQ.current.length - 300); }, []);

  // ----- data -----
  const loadInfo = useCallback(async () => {
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (r.status === 404) { setGone(true); return; }
      if (!r.ok) throw new Error();
      setInfo(await r.json()); setGone(false);
    } catch { /* keep what is on screen */ }
  }, [API]);

  const showSlide = useCallback(async (id: string) => {
    await preload(img(id, big));
    cur.current = id; seen.current.add(id); queueShown([id]);
    setLayers((l) => [...l.slice(-1), { id, n: ++counter.current }]);
    setTimeout(() => setLayers((l) => l.slice(-1)), 1100);
  }, [big, queueShown]);                                     // eslint-disable-line react-hooks/exhaustive-deps
  const showRef = useRef(showSlide); showRef.current = showSlide;

  const loadPhotos = useCallback(async () => {
    try {
      const r = await fetch(`${API}/photos`, { cache: "no-store" });
      if (r.status === 404) { setGone(true); return; }
      if (!r.ok) throw new Error();
      const j = (await r.json()) as { photos: Photo[] };
      lastOk.current = Date.now(); setOffline(false);
      setGone((g) => { if (g) loadInfo(); return false; });
      setPhotos(j.photos); setLoaded(true);
      const list = j.photos.map((p) => p.id);
      if (known.current === null) { known.current = new Set(list); return; }
      const added = list.find((i) => !known.current!.has(i));
      list.forEach((i) => known.current!.add(i));
      const secs = infoRef.current?.settings.style.highlightSeconds ?? 0;
      if (added && secs > 0) {
        setFresh(added); setTimeout(() => setFresh((f) => (f === added ? null : f)), secs * 1000);
        setPage(0);
        const m = infoRef.current?.settings.mode;
        if (m === "slideshow" || m === "random") showRef.current(added);          // announce the new picture right away
      }
    } catch { if (Date.now() - lastOk.current > 15000) setOffline(true); }
  }, [API, loadInfo]);

  useEffect(() => { loadInfo(); loadPhotos(); const a = setInterval(loadPhotos, 4000), b = setInterval(loadInfo, 30000); return () => { clearInterval(a); clearInterval(b); }; }, [loadInfo, loadPhotos]);
  useEffect(() => {                                           // report what was actually shown
    const t = setInterval(async () => {
      const batch = shownQ.current.splice(0, 50); if (!batch.length) return;
      try { const r = await fetch(`${API}/shown`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: batch }) }); if (!r.ok && r.status >= 500) throw new Error(); }
      catch { shownQ.current.unshift(...batch); }
    }, 10000);
    return () => clearInterval(t);
  }, [API]);

  // ----- screen behaviour -----
  useEffect(() => { const h = () => setVp({ w: window.innerWidth, h: window.innerHeight }); h(); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  useEffect(() => { const h = () => setFs(!!document.fullscreenElement); document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h); }, []);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>; const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3000); };
    wake(); window.addEventListener("mousemove", wake); window.addEventListener("keydown", wake); window.addEventListener("touchstart", wake);
    return () => { clearTimeout(t); window.removeEventListener("mousemove", wake); window.removeEventListener("keydown", wake); window.removeEventListener("touchstart", wake); };
  }, []);
  useEffect(() => {                                           // keep the TV awake where the browser allows it
    let lock: { release: () => Promise<void> } | null = null;
    const get = async () => { try { lock = await (navigator as any).wakeLock?.request("screen"); } catch { /* not supported or refused */ } };
    get(); const v = () => { if (document.visibilityState === "visible") get(); }; document.addEventListener("visibilitychange", v);
    return () => { document.removeEventListener("visibilitychange", v); lock?.release().catch(() => {}); };
  }, []);
  useEffect(() => { if (info?.settings.style.showJoinQr) QRCode.toDataURL(`${window.location.origin}${info.joinPath}`, { width: 600, margin: 1 }).then(setQr).catch(() => {}); }, [info?.joinPath, info?.settings.style.showJoinQr]);

  const sponsorList = info?.sponsors ?? [];
  const SP_PER = 4; const spPages = Math.max(1, Math.ceil(sponsorList.length / SP_PER));
  useEffect(() => { if (spPages < 2) { setSpPage(0); return; } const t = setInterval(() => setSpPage((p) => (p + 1) % spPages), 8000); return () => clearInterval(t); }, [spPages]);
  const mode = info?.settings.mode ?? "slideshow"; const secs = info?.settings.displaySeconds ?? 6; const st = info?.settings.style;

  // ----- slideshow / random rotation -----
  useEffect(() => {
    if (!(mode === "slideshow" || mode === "random") || !ids.length) return;
    const advance = () => { const n = nextSlide(ids, cur.current, seen.current, Math.random, mode === "random" ? "random" : "sequential"); if (n) showRef.current(n); };
    if (!cur.current || !ids.includes(cur.current)) advance();      // first picture, or the one on screen was taken away
    const t = setInterval(advance, secs * 1000);
    return () => clearInterval(t);
  }, [mode, secs, idsKey]);                                          // eslint-disable-line react-hooks/exhaustive-deps

  // ----- grid paging -----
  const cols = st?.gridColumns ?? 4;
  const headH = st?.showHeader ? vp.h * 0.12 : 0;
  const cell = (vp.w * 0.96 - (cols - 1) * vp.h * 0.01) / cols;
  const rows = Math.max(1, Math.round((vp.h - headH - vp.h * 0.04) / (cell + vp.h * 0.01)));   // rows then stretch to fill the height exactly
  const perPage = cols * rows; const pages = Math.max(1, Math.ceil(ids.length / perPage));
  useEffect(() => { if (mode !== "grid" || pages < 2) { setPage(0); return; } const t = setInterval(() => setPage((p) => (p + 1) % pages), secs * 1000); return () => clearInterval(t); }, [mode, pages, secs]);
  const gridIds = mode === "grid" ? ids.slice(page * perPage, (page + 1) * perPage) : [];
  const gridKey = gridIds.join(",");
  useEffect(() => { if (gridIds.length) queueShown(gridIds); }, [gridKey]);                 // eslint-disable-line react-hooks/exhaustive-deps
  const latestId = mode === "latest" ? ids[0] : undefined;
  useEffect(() => { if (latestId) queueShown([latestId]); }, [latestId, queueShown]);

  if (gone) return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b1220", color: "#cbd5e1", fontFamily: "system-ui", textAlign: "center", padding: 24 }}><div><h1 style={{ fontSize: "5vmin" }}>The photo wall is not active</h1><p style={{ fontSize: "2.4vmin" }}>It is switched off, the event is not live, or this link was replaced. This screen checks again by itself.</p></div></div>;
  if (!info || !st) return <div style={{ minHeight: "100vh", background: "#0b1220" }} />;

  const bg = st.background.type === "gradient" ? `linear-gradient(${st.background.angle}deg, ${st.background.from}, ${st.background.to})` : st.background.color;
  const tile = (id: string, size: number, extra: React.CSSProperties = {}) => (
    <div key={id} style={{ position: "relative", overflow: "hidden", borderRadius: "1vmin", background: "rgba(255,255,255,.06)", ...extra, outline: fresh === id ? `0.6vmin solid ${st.accentColor}` : undefined }}>
      <img src={img(id, size)} alt="" style={{ width: "100%", height: "100%", objectFit: st.fit, display: "block" }} />
      {fresh === id && <Badge color={st.accentColor} />}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: bg, color: st.textColor, fontFamily: FONT_STACKS[st.fontFamily], cursor: idle ? "none" : "default", perspective: "160vmin" }}>
      <style>{CSS}</style>

      {st.showHeader && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: "12vh", display: "flex", alignItems: "center", gap: "2vmin", padding: "0 3vmin", zIndex: 3 }}>
          {st.showEventLogo && info.logos.event && <img src={`${API}/logo/event`} alt="" style={{ maxHeight: "9vh", maxWidth: "22vw", objectFit: "contain" }} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            {st.showEventName && <div style={{ fontSize: "4.2vmin", fontWeight: 700, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{info.event.name}</div>}
            {st.headline && <div style={{ fontSize: "2.4vmin", opacity: .85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.headline}</div>}
          </div>
          {st.showHashtag && info.event.hashtag && <div style={{ fontSize: "4vmin", fontWeight: 700, color: st.accentColor }}>{info.event.hashtag.startsWith("#") ? info.event.hashtag : `#${info.event.hashtag}`}</div>}
          {st.showClientLogo && info.logos.client && <img src={`${API}/logo/client`} alt="" style={{ maxHeight: "9vh", maxWidth: "18vw", objectFit: "contain" }} />}
        </div>
      )}

      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: st.showHeader ? "12vh" : 0, padding: "2vh 2vw" }}>
        {loaded && !ids.length && (
          <div style={{ height: "100%", display: "grid", placeItems: "center", textAlign: "center" }}>
            <div><div style={{ fontSize: "7vmin", fontWeight: 700 }}>Waiting for the first photo…</div>{st.headline && <div style={{ fontSize: "3.4vmin", opacity: .85, marginTop: "1.5vmin" }}>{st.headline}</div>}</div>
          </div>
        )}

        {(mode === "slideshow" || mode === "random") && ids.length > 0 && (
          <div style={{ position: "relative", width: "100%", height: "100%" }}>
            {layers.map((l, i) => {
              const last = i === layers.length - 1;
              return (
                <div key={l.n} className={`w-${st.transition}-${last ? "in" : "out"}`} style={{ position: "absolute", inset: 0 }}>
                  <img src={img(l.id, big)} alt="" style={{ width: "100%", height: "100%", objectFit: st.fit, borderRadius: "1.2vmin", boxShadow: st.fit === "contain" ? "0 1vmin 4vmin rgba(0,0,0,.35)" : undefined }} />
                  {last && fresh === l.id && <Badge color={st.accentColor} />}
                </div>
              );
            })}
          </div>
        )}

        {mode === "grid" && ids.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: "1vh", height: "100%" }}>
            {gridIds.map((id) => tile(id, 800))}
          </div>
        )}

        {mode === "latest" && ids.length > 0 && (
          <div style={{ display: "flex", gap: "2vmin", height: "100%" }}>
            <div style={{ flex: "1 1 62%", minWidth: 0 }}>{tile(ids[0], big, { width: "100%", height: "100%" })}</div>
            {ids.length > 1 && <div style={{ flex: "1 1 38%", display: "grid", gridTemplateColumns: "1fr 1fr", gridAutoRows: "1fr", gap: "1.2vmin", minWidth: 0, paddingBottom: qr && st.showJoinQr ? "18vmin" : 0 }}>{ids.slice(1, 7).map((id) => tile(id, 800))}</div>}
          </div>
        )}
      </div>

      {sponsorList.length > 0 && (
        <div style={{ position: "absolute", left: "2vmin", bottom: "2vmin", zIndex: 4, display: "flex", alignItems: "center", gap: "2.5vmin", background: "rgba(255,255,255,.92)", color: "#111", borderRadius: "1.4vmin", padding: "1vmin 2.2vmin", maxWidth: "70vw" }}>
          <div style={{ fontSize: "1.7vmin", fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", opacity: .7 }}>Presented by</div>
          {sponsorList.slice(spPage * SP_PER, (spPage + 1) * SP_PER).map((s) => <img key={s.id} src={`${API}/sponsor/${s.id}/logo`} alt={s.name} style={{ height: "7vmin", maxWidth: "18vmin", objectFit: "contain" }} />)}
        </div>
      )}
      {qr && st.showJoinQr && (
        <div style={{ position: "absolute", right: "2vmin", bottom: "2vmin", zIndex: 4, background: "#fff", color: "#111", borderRadius: "1.4vmin", padding: "1vmin", textAlign: "center", boxShadow: "0 1vmin 3vmin rgba(0,0,0,.4)" }}>
          <img src={qr} alt="Scan to join" style={{ width: "15vmin", height: "15vmin", display: "block" }} />
          <div style={{ fontSize: "1.8vmin", fontWeight: 700 }}>Scan to join</div>
        </div>
      )}
      {offline && <div style={{ position: "absolute", left: "2vmin", bottom: "2vmin", zIndex: 4, fontSize: "1.8vmin", background: "rgba(0,0,0,.55)", color: "#fff", padding: ".6vmin 1.4vmin", borderRadius: 99 }}>Reconnecting…</div>}
      {!idle && (
        <button onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}))}
          style={{ position: "absolute", right: "2vmin", top: "1.6vmin", zIndex: 5, fontSize: "2vmin", padding: ".8vmin 1.8vmin", borderRadius: 8, border: "1px solid rgba(255,255,255,.4)", background: "rgba(0,0,0,.5)", color: "#fff", cursor: "pointer" }}>
          {fs ? "Exit full screen" : "Full screen"}
        </button>
      )}
    </div>
  );
}

function Badge({ color }: { color: string }) {
  return <div style={{ position: "absolute", left: "2vmin", top: "2vmin", background: color, color: "#111", fontWeight: 800, fontSize: "3vmin", padding: ".6vmin 2vmin", borderRadius: 99, animation: "wPulse 1.2s ease-in-out infinite", zIndex: 2 }}>NEW!</div>;
}
