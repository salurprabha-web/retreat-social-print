"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { coverLayout, offsetsFor, NO_ADJUST, type PhotoAdjust, type Theme } from "@rsp/shared";

const ASPECT = 1.5;   // 2:3 portrait preview; the real frame shape arrives with frames (Phase 6)

/** Pan (drag), zoom (pinch / wheel / slider), rotate. Uses the same placement maths as the print composition. */
export function PhotoEditor({ src, width, height, adjust, onChange, button }: {
  src: string; width: number; height: number; adjust: PhotoAdjust; onChange: (a: PhotoAdjust) => void; button: Theme["button"];
}) {
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const last = useRef<{ dist: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const L = coverLayout(width, height, adjust, ASPECT);
  const set = useCallback((p: Partial<PhotoAdjust>) => onChange({ ...adjust, ...p }), [adjust, onChange]);

  function onDown(e: React.PointerEvent) {
    box.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; last.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) }; }
    setDragging(true);
  }
  function onMove(e: React.PointerEvent) {
    const p = pointers.current.get(e.pointerId); if (!p || !box.current) return;
    const w = box.current.getBoundingClientRect().width || 1;
    const dx = (e.clientX - p.x) / w, dy = (e.clientY - p.y) / w;   // box widths, independent of any page zoom
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && last.current) {
      const [a, b] = [...pointers.current.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      const z = Math.min(5, Math.max(1, adjust.zoom * (d / last.current.dist))); last.current = { dist: d };
      const nl = coverLayout(width, height, { ...adjust, zoom: z }, ASPECT);
      onChange({ ...adjust, zoom: z, ...offsetsFor(nl, nl.left, nl.top) }); return;
    }
    if (pointers.current.size === 1) onChange({ ...adjust, ...offsetsFor(L, L.left + dx, L.top + dy) });
  }
  function onUp(e: React.PointerEvent) { pointers.current.delete(e.pointerId); last.current = null; if (!pointers.current.size) setDragging(false); }
  useEffect(() => {
    const el = box.current; if (!el) return;
    const w = (e: WheelEvent) => { e.preventDefault(); set({ zoom: Math.min(5, Math.max(1, adjust.zoom * (e.deltaY < 0 ? 1.08 : 0.92))) }); };
    el.addEventListener("wheel", w, { passive: false }); return () => el.removeEventListener("wheel", w);
  }, [adjust.zoom, set]);

  const quarter = adjust.rotate % 180 !== 0;
  const cx = ((L.left + L.drawW / 2) * 100), cy = ((L.top + L.drawH / 2) / ASPECT) * 100;
  const b = { background: "transparent", color: "inherit", border: `1px solid ${button.color}`, borderRadius: 8, padding: "8px 14px", width: "auto", margin: 0, cursor: "pointer", fontSize: ".9em" } as const;
  return (
    <div style={{ width: "min(100%, 26em)" }}>
      <div ref={box} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ position: "relative", width: "100%", aspectRatio: "2 / 3", overflow: "hidden", borderRadius: 10, background: "#000", touchAction: "none", cursor: dragging ? "grabbing" : "grab", boxShadow: "0 6px 24px rgba(0,0,0,.35)" }}
        role="img" aria-label="Your photo. Drag to move, pinch or scroll to zoom.">
        <img src={src} alt="" draggable={false} style={{ position: "absolute", left: `${cx}%`, top: `${cy}%`, width: `${(quarter ? L.drawH : L.drawW) * 100}%`, maxWidth: "none",
          transform: `translate(-50%, -50%) rotate(${adjust.rotate}deg)`, userSelect: "none", pointerEvents: "none" }} />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <button type="button" style={b} onClick={() => set({ zoom: Math.max(1, adjust.zoom - 0.25) })} aria-label="Zoom out">−</button>
        <input type="range" min={1} max={5} step={0.01} value={adjust.zoom} aria-label="Zoom" style={{ flex: "1 1 8em", maxWidth: "14em", padding: 0, width: "auto" }}
          onChange={(e) => { const z = Number(e.target.value); const nl = coverLayout(width, height, { ...adjust, zoom: z }, ASPECT); onChange({ ...adjust, zoom: z, ...offsetsFor(nl, nl.left, nl.top) }); }} />
        <button type="button" style={b} onClick={() => set({ zoom: Math.min(5, adjust.zoom + 0.25) })} aria-label="Zoom in">+</button>
        <button type="button" style={b} onClick={() => set({ rotate: (((adjust.rotate + 90) % 360) as PhotoAdjust["rotate"]), offsetX: 0, offsetY: 0 })}>Rotate</button>
        <button type="button" style={b} onClick={() => onChange(NO_ADJUST)}>Reset</button>
      </div>
    </div>
  );
}
