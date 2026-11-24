"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  FONTS, FONT_META, FRAME_FORMATS, FORMAT_KEYS, PRESETS, PRESET_LABEL, frameSize, newLayer, newLayerId, presetLayers,
  type EventInfo, type FrameFormat, type FrameLayer, type LayerType,
} from "@rsp/shared";
import { api, type Me } from "../../../../../lib/api";
import { Shell } from "../../../../../components/Shell";
import { FrameCanvas, SAMPLE_PHOTO } from "../../../../../components/FrameCanvas";

interface Meta { name: string; format: FrameFormat; orientation: "portrait" | "landscape"; customW: number; customH: number; active: boolean; sponsorId: string | null }
interface ApiFrame { id: string; name: string; format: FrameFormat; orientation: "portrait" | "landscape"; widthPx: number; heightPx: number; active: boolean; sponsorId: string | null; updatedAt: string; layers: FrameLayer[] }
interface Evt { id: string; name: string }
interface Sp { id: string; name: string; hasLogo: boolean; active: boolean }
type Drag = { mode: "move" | "resize" | "rotate"; id: string; sx: number; sy: number; start: FrameLayer; hx: number; hy: number; moved: boolean };

const TYPES: [LayerType, string][] = [["photo", "Photo placeholder"], ["image", "Image / overlay"], ["text", "Text"], ["shape", "Shape"], ["logo", "Logo"]];
const rad = (d: number) => (d * Math.PI) / 180;
const pct = (n: number) => Math.round(n * 1000) / 10;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

function Designer({ me }: { me: Me }) {
  const { id, frameId } = useParams<{ id: string; frameId: string }>();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [layers, setLayers] = useState<FrameLayer[]>([]);
  const [updatedAt, setUpdatedAt] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [past, setPast] = useState<string[]>([]); const [future, setFuture] = useState<string[]>([]);
  const [preview, setPreview] = useState(false); const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [conflict, setConflict] = useState(false);
  const [ev, setEv] = useState<(EventInfo & { settings: { branding: { clientLogo?: string; eventLogo?: string } } }) | null>(null);
  const [others, setOthers] = useState<Evt[]>([]);
  const [sponsors, setSponsors] = useState<Sp[]>([]);
  const [avail, setAvail] = useState(600);
  const wrap = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null); const dragLayers = useRef<FrameLayer[]>([]);
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";
  const [layerDnd, setLayerDnd] = useState<string | null>(null);

  const apply = useCallback((f: ApiFrame) => {
    setMeta({ name: f.name, format: f.format, orientation: f.orientation, active: f.active, sponsorId: f.sponsorId ?? null, customW: f.format === "custom" ? Math.round((f.widthPx / 300) * 10) / 10 : 4, customH: f.format === "custom" ? Math.round((f.heightPx / 300) * 10) / 10 : 6 });
    setLayers(f.layers); setUpdatedAt(f.updatedAt); setDirty(false); setPast([]); setFuture([]); setConflict(false);
  }, []);
  const load = useCallback(async () => {
    try {
      apply((await api<{ frame: ApiFrame }>(`/api/v1/events/${id}/frames/${frameId}`)).frame);
      setEv((await api<{ event: any }>(`/api/v1/events/${id}`)).event);
      setSponsors((await api<{ sponsors: Sp[] }>(`/api/v1/events/${id}/sponsors`)).sponsors);
      if (role === "super_admin") setOthers((await api<{ events: Evt[] }>("/api/v1/events")).events.filter((e) => e.id !== id));
    } catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.status === 404 ? "Frame not found." : x.message); }
  }, [id, frameId, apply, role]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth)); ro.observe(el); setAvail(el.clientWidth); return () => ro.disconnect();
  }, [meta]);
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [dirty]);

  const size = useMemo(() => meta ? frameSize(meta.format, meta.orientation, meta.format === "custom" ? { wIn: meta.customW, hIn: meta.customH } : undefined) : { widthPx: 1200, heightPx: 1800 }, [meta]);
  const dispW = Math.max(160, Math.min(avail - 8, ((typeof window !== "undefined" ? window.innerHeight : 800) * 0.7 * size.widthPx) / size.heightPx));
  const dispH = (dispW * size.heightPx) / size.widthPx;
  const selLayer = layers.find((l) => l.id === sel) ?? null;

  const snapshot = useCallback(() => { setPast((p) => [...p.slice(-59), JSON.stringify({ meta, layers })]); setFuture([]); setDirty(true); }, [meta, layers]);
  const edit = useCallback((fn: (ls: FrameLayer[]) => FrameLayer[]) => { snapshot(); setLayers((ls) => fn(structuredClone(ls))); }, [snapshot]);
  const patch = (lid: string, p: Record<string, unknown>) => edit((ls) => ls.map((l) => (l.id === lid ? ({ ...l, ...p } as FrameLayer) : l)));
  const undo = () => setPast((p) => { if (!p.length) return p; setFuture((f) => [JSON.stringify({ meta, layers }), ...f]); const s = JSON.parse(p[p.length - 1]); setMeta(s.meta); setLayers(s.layers); setDirty(true); return p.slice(0, -1); });
  const redo = () => setFuture((f) => { if (!f.length) return f; setPast((p) => [...p, JSON.stringify({ meta, layers })]); const s = JSON.parse(f[0]); setMeta(s.meta); setLayers(s.layers); setDirty(true); return f.slice(1); });
  const changeMeta = (m: Partial<Meta>) => { snapshot(); setMeta((cur) => ({ ...cur!, ...m })); };

  function addLayer(type: LayerType) {
    const used = layers.filter((l) => l.type === "photo").map((l: any) => l.slot);
    const slot = [1, 2, 3, 4, 5, 6, 7, 8].find((n) => !used.includes(n));
    if (type === "photo" && !slot) { setErr("A frame can have up to 8 photo placeholders."); return; }
    const o = { x: 0.15, y: 0.15 };
    const l = newLayer(type, o, type === "photo" ? { slot, name: `Photo ${slot}` } : {});
    edit((ls) => [...ls, l]); setSel(l.id);
  }
  function applyPreset(p: string) {
    if (!p) return;
    if (layers.length && !confirm("Replace all layers with this starting layout?")) return;
    edit(() => presetLayers(p as any, size.widthPx, size.heightPx)); setSel(null);
  }

  /* ----- canvas pointer interaction ----- */
  const onDown = (e: React.PointerEvent, l: FrameLayer, mode: Drag["mode"], hx = 0, hy = 0) => {
    if (!canEdit || preview) return;
    e.stopPropagation(); e.preventDefault(); setSel(l.id);
    drag.current = { mode, id: l.id, sx: e.clientX, sy: e.clientY, start: structuredClone(l), hx, hy, moved: false };
    dragLayers.current = layers;
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current; const el = canvas.current; if (!d || !el) return;
      const r = el.getBoundingClientRect(); const W = r.width, H = r.height; const s = d.start;
      if (!d.moved) { d.moved = true; snapshot(); }
      let n: Partial<FrameLayer> = {};
      if (d.mode === "move") {
        let x = s.x + (e.clientX - d.sx) / W, y = s.y + (e.clientY - d.sy) / H; const g: { x?: number; y?: number } = {};
        if (snap) {
          const T = 0.012;
          for (const [edge, val] of [[x, 0], [x + s.w, 1], [x + s.w / 2, 0.5]] as const) if (Math.abs(edge - val) < T) { x += val - edge; g.x = val; break; }
          for (const [edge, val] of [[y, 0], [y + s.h, 1], [y + s.h / 2, 0.5]] as const) if (Math.abs(edge - val) < T) { y += val - edge; g.y = val; break; }
        }
        setGuides(g); n = { x, y };
      } else if (d.mode === "resize") {
        const th = rad(s.rotation), c = Math.cos(th), si = Math.sin(th);
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        const lx = dx * c + dy * si, ly = -dx * si + dy * c;                  // pointer delta in the layer's own axes
        const keep = s.type === "image" || s.type === "logo" || s.type === "photo";
        let wpx = Math.max(12, s.w * W + d.hx * lx), hpx = Math.max(12, s.h * H + d.hy * ly);
        if (keep && !e.shiftKey) { const ratio = (s.w * W) / (s.h * H); if (Math.abs(d.hx * lx) >= Math.abs(d.hy * ly) * ratio) hpx = wpx / ratio; else wpx = hpx * ratio; }
        const ddx = (wpx - s.w * W) * d.hx / 2, ddy = (hpx - s.h * H) * d.hy / 2; // centre moves by half the growth, in layer axes
        const cx = (s.x + s.w / 2) * W + ddx * c - ddy * si, cy = (s.y + s.h / 2) * H + ddx * si + ddy * c;
        n = { w: wpx / W, h: hpx / H, x: (cx - wpx / 2) / W, y: (cy - hpx / 2) / H };
      } else {
        const cx = r.left + (s.x + s.w / 2) * W, cy = r.top + (s.y + s.h / 2) * H;
        let a = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90; if (a > 180) a -= 360;
        const near = Math.round(a / 15) * 15; if (Math.abs(a - near) < 4) a = near;
        n = { rotation: Math.round(a * 10) / 10 };
      }
      setLayers((ls) => ls.map((l) => (l.id === d.id ? ({ ...l, ...n } as FrameLayer) : l)));
    };
    const up = () => { drag.current = null; setGuides({}); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [snap, snapshot]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || !canEdit) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z"))) { e.preventDefault(); redo(); return; }
      if (!sel) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeLayer(sel); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "d") { e.preventDefault(); duplicateLayer(sel); }
      else if (e.key.startsWith("Arrow")) { e.preventDefault(); const st = e.shiftKey ? 0.01 : 0.002; const l = layers.find((x) => x.id === sel); if (!l || l.locked) return;
        patch(sel, { x: l.x + (e.key === "ArrowRight" ? st : e.key === "ArrowLeft" ? -st : 0), y: l.y + (e.key === "ArrowDown" ? st : e.key === "ArrowUp" ? -st : 0) }); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  const removeLayer = (lid: string) => { edit((ls) => ls.filter((l) => l.id !== lid)); setSel(null); };
  const duplicateLayer = (lid: string) => {
    const src = layers.find((l) => l.id === lid); if (!src) return;
    const used = layers.filter((l) => l.type === "photo").map((l: any) => l.slot);
    const slot = [1, 2, 3, 4, 5, 6, 7, 8].find((n) => !used.includes(n));
    if (src.type === "photo" && !slot) { setErr("A frame can have up to 8 photo placeholders."); return; }
    const c: any = { ...structuredClone(src), id: newLayerId(), x: src.x + 0.03, y: src.y + 0.03 }; if (src.type === "photo") { c.slot = slot; c.name = `Photo ${slot}`; }
    edit((ls) => [...ls, c]); setSel(c.id);
  };
  const moveLayer = (lid: string, to: number) => edit((ls) => { const i = ls.findIndex((l) => l.id === lid); const [x] = ls.splice(i, 1); ls.splice(clamp(to, 0, ls.length), 0, x); return ls; });

  async function upload(file: File): Promise<string | null> {
    setErr("");
    const csrf = (await api<{ csrf: string }>("/api/v1/auth/me")).csrf;
    const res = await fetch(`/api/v1/events/${id}/frame-assets`, { method: "POST", credentials: "same-origin", body: file, headers: { "content-type": file.type || "application/octet-stream", "x-rsp-csrf": csrf } });
    if (!res.ok) { setErr(res.status === 422 ? "That SVG contains scripts or external references and was rejected." : "Upload failed: use a PNG (transparent works), JPG, WebP or safe SVG under 5 MB."); return null; }
    return (await res.json()).name;
  }
  async function save() {
    if (!meta) return; setBusy(true); setErr(""); setMsg("");
    try {
      const body: any = { name: meta.name, format: meta.format, orientation: meta.orientation, active: meta.active, sponsorId: meta.sponsorId, layers, expectedUpdatedAt: updatedAt };
      if (meta.format === "custom") { body.customWidthIn = meta.customW; body.customHeightIn = meta.customH; }
      apply((await api<{ frame: ApiFrame }>(`/api/v1/events/${id}/frames/${frameId}`, { method: "PUT", body })).frame); setMsg("Saved.");
    } catch (x: any) {
      if (x.message === "modified_elsewhere") { setConflict(true); setErr("Someone else saved this frame after you opened it. Reload to see their version (your unsaved changes will be lost), or copy your work first."); }
      else setErr(x.message === "validation" ? "Not saved: a frame needs at least one photo placeholder with a unique number, and values must be in range." : x.message);
    }
    setBusy(false);
  }
  async function copyTo(target: string) {
    if (!target) return;
    if (dirty && !confirm("Copy the last SAVED version (unsaved changes are not copied)?")) return;
    try { await api(`/api/v1/events/${id}/frames/${frameId}/copy-to/${target}`, { method: "POST" }); setMsg(`Copied to "${others.find((o) => o.id === target)?.name}".`); } catch (x: any) { setErr(x.message); }
  }
  async function duplicateFrame() {
    try { const r = await api<{ frame: { id: string } }>(`/api/v1/events/${id}/frames/${frameId}/duplicate`, { method: "POST" }); window.location.href = `/events/${id}/frames/${r.frame.id}`; } catch (x: any) { setErr(x.message); }
  }

  if (!meta) return err ? <div className="err">{err}</div> : null;
  const info: EventInfo = ev ?? { name: "Event", hashtag: null, eventDate: null, clientName: null };
  const logos = { event: !!ev?.settings.branding.eventLogo, client: !!ev?.settings.branding.clientLogo };
  const assetUrl = (n: string) => `/api/v1/events/${id}/frame-assets/${n}`;
  const photosSample = Object.fromEntries(layers.filter((l) => l.type === "photo").map((l: any) => [l.slot, SAMPLE_PHOTO]));
  const visible = layers.filter((l) => !l.hidden);
  const mySponsor = sponsors.find((s) => s.id === meta.sponsorId);
  const sponsorLogo = mySponsor?.hasLogo ? `/api/v1/events/${id}/sponsors/${mySponsor.id}/logo` : null;

  return (
    <>
      <a href={`/events/${id}/frames`} className="muted">&larr; All frames</a>
      <div className="bar">
        <input value={meta.name} disabled={!canEdit} onChange={(e) => changeMeta({ name: e.target.value })} style={{ width: 220 }} aria-label="Frame name" />
        <select disabled={!canEdit} value={meta.format} onChange={(e) => changeMeta({ format: e.target.value as FrameFormat })} style={{ width: "auto" }} aria-label="Paper size">{FORMAT_KEYS.map((k) => <option key={k} value={k}>{FRAME_FORMATS[k].label}</option>)}</select>
        {meta.format === "custom" && <><input type="number" step="0.1" min={1} max={12} style={{ width: 70 }} value={meta.customW} onChange={(e) => changeMeta({ customW: +e.target.value })} aria-label="Width in inches" />×<input type="number" step="0.1" min={1} max={12} style={{ width: 70 }} value={meta.customH} onChange={(e) => changeMeta({ customH: +e.target.value })} aria-label="Height in inches" />in</>}
        <select disabled={!canEdit} value={meta.orientation} onChange={(e) => changeMeta({ orientation: e.target.value as any })} style={{ width: "auto" }} aria-label="Orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>
        <span className="muted">{size.widthPx}×{size.heightPx}px @300 DPI</span>
        <label className="chk"><input type="checkbox" disabled={!canEdit} checked={meta.active} onChange={(e) => changeMeta({ active: e.target.checked })} /> Available to guests</label>
        <select disabled={!canEdit} value={meta.sponsorId ?? ""} onChange={(e) => changeMeta({ sponsorId: e.target.value || null })} style={{ width: "auto" }} aria-label="Sponsor of this frame"><option value="">No sponsor</option>{sponsors.map((s) => <option key={s.id} value={s.id}>Sponsor: {s.name}{s.active ? "" : " (off)"}</option>)}</select>
        <div className="inl" style={{ marginLeft: "auto" }}>
          <button className="mini" onClick={undo} disabled={!past.length}>Undo</button><button className="mini" onClick={redo} disabled={!future.length}>Redo</button>
          <button className={"mini" + (snap ? " primary" : "")} onClick={() => setSnap(!snap)}>Snap</button>
          <button className={"mini" + (preview ? " primary" : "")} onClick={() => { setPreview(!preview); setSel(null); }}>Preview</button>
          {canEdit && <><button className="mini" onClick={duplicateFrame}>Duplicate</button><button className="mini primary" onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : dirty ? "Save" : "Saved"}</button></>}
        </div>
      </div>
      {msg && <div className="ok" role="status">{msg}</div>}
      {err && <div className="err" role="alert">{err} {conflict && <button className="mini" onClick={load}>Reload</button>}</div>}
      {role === "super_admin" && others.length > 0 && <div className="inl muted" style={{ margin: "6px 0" }}>Use in another event: <select defaultValue="" onChange={(e) => { copyTo(e.target.value); e.target.value = ""; }} style={{ width: "auto" }} aria-label="Copy to event"><option value="">Copy this frame to…</option>{others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}

      <div className="builder" style={{ gridTemplateColumns: "240px minmax(0,1fr) 300px" }}>
        <aside className="lib">
          <h4>Add</h4>
          {TYPES.map(([t, label]) => <button key={t} className="libitem" disabled={!canEdit} onClick={() => addLayer(t)} style={{ cursor: "pointer" }}>+ {label}</button>)}
          <select disabled={!canEdit} value="" onChange={(e) => applyPreset(e.target.value)} style={{ marginTop: 6 }} aria-label="Starting layout"><option value="">Start from a layout…</option>{PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}</select>
          <h4>Layers (top first)</h4>
          {[...layers].reverse().map((l) => {
            const i = layers.indexOf(l);
            return (
              <div key={l.id} className={"lrow" + (sel === l.id ? " on" : "")} draggable={canEdit} onClick={() => setSel(l.id)}
                onDragStart={() => setLayerDnd(l.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (layerDnd && layerDnd !== l.id) moveLayer(layerDnd, layers.findIndex((x) => x.id === l.id)); setLayerDnd(null); }}>
                <button className="mini" title={l.hidden ? "Show" : "Hide"} aria-label={l.hidden ? "Show layer" : "Hide layer"} disabled={!canEdit} onClick={(e) => { e.stopPropagation(); patch(l.id, { hidden: !l.hidden }); }}>{l.hidden ? "◌" : "●"}</button>
                <button className="mini" title={l.locked ? "Unlock" : "Lock"} aria-label={l.locked ? "Unlock layer" : "Lock layer"} disabled={!canEdit} onClick={(e) => { e.stopPropagation(); patch(l.id, { locked: !l.locked }); }}>{l.locked ? "🔒" : "🔓"}</button>
                <span className="lname">{l.name || (l.type === "photo" ? `Photo ${(l as any).slot}` : l.type === "text" ? (l as any).text : l.type)}</span>
                <button className="mini" aria-label="Move layer up" disabled={!canEdit || i === layers.length - 1} onClick={(e) => { e.stopPropagation(); moveLayer(l.id, i + 1); }}>↑</button>
                <button className="mini" aria-label="Move layer down" disabled={!canEdit || i === 0} onClick={(e) => { e.stopPropagation(); moveLayer(l.id, i - 1); }}>↓</button>
              </div>
            );
          })}
          {!layers.length && <p className="muted">No layers.</p>}
        </aside>

        <section className="center">
          <div ref={wrap} className="stage" style={{ display: "grid", placeItems: "center", padding: 12 }}>
            <div ref={canvas} style={{ position: "relative", width: dispW, height: dispH, boxShadow: "0 4px 24px rgba(0,0,0,.25)", touchAction: "none" }}
              onPointerDown={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
              <FrameCanvas widthPx={size.widthPx} heightPx={size.heightPx} layers={layers} event={info} displayWidth={dispW} assetUrl={assetUrl}
                logoUrl={(k) => (logos[k] ? `/api/v1/events/${id}/logo/${k}` : null)} sponsorLogo={sponsorLogo} photos={preview ? photosSample : {}} showPlaceholders />
              {!preview && visible.map((l) => !l.locked && (
                <div key={l.id} onPointerDown={(e) => onDown(e, l, "move")} style={{ position: "absolute", left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: `${l.w * 100}%`, height: `${l.h * 100}%`, transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined, cursor: canEdit ? "move" : "default" }} />
              ))}
              {!preview && selLayer && !selLayer.hidden && (
                <div style={{ position: "absolute", left: `${selLayer.x * 100}%`, top: `${selLayer.y * 100}%`, width: `${selLayer.w * 100}%`, height: `${selLayer.h * 100}%`, transform: selLayer.rotation ? `rotate(${selLayer.rotation}deg)` : undefined, outline: "2px solid #3b82f6", pointerEvents: "none" }}>
                  {canEdit && !selLayer.locked && <>
                    {([[-1, -1, 0, 0], [1, -1, 100, 0], [-1, 1, 0, 100], [1, 1, 100, 100]] as const).map(([hx, hy, lx, ty]) => (
                      <div key={`${hx}${hy}`} onPointerDown={(e) => onDown(e, selLayer, "resize", hx, hy)} style={{ position: "absolute", left: `${lx}%`, top: `${ty}%`, width: 14, height: 14, marginLeft: -7, marginTop: -7, background: "#fff", border: "2px solid #3b82f6", borderRadius: 3, pointerEvents: "auto", cursor: hx * hy > 0 ? "nwse-resize" : "nesw-resize" }} />
                    ))}
                    <div onPointerDown={(e) => onDown(e, selLayer, "rotate")} title="Rotate" style={{ position: "absolute", left: "50%", top: -28, width: 16, height: 16, marginLeft: -8, background: "#3b82f6", borderRadius: "50%", pointerEvents: "auto", cursor: "grab" }} />
                    <div style={{ position: "absolute", left: "50%", top: -14, width: 2, height: 14, background: "#3b82f6", marginLeft: -1 }} />
                  </>}
                </div>
              )}
              {guides.x !== undefined && <div style={{ position: "absolute", left: `${guides.x * 100}%`, top: 0, bottom: 0, width: 1, background: "#ec4899", pointerEvents: "none" }} />}
              {guides.y !== undefined && <div style={{ position: "absolute", top: `${guides.y * 100}%`, left: 0, right: 0, height: 1, background: "#ec4899", pointerEvents: "none" }} />}
            </div>
          </div>
          <p className="muted">Drag layers to move, drag corner handles to resize (hold Shift to stretch photos and images), drag the top dot to rotate. Arrow keys nudge, Delete removes, Ctrl+Z / Ctrl+Y undo and redo.</p>
        </section>

        <aside className="props">
          {selLayer ? <LayerProps hasSponsor={!!mySponsor} l={selLayer} canEdit={canEdit} patch={(p) => patch(selLayer.id, p)} upload={upload} assetUrl={assetUrl}
            onRemove={() => removeLayer(selLayer.id)} onDuplicate={() => duplicateLayer(selLayer.id)} />
            : <p className="muted">Select a layer on the canvas or in the list to edit it.</p>}
        </aside>
      </div>
    </>
  );
}

function LayerProps({ l, canEdit, patch, upload, assetUrl, onRemove, onDuplicate, hasSponsor }: {
  l: FrameLayer; canEdit: boolean; patch: (p: Record<string, unknown>) => void; upload: (f: File) => Promise<string | null>; assetUrl: (n: string) => string; onRemove: () => void; onDuplicate: () => void; hasSponsor: boolean;
}) {
  const num = (label: string, v: number, set: (n: number) => void, step = 0.5, min = -25, max = 150) => (
    <div className="prow"><label>{label}</label><input type="number" step={step} min={min} max={max} value={pct(v)} onChange={(e) => set(clamp(Number(e.target.value) / 100, min / 100, max / 100))} /></div>
  );
  const col = (label: string, v: string, set: (s: string) => void) => <div className="prow"><label>{label}</label><input type="color" className="swatch" value={v} onChange={(e) => set(e.target.value)} /></div>;
  return (
    <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
      <h3 className="ph3">{l.type}</h3>
      <div className="prow"><label>Layer name</label><input value={l.name ?? ""} maxLength={60} onChange={(e) => patch({ name: e.target.value })} /></div>
      <div className="grid2">{num("X (%)", l.x, (n) => patch({ x: n }))}{num("Y (%)", l.y, (n) => patch({ y: n }))}{num("Width (%)", l.w, (n) => patch({ w: Math.max(0.005, n) }), 0.5, 0.5, 150)}{num("Height (%)", l.h, (n) => patch({ h: Math.max(0.005, n) }), 0.5, 0.5, 150)}</div>
      <div className="prow"><label>Rotation ({Math.round(l.rotation)}°)</label><input type="range" min={-180} max={180} value={l.rotation} onChange={(e) => patch({ rotation: Number(e.target.value) })} /></div>
      <div className="prow"><label>Opacity ({Math.round(l.opacity * 100)}%)</label><input type="range" min={0} max={100} value={Math.round(l.opacity * 100)} onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })} /></div>
      {l.type === "photo" && <>
        <div className="prow"><label>Placeholder number (photo order)</label><input type="number" min={1} max={8} value={l.slot} onChange={(e) => patch({ slot: clamp(Math.round(Number(e.target.value)), 1, 8) })} /></div>
        <div className="prow"><label>Rounded corners ({Math.round(l.radius * 100)}%)</label><input type="range" min={0} max={50} value={Math.round(l.radius * 100)} onChange={(e) => patch({ radius: Number(e.target.value) / 100 })} /></div>
        {col("Border colour", l.borderColor ?? "#ffffff", (s) => patch({ borderColor: s, borderWidth: l.borderWidth || 0.01 }))}
        <div className="prow"><label>Border width ({(l.borderWidth * 100).toFixed(1)}%)</label><input type="range" min={0} max={50} value={Math.round(l.borderWidth * 1000)} onChange={(e) => patch({ borderWidth: Number(e.target.value) / 1000, borderColor: l.borderColor ?? "#ffffff" })} /></div>
      </>}
      {l.type === "image" && <>
        <div className="prow"><label>Image (transparent PNG works best)</label>
          {l.src && <img className="thumb" src={assetUrl(l.src)} alt="" />}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={async (e) => { const n = e.target.files?.[0] && await upload(e.target.files[0]); if (n) patch({ src: n }); e.target.value = ""; }} />
          {l.src && <button className="mini" onClick={() => patch({ src: null })}>Remove image</button>}</div>
        <div className="prow"><label>Fit</label><select value={l.fit} onChange={(e) => patch({ fit: e.target.value })}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></div>
      </>}
      {l.type === "text" && <>
        <div className="prow"><label>Text (tokens: {"{{event.name}} {{event.hashtag}} {{event.date}} {{event.client}}"})</label><textarea rows={3} maxLength={200} value={l.text} onChange={(e) => patch({ text: e.target.value })} /></div>
        <div className="prow"><label>Font</label><select value={l.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></div>
        <div className="prow"><label>Size ({l.sizePct}% of height)</label><input type="range" min={1} max={20} step={0.1} value={l.sizePct} onChange={(e) => patch({ sizePct: Number(e.target.value) })} /></div>
        {col("Colour", l.color, (s) => patch({ color: s }))}
        <div className="inl"><label className="chk"><input type="checkbox" disabled={!FONT_META[l.fontFamily].bold} checked={l.bold && FONT_META[l.fontFamily].bold} onChange={(e) => patch({ bold: e.target.checked })} />Bold</label><label className="chk"><input type="checkbox" disabled={!FONT_META[l.fontFamily].italic} checked={l.italic && FONT_META[l.fontFamily].italic} onChange={(e) => patch({ italic: e.target.checked })} />Italic</label>
          <select value={l.align} onChange={(e) => patch({ align: e.target.value })} style={{ width: "auto" }} aria-label="Alignment"><option>left</option><option>center</option><option>right</option></select></div>
      </>}
      {l.type === "shape" && <>
        <div className="prow"><label>Shape</label><select value={l.shape} onChange={(e) => patch({ shape: e.target.value })}><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select></div>
        {col("Fill", l.fill, (s) => patch({ fill: s }))}
        <div className="prow"><label>Rounded corners ({Math.round(l.radius * 100)}%)</label><input type="range" min={0} max={50} value={Math.round(l.radius * 100)} onChange={(e) => patch({ radius: Number(e.target.value) / 100 })} /></div>
      </>}
      {l.type === "logo" && <div className="prow"><label>Which logo (upload under Branding or Sponsors)</label><select value={l.which} onChange={(e) => patch({ which: e.target.value })}><option value="event">Event logo</option><option value="client">Client logo</option><option value="sponsor">Frame's sponsor logo</option></select>{l.which === "sponsor" && !hasSponsor && <div className="muted">Choose a sponsor for this frame in the bar above, and upload its logo under Sponsors.</div>}</div>}
      <div className="inl" style={{ marginTop: 12 }}><button className="mini" onClick={onDuplicate}>Duplicate</button><button className="mini danger" onClick={onRemove}>Delete layer</button></div>
    </fieldset>
  );
}

export default function FramePage() { return <Shell active="events">{(me) => <Designer me={me} />}</Shell>; }
