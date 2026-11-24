"use client";
import { useRef, type ReactNode } from "react";
import {
  DEVICES, DEVICE_INFO, FIELD_TYPES, FONTS, PROP_FIELDS, newId,
  type Device, type PageComponent, type PageDefinition, type PropField, type StepId,
} from "@rsp/shared";

type Set = (fn: (d: PageDefinition) => void) => void;   // mutate a draft copy of the definition

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="prow"><label>{label}</label>{children}</div>;
}
const Color = ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
  <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} className="swatch" />;
const Sel = ({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (v: string) => void }) =>
  <select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select>;
const Num = ({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) =>
  <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} />;

/* ---------- Selected component ---------- */
export function ComponentPanel({ comp, device, index, count, set, upload, assetUrl }: {
  comp: PageComponent; device: Device; index: number; count: number; set: Set;
  upload: (f: File) => Promise<string | null>; assetUrl: (n: string) => string;
}) {
  const upd = (fn: (c: PageComponent) => void) => set((d) => { const c = d.welcome.components.find((x) => x.id === comp.id); if (c) fn(c); });
  const move = (to: number) => set((d) => { const a = d.welcome.components; const [c] = a.splice(index, 1); a.splice(to, 0, c); });
  const fileRef = useRef<HTMLInputElement>(null);
  const field = (f: PropField) => {
    const v = comp.props[f.key];
    const setv = (x: string | number | boolean) => upd((c) => { c.props[f.key] = x; });
    if (f.kind === "textarea") return <textarea rows={4} value={String(v ?? "")} maxLength={1000} onChange={(e) => setv(e.target.value)} />;
    if (f.kind === "select") return <Sel value={String(v ?? "")} options={f.options!} onChange={setv} />;
    if (f.kind === "number") return <Num value={Number(v ?? 100)} min={40} max={300} onChange={setv} />;
    if (f.kind === "color") return <span className="inl"><Color value={String(v ?? "")} onChange={setv} /><button className="mini" onClick={() => setv("")}>Use theme</button></span>;
    if (f.kind === "image") return (
      <div>
        {v ? <img className="thumb" src={assetUrl(String(v))} alt="" /> : <div className="muted">None</div>}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={async (e) => { const n = e.target.files?.[0] && await upload(e.target.files[0]); if (n) setv(n); e.target.value = ""; }} />
        {v ? <button className="mini" onClick={() => setv("")}>Remove</button> : null}
      </div>
    );
    return <input value={String(v ?? "")} maxLength={500} placeholder={f.kind === "url" ? "https://" : ""} onChange={(e) => setv(e.target.value)} />;
  };
  return (
    <div>
      <h3 className="ph3">{comp.type}</h3>
      {PROP_FIELDS[comp.type].map((f) => <Row key={f.key} label={f.label}>{field(f)}</Row>)}
      <h4>Layout</h4>
      <Row label={`Width on ${DEVICE_INFO[device].label} (${comp.scale[device] ?? 100}%)`}>
        <input type="range" min={10} max={100} value={comp.scale[device] ?? 100} onChange={(e) => upd((c) => { c.scale[device] = Number(e.target.value); })} />
      </Row>
      <Row label="Padding up/down (px)"><Num value={comp.paddingY} min={0} max={120} onChange={(v) => upd((c) => { c.paddingY = v; })} /></Row>
      <Row label="Padding left/right (px)"><Num value={comp.marginX} min={0} max={120} onChange={(v) => upd((c) => { c.marginX = v; })} /></Row>
      <Row label="Show on">
        <div className="chips">{DEVICES.map((dv) => (
          <label key={dv} className="chk"><input type="checkbox" checked={!comp.hideOn.includes(dv)}
            onChange={(e) => upd((c) => { c.hideOn = e.target.checked ? c.hideOn.filter((x) => x !== dv) : [...c.hideOn, dv]; })} />{DEVICE_INFO[dv].label}</label>
        ))}</div>
      </Row>
      <div className="inl" style={{ marginTop: 12 }}>
        <button className="mini" disabled={index === 0} onClick={() => move(index - 1)}>Move up</button>
        <button className="mini" disabled={index === count - 1} onClick={() => move(index + 1)}>Move down</button>
        <button className="mini" onClick={() => set((d) => { const c = JSON.parse(JSON.stringify(comp)); c.id = newId(); d.welcome.components.splice(index + 1, 0, c); })}>Duplicate</button>
        <button className="mini danger" onClick={() => set((d) => { d.welcome.components.splice(index, 1); })}>Remove</button>
      </div>
    </div>
  );
}

/* ---------- Theme ---------- */
export function ThemePanel({ def, set, upload, assetUrl }: { def: PageDefinition; set: Set; upload: (f: File) => Promise<string | null>; assetUrl: (n: string) => string }) {
  const t = def.theme; const bg = t.background;
  return (
    <div>
      <h4>Background</h4>
      <Row label="Type"><Sel value={bg.type} options={["color", "gradient", "image"]} onChange={(v) => set((d) => { d.theme.background.type = v as any; })} /></Row>
      {bg.type === "color" && <Row label="Colour"><Color value={bg.color} onChange={(v) => set((d) => { d.theme.background.color = v; })} /></Row>}
      {bg.type === "gradient" && <>
        <Row label="From"><Color value={bg.gradientFrom} onChange={(v) => set((d) => { d.theme.background.gradientFrom = v; })} /></Row>
        <Row label="To"><Color value={bg.gradientTo} onChange={(v) => set((d) => { d.theme.background.gradientTo = v; })} /></Row>
        <Row label={`Angle (${bg.gradientAngle}°)`}><input type="range" min={0} max={360} value={bg.gradientAngle} onChange={(e) => set((d) => { d.theme.background.gradientAngle = Number(e.target.value); })} /></Row>
      </>}
      {bg.type === "image" && <>
        <Row label="Image">
          {bg.image && <img className="thumb" src={assetUrl(bg.image)} alt="" />}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={async (e) => { const n = e.target.files?.[0] && await upload(e.target.files[0]); if (n) set((d) => { d.theme.background.image = n; }); e.target.value = ""; }} />
        </Row>
        <Row label={`Dark overlay (${Math.round(bg.overlay * 100)}%)`}><input type="range" min={0} max={90} value={Math.round(bg.overlay * 100)} onChange={(e) => set((d) => { d.theme.background.overlay = Number(e.target.value) / 100; })} /></Row>
      </>}
      <Row label="Animation"><Sel value={bg.animation} options={["none", "gradient-shift", "slow-zoom"]} onChange={(v) => set((d) => { d.theme.background.animation = v as any; })} /></Row>
      <p className="muted">Background video is not available yet.</p>
      <h4>Text</h4>
      <Row label="Font"><Sel value={t.fontFamily} options={FONTS} onChange={(v) => set((d) => { d.theme.fontFamily = v as any; })} /></Row>
      <Row label="Base size (px)"><Num value={t.baseFontSize} min={12} max={28} onChange={(v) => set((d) => { d.theme.baseFontSize = v; })} /></Row>
      <Row label="Text colour"><Color value={t.textColor} onChange={(v) => set((d) => { d.theme.textColor = v; })} /></Row>
      <Row label="Accent colour"><Color value={t.accentColor} onChange={(v) => set((d) => { d.theme.accentColor = v; })} /></Row>
      <Row label="Alignment"><Sel value={t.align} options={["left", "center", "right"]} onChange={(v) => set((d) => { d.theme.align = v as any; })} /></Row>
      <Row label="Spacing"><Sel value={t.spacing} options={["compact", "normal", "relaxed"]} onChange={(v) => set((d) => { d.theme.spacing = v as any; })} /></Row>
      <h4>Border</h4>
      <Row label="Style"><Sel value={t.border} options={["none", "thin", "double", "ornate"]} onChange={(v) => set((d) => { d.theme.border = v as any; })} /></Row>
      <Row label="Colour"><Color value={t.borderColor} onChange={(v) => set((d) => { d.theme.borderColor = v; })} /></Row>
      <h4>Buttons</h4>
      <Row label="Colour"><Color value={t.button.color} onChange={(v) => set((d) => { d.theme.button.color = v; })} /></Row>
      <Row label="Text colour"><Color value={t.button.textColor} onChange={(v) => set((d) => { d.theme.button.textColor = v; })} /></Row>
      <Row label="Shape"><Sel value={t.button.shape} options={["pill", "rounded", "square"]} onChange={(v) => set((d) => { d.theme.button.shape = v as any; })} /></Row>
      <Row label="Animation"><Sel value={t.button.animation} options={["none", "pulse", "bounce", "glow"]} onChange={(v) => set((d) => { d.theme.button.animation = v as any; })} /></Row>
    </div>
  );
}

/* ---------- Journey + optional fields ---------- */
export function JourneyPanel({ def, set }: { def: PageDefinition; set: Set }) {
  const steps = def.journey.steps;
  const mv = (i: number, to: number) => set((d) => { const s = d.journey.steps; const [x] = s.splice(i, 1); s.splice(to, 0, x); });
  return (
    <div>
      <p className="muted">Choose which screens guests see, and in what order. Photo capture must stay on.</p>
      {steps.map((s, i) => (
        <div key={s.id} className="step">
          <div className="inl">
            <label className="chk"><input type="checkbox" checked={s.enabled} disabled={s.id === "capture"} onChange={(e) => set((d) => { d.journey.steps[i].enabled = e.target.checked; })} /><b>{s.id}</b></label>
            <span style={{ marginLeft: "auto" }} className="inl">
              <button className="mini" disabled={i === 0} onClick={() => mv(i, i - 1)} aria-label="Move step up">↑</button>
              <button className="mini" disabled={i === steps.length - 1} onClick={() => mv(i, i + 1)} aria-label="Move step down">↓</button>
            </span>
          </div>
          {s.enabled && <>
            <Row label="Title"><input value={s.title} maxLength={120} onChange={(e) => set((d) => { d.journey.steps[i].title = e.target.value; })} /></Row>
            <Row label="Instructions"><textarea rows={2} value={s.instructions} maxLength={500} onChange={(e) => set((d) => { d.journey.steps[i].instructions = e.target.value; })} /></Row>
            <Row label="Button label"><input value={s.buttonLabel} maxLength={40} onChange={(e) => set((d) => { d.journey.steps[i].buttonLabel = e.target.value; })} /></Row>
          </>}
        </div>
      ))}
      <h4>Timing</h4>
      <Row label="Idle screen after (seconds, 0 = off)"><Num value={def.journey.idleSeconds} min={0} max={3600} onChange={(v) => set((d) => { d.journey.idleSeconds = v; })} /></Row>
      <Row label="Reset session after (seconds, 0 = never)"><Num value={def.journey.timeoutSeconds} min={0} max={3600} onChange={(v) => set((d) => { d.journey.timeoutSeconds = v; })} /></Row>
      <Row label="Auto-advance success screen (seconds, 0 = manual)"><Num value={def.journey.autoAdvanceSeconds} min={0} max={60} onChange={(v) => set((d) => { d.journey.autoAdvanceSeconds = v; })} /></Row>
      <Row label="Idle screen title"><input value={def.messages.idleTitle} maxLength={120} onChange={(e) => set((d) => { d.messages.idleTitle = e.target.value; })} /></Row>
      <Row label="Success message"><textarea rows={2} value={def.messages.success} maxLength={300} onChange={(e) => set((d) => { d.messages.success = e.target.value; })} /></Row>
    </div>
  );
}

export function FieldsPanel({ def, set }: { def: PageDefinition; set: Set }) {
  return (
    <div>
      <p className="muted">Optional questions on the &quot;details&quot; screen (enable that step in Journey). Every field is optional unless you tick Required. Only ask for what you need.</p>
      {def.fields.map((f, i) => (
        <div key={f.id} className="step">
          <div className="inl">
            <Sel value={f.type} options={FIELD_TYPES} onChange={(v) => set((d) => { d.fields[i].type = v as any; })} />
            <button className="mini danger" onClick={() => set((d) => { d.fields.splice(i, 1); })}>Remove</button>
          </div>
          <Row label="Label"><input value={f.label} maxLength={120} onChange={(e) => set((d) => { d.fields[i].label = e.target.value; })} /></Row>
          <label className="chk"><input type="checkbox" checked={f.required} onChange={(e) => set((d) => { d.fields[i].required = e.target.checked; })} /> Required</label>
        </div>
      ))}
      <button className="mini" disabled={def.fields.length >= 12} onClick={() => set((d) => { d.fields.push({ id: newId(), type: "name", label: "Your name", required: false }); })}>+ Add field</button>
    </div>
  );
}

export type { StepId };
