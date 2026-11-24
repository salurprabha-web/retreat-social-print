"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Small, dependency-free charts for the admin reports. Colours come from the validated reference palette (first four categorical slots,
 * light and dark steps) and are defined once as CSS custom properties; text always wears text tokens, never a series colour.
 * Every chart has: a legend, a hover layer (crosshair + tooltip), selective direct labels, and a table view.
 */
export const VIZ_CSS = `
.viz-root{color-scheme:light;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--grid:#e4e2da;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2e2e2b;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2e2e2b;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;}
.viz-root{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:14px 16px;}
.viz-title{font-weight:700;font-size:14px;margin:0 0 2px}.viz-sub{color:var(--ink2);font-size:12px;margin:0 0 10px}
.viz-legend{display:flex;flex-wrap:wrap;gap:6px 10px;margin:0 0 8px}
.viz-legend button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:99px;border:1px solid var(--grid);font-size:12px;color:var(--ink2)}
.viz-legend button[aria-pressed=true]{color:var(--ink);border-color:var(--ink2)}
.viz-legend button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.viz-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.viz-tip{position:absolute;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--grid);border-radius:8px;padding:7px 10px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.18);min-width:150px;z-index:5}
.viz-tip b{display:block;margin-bottom:3px}.viz-tip div{display:flex;justify-content:space-between;gap:14px}
.viz-tip i{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:6px}
.viz-table{width:100%;border-collapse:collapse;font-size:12px}.viz-table th,.viz-table td{padding:4px 8px;text-align:right;border-bottom:1px solid var(--grid)}.viz-table th:first-child,.viz-table td:first-child{text-align:left}
.viz-toggle{all:unset;cursor:pointer;font-size:12px;color:var(--ink2);text-decoration:underline;margin-top:6px;display:inline-block}
.viz-toggle:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
`;

export interface Series { key: string; label: string; slot: 1 | 2 | 3 | 4 }
const col = (slot: number) => `var(--s${slot})`;
const niceMax = (m: number) => { if (m <= 4) return 4; const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

export function LineChart<T extends { day: string }>({ title, sub, rows, series, height = 240 }: { title: string; sub?: string; rows: T[]; series: Series[]; height?: number }) {
  const [off, setOff] = useState<Set<string>>(new Set()); const [hover, setHover] = useState<number | null>(null); const [table, setTable] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);                                   // real pixel width, so text is never scaled down
  useEffect(() => { const el = wrap.current; if (!el) return; const ro = new ResizeObserver(() => setW(Math.max(300, Math.floor(el.clientWidth - 34)))); ro.observe(el); setW(Math.max(300, Math.floor(el.clientWidth - 34))); return () => ro.disconnect(); }, []);
  const H = height, L = 38, T = 12, B = 26; const wide = W >= 560; const Rr = wide ? 170 : 14;
  const on = series.filter((s) => !off.has(s.key));
  const max = useMemo(() => niceMax(Math.max(1, ...rows.flatMap((r) => on.map((s) => Number((r as any)[s.key]) || 0)))), [rows, on]);
  const x = (i: number) => L + (rows.length <= 1 ? (W - L - Rr) / 2 : (i * (W - L - Rr)) / (rows.length - 1));
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W;
    if (!rows.length) return;
    setHover(Math.max(0, Math.min(rows.length - 1, Math.round(((px - L) / (W - L - Rr)) * (rows.length - 1)))));
  };
  // direct labels at the last point, nudged apart so they never collide
  const ends = on.map((s) => ({ s, y: y(Number((rows[rows.length - 1] as any)?.[s.key]) || 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const floor = H - B + 4;                                          // keep every label inside the plot: push the stack back up if it ran past the bottom
  if (ends.length && ends[ends.length - 1].y > floor) { ends[ends.length - 1].y = floor; for (let i = ends.length - 2; i >= 0; i--) if (ends[i].y > ends[i + 1].y - 14) ends[i].y = ends[i + 1].y - 14; }
  const hov = hover !== null ? rows[hover] : null;

  return (
    <div className="viz-root" ref={wrap} style={{ position: "relative" }}>
      <h3 className="viz-title">{title}</h3>{sub && <p className="viz-sub">{sub}</p>}
      {series.length > 1 && <div className="viz-legend" role="group" aria-label="Series">
        {series.map((s) => <button key={s.key} aria-pressed={!off.has(s.key)} onClick={() => setOff((o) => { const n = new Set(o); n.has(s.key) ? n.delete(s.key) : n.add(s.key); return n; })}><i style={{ background: col(s.slot), opacity: off.has(s.key) ? .3 : 1 }} />{s.label}</button>)}
      </div>}
      {!table ? (
        <>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }} role="img" aria-label={`${title}. Use the table view for exact values.`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => <g key={t}><line x1={L} x2={W - Rr} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink2)">{t}</text></g>)}
            {rows.map((r, i) => i % labelEvery === 0 || i === rows.length - 1 ? <text key={r.day} x={x(i)} y={H - 7} textAnchor="middle" fontSize={11} fill="var(--ink2)">{r.day.slice(5)}</text> : null)}
            {on.map((s) => (
              <g key={s.key}>
                <polyline fill="none" stroke={col(s.slot)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={rows.map((r, i) => `${x(i)},${y(Number((r as any)[s.key]) || 0)}`).join(" ")} />
                {rows.length === 1 && <circle cx={x(0)} cy={y(Number((rows[0] as any)[s.key]) || 0)} r={4} fill={col(s.slot)} />}
              </g>
            ))}
            {wide && ends.map(({ s, y: yy }) => <g key={s.key}><circle cx={W - Rr + 10} cy={yy - 4} r={4} fill={col(s.slot)} /><text x={W - Rr + 18} y={yy} fontSize={11} fill="var(--ink)">{s.label} {Number((rows[rows.length - 1] as any)?.[s.key]) || 0}</text></g>)}
            {hov && <g>
              <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} stroke="var(--ink2)" strokeWidth={1} strokeDasharray="3 3" />
              {on.map((s) => <circle key={s.key} cx={x(hover!)} cy={y(Number((hov as any)[s.key]) || 0)} r={5} fill={col(s.slot)} stroke="var(--surface)" strokeWidth={2} />)}
            </g>}
          </svg>
          {hov && (
            <div className="viz-tip" style={{ left: `clamp(8px, calc(${(x(hover!) / W) * 100}% - 70px), calc(100% - 180px))`, top: 52 }} role="status">
              <b>{hov.day}</b>{on.map((s) => <div key={s.key}><span><i style={{ background: col(s.slot) }} />{s.label}</span><b style={{ margin: 0 }}>{Number((hov as any)[s.key]) || 0}</b></div>)}
            </div>
          )}
        </>
      ) : (
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          <table className="viz-table"><thead><tr><th>Day</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r.day}><td>{r.day}</td>{series.map((s) => <td key={s.key}>{Number((r as any)[s.key]) || 0}</td>)}</tr>)}</tbody></table>
        </div>
      )}
      <button className="viz-toggle" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show as table"}</button>
    </div>
  );
}

export function FunnelChart({ title, sub, steps }: { title: string; sub?: string; steps: { key: string; label: string; count: number; pct: number }[] }) {
  const [hover, setHover] = useState<string | null>(null); const [table, setTable] = useState(false);
  const top = Math.max(1, ...steps.map((s) => s.count));
  return (
    <div className="viz-root" style={{ position: "relative" }}>
      <h3 className="viz-title">{title}</h3>{sub && <p className="viz-sub">{sub}</p>}
      {!table ? (
        <div role="img" aria-label={`${title}: ${steps.map((s) => `${s.label} ${s.count}`).join(", ")}`}>
          {steps.map((s, i) => {
            const prev = i ? steps[i - 1].count : null;
            return (
              <div key={s.key} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)} style={{ display: "grid", gridTemplateColumns: "150px 1fr 110px", alignItems: "center", gap: 10, padding: "5px 0", opacity: hover && hover !== s.key ? .6 : 1 }}>
                <span style={{ fontSize: 13 }}>{s.label}</span>
                <span style={{ background: "var(--grid)", borderRadius: "0 4px 4px 0", height: 14, display: "block" }}>
                  <span style={{ display: "block", height: 14, width: `${(s.count / top) * 100}%`, minWidth: s.count ? 3 : 0, background: "var(--s1)", borderRadius: "0 4px 4px 0", transition: "width .4s" }} />
                </span>
                <span style={{ fontSize: 13, textAlign: "right" }}><b>{s.count.toLocaleString()}</b> <span style={{ color: "var(--ink2)" }}>{s.pct}%</span></span>
                {hover === s.key && prev !== null && <span className="viz-tip" style={{ position: "static", gridColumn: "1 / -1", boxShadow: "none" }}>{prev ? `${Math.round((s.count / prev) * 1000) / 10}% of the previous step` : "No guests in the previous step"}</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <table className="viz-table"><thead><tr><th>Step</th><th>Guests</th><th>% of guests started</th></tr></thead><tbody>{steps.map((s) => <tr key={s.key}><td>{s.label}</td><td>{s.count}</td><td>{s.pct}%</td></tr>)}</tbody></table>
      )}
      <button className="viz-toggle" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show as table"}</button>
    </div>
  );
}
