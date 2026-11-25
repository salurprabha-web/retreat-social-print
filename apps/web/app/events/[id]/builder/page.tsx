"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  COMPONENT_TYPES, DEVICES, DEVICE_INFO, fillTokens, newComponent,
  type ComponentType, type Device, type EventInfo, type PageDefinition,
} from "@rsp/shared";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";
import { GuestPage } from "../../../../components/GuestPage";
import { ComponentPanel, FieldsPanel, JourneyPanel, ThemePanel } from "../../../../components/builder/Panels";

interface Version { version: number; state: string; note: string | null; createdAt: string; publishedAt: string | null; author: string | null }
interface State {
  definition: PageDefinition; draftVersion: number | null; hasUnpublishedChanges: boolean;
  published: { version: number; publishedAt: string } | null; versions: Version[];
  event: (EventInfo & { status: string }) | null;
}
interface Tpl { builtin: { key: string; name: string; category: string }[]; saved: { id: string; name: string }[] }
const LABEL: Record<ComponentType, string> = {
  logo: "Logo", image: "Image", heading: "Heading", paragraph: "Paragraph", button: "Button", qr: "QR code", hashtag: "Hashtag",
  sponsor: "Sponsor logo", countdown: "Countdown", decorative: "Decorative", video: "Video", instructions: "Instructions", footer: "Footer", social: "Social links",
};

function Builder({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [st, setSt] = useState<State | null>(null);
  const [def, setDef] = useState<PageDefinition | null>(null);
  const [dirty, setDirty] = useState(false);
  const [past, setPast] = useState<string[]>([]); const [future, setFuture] = useState<string[]>([]);
  const [device, setDevice] = useState<Device>("mobile");
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<"element" | "theme" | "journey" | "fields" | "versions">("theme");
  const [tpl, setTpl] = useState<Tpl | null>(null);
  const [logos, setLogos] = useState({ event: false, client: false });
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [showJourney, setShowJourney] = useState(false);
  const [token, setToken] = useState("");
  const stage = useRef<HTMLDivElement>(null); const [avail, setAvail] = useState(700);

  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";
  const assetUrl = useCallback((n: string) => `/api/v1/events/${id}/builder/asset/${n}`, [id]);

  const load = useCallback(async () => {
    try {
      const s = await api<State>(`/api/v1/events/${id}/builder`);
      setSt(s); setDef(s.definition); setDirty(false); setPast([]); setFuture([]);
      const ev = await api<{ event: { guestToken: string; settings: { branding: { clientLogo?: string; eventLogo?: string } } } }>(`/api/v1/events/${id}`);
      setLogos({ event: !!ev.event.settings.branding.eventLogo, client: !!ev.event.settings.branding.clientLogo });
      setToken(ev.event.guestToken);
    } catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); api<Tpl>("/api/v1/templates").then(setTpl).catch(() => {}); }, [load]);
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth)); ro.observe(el); setAvail(el.clientWidth); return () => ro.disconnect();
  }, [def]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); } };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // Every edit goes through here: snapshot for undo, mutate a clone, mark dirty.
  const edit = useCallback((fn: (d: PageDefinition) => void) => {
    setDef((cur) => {
      if (!cur) return cur;
      setPast((p) => [...p.slice(-49), JSON.stringify(cur)]); setFuture([]);
      const next = JSON.parse(JSON.stringify(cur)) as PageDefinition; fn(next); return next;
    });
    setDirty(true);
  }, []);
  const undo = () => setPast((p) => { if (!p.length || !def) return p; setFuture((f) => [JSON.stringify(def), ...f]); setDef(JSON.parse(p[p.length - 1])); setDirty(true); return p.slice(0, -1); });
  const redo = () => setFuture((f) => { if (!f.length || !def) return f; setPast((p) => [...p, JSON.stringify(def)]); setDef(JSON.parse(f[0])); setDirty(true); return f.slice(1); });

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); setMsg(ok); } catch (x: any) { setErr(x.message === "validation" ? "Some settings are invalid (check links start with https:// and the photo step is enabled)." : x.message); }
    setBusy(false);
  }
  const apply = (s: State) => { setSt(s); setDef(s.definition); setDirty(false); setPast([]); setFuture([]); };
  const saveDraft = () => run(async () => apply(await api<State>(`/api/v1/events/${id}/builder/draft`, { method: "PUT", body: { definition: def } })), "Draft saved. The live page is unchanged until you publish.");
  const publish = () => run(async () => {
    if (!confirm("Publish this design? Guests scanning the QR code will see it immediately.")) throw new Error("Publish cancelled.");
    if (dirty) await api(`/api/v1/events/${id}/builder/draft`, { method: "PUT", body: { definition: def } });
    apply(await api<State>(`/api/v1/events/${id}/builder/publish`, { method: "POST", body: {} }));
  }, "Published.");
  const unpublish = () => run(async () => { if (!confirm("Unpublish? Guests will no longer see the page.")) throw new Error("Cancelled."); apply(await api<State>(`/api/v1/events/${id}/builder/unpublish`, { method: "POST" })); }, "Unpublished.");
  const applyTpl = (body: object) => run(async () => { if (dirty && !confirm("Replace your unsaved edits with this template?")) throw new Error("Cancelled."); apply(await api<State>(`/api/v1/events/${id}/builder/apply-template`, { method: "POST", body })); }, "Template applied to the draft (not live yet).");
  const restore = (version: number) => run(async () => apply(await api<State>(`/api/v1/events/${id}/builder/restore`, { method: "POST", body: { version } })), `Version ${version} restored into the draft (not live yet).`);
  const saveTpl = () => {
    const name = prompt("Name for this reusable template (uploaded images are not included):"); if (!name) return;
    run(async () => { await api(`/api/v1/events/${id}/builder/save-template`, { method: "POST", body: { name, definition: def } }); setTpl(await api<Tpl>("/api/v1/templates")); }, "Template saved.");
  };
  async function upload(f: File): Promise<string | null> {
    setErr("");
    const res = await fetch(`/api/v1/events/${id}/builder/asset`, { method: "POST", credentials: "same-origin", body: f,
      headers: { "content-type": f.type || "application/octet-stream", "x-rsp-csrf": (await api<{ csrf: string }>("/api/v1/auth/me")).csrf } });
    if (!res.ok) { setErr("Upload failed: use a PNG, JPG, WebP or safe SVG under 4 MB."); return null; }
    return (await res.json()).name as string;
  }

  const info: EventInfo = useMemo(() => st?.event ?? { name: "Event", hashtag: null, eventDate: null, clientName: null }, [st]);
  if (!def || !st) return err ? <div className="err">{err}</div> : null;

  const sc = DEVICE_INFO[device];
  const zoom = Math.min(1, (avail - 4) / sc.width);
  const selIdx = def.welcome.components.findIndex((c) => c.id === sel);
  const selComp = selIdx >= 0 ? def.welcome.components[selIdx] : null;
  const guestUrl = `${window.location.origin}/g/${token}`;

  function dropAtIndex(e: React.DragEvent, index: number) {
    e.preventDefault(); setDropAt(null);
    const nu = e.dataTransfer.getData("application/x-rsp-new") as ComponentType;
    const mv = e.dataTransfer.getData("application/x-rsp-move");
    if (nu && COMPONENT_TYPES.includes(nu)) { const c = newComponent(nu); edit((d) => { d.welcome.components.splice(index, 0, c); }); setSel(c.id); setTab("element"); }
    else if (mv) edit((d) => { const a = d.welcome.components; const from = a.findIndex((x) => x.id === mv); if (from < 0) return; const [c] = a.splice(from, 1); a.splice(from < index ? index - 1 : index, 0, c); });
  }
  const live = st.published && st.event?.status === "active";

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; {info.name}</a>
      <div className="bar">
        <h1 style={{ margin: 0, fontSize: 20 }}>Guest page builder</h1>
        <span className={"pill " + (st.published ? "active" : "")}>{st.published ? `published v${st.published.version}` : "not published"}</span>
        {dirty ? <span className="pill">unsaved changes</span> : st.hasUnpublishedChanges ? <span className="pill">draft ≠ live</span> : null}
        <div className="inl" style={{ marginLeft: "auto" }}>
          <button className="mini" onClick={undo} disabled={!past.length}>Undo</button>
          <button className="mini" onClick={redo} disabled={!future.length}>Redo</button>
          <button className="mini" onClick={() => setShowJourney(true)}>Preview journey</button>
          {canEdit && <>
            <button className="mini" onClick={saveTpl} disabled={busy}>Save as template</button>
            <button className="mini" onClick={saveDraft} disabled={busy || !dirty}>Save draft</button>
            <button className="mini primary" onClick={publish} disabled={busy || (!dirty && !st.hasUnpublishedChanges)}>Publish</button>
            {st.published && <button className="mini danger" onClick={unpublish} disabled={busy}>Unpublish</button>}
          </>}
        </div>
      </div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}
      {st.published && st.event?.status !== "active" && <div className="muted">Published, but guests cannot see it until the event is Active.</div>}
      {live && <div className="muted">Live at <a href={`/g/${token}`} target="_blank" rel="noopener noreferrer">{guestUrl}</a></div>}

      <div className="builder">
        <aside className="lib">
          <h4>Elements</h4>
          <p className="muted">Drag onto the page, or click to add.</p>
          {COMPONENT_TYPES.map((t) => (
            <button key={t} className="libitem" disabled={!canEdit} draggable={canEdit}
              onDragStart={(e) => e.dataTransfer.setData("application/x-rsp-new", t)}
              onClick={() => { const c = newComponent(t); edit((d) => { d.welcome.components.push(c); }); setSel(c.id); setTab("element"); }}>+ {LABEL[t]}</button>
          ))}
          <h4>Templates</h4>
          <select disabled={!canEdit} value="" onChange={(e) => { const v = e.target.value; if (!v) return; applyTpl(v.startsWith("b:") ? { builtin: v.slice(2) } : { templateId: v.slice(2) }); }}>
            <option value="">Apply a template…</option>
            <optgroup label="Built-in">{tpl?.builtin.map((t) => <option key={t.key} value={"b:" + t.key}>{t.name}</option>)}</optgroup>
            {tpl && tpl.saved.length > 0 && <optgroup label="Saved">{tpl.saved.map((t) => <option key={t.id} value={"s:" + t.id}>{t.name}</option>)}</optgroup>}
          </select>
        </aside>

        <section className="center">
          <div className="inl" style={{ marginBottom: 8, flexWrap: "wrap" }}>
            {DEVICES.map((d) => <button key={d} className={"mini" + (device === d ? " primary" : "")} onClick={() => setDevice(d)}>{DEVICE_INFO[d].label}</button>)}
            <span className="muted">{sc.width}×{sc.height} · preview {Math.round(zoom * 100)}%</span>
          </div>
          <div ref={stage} className="stage">
            <div style={{ width: sc.width * zoom, height: sc.height * zoom, overflow: "auto", margin: "0 auto", border: "1px solid var(--line)", borderRadius: 8 }}>
              <div style={{ zoom }} onClick={() => setSel(null)}>
                <GuestPage def={def} event={info} device={device} builder guestUrl={guestUrl}
                  assetUrl={assetUrl} logoUrl={(k) => (logos[k] ? `/api/v1/events/${id}/logo/${k}` : null)}
                  wrap={(c, node, i) => (
                    <div key={c.id} style={{ width: "100%", display: "flex", justifyContent: "center", position: "relative", outline: sel === c.id ? "2px solid #3b82f6" : undefined }}
                      draggable={canEdit} onClick={(e) => { e.stopPropagation(); setSel(c.id); setTab("element"); }}
                      onDragStart={(e) => e.dataTransfer.setData("application/x-rsp-move", c.id)}
                      onDragOver={(e) => { e.preventDefault(); setDropAt(i); }} onDragLeave={() => setDropAt(null)} onDrop={(e) => dropAtIndex(e, i)}>
                      {dropAt === i && <div className="dropline" />}
                      {node}
                    </div>
                  )}
                  tail={<div className="dz" onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropAtIndex(e, def.welcome.components.length)}>Drop here</div>} />
              </div>
            </div>
          </div>
        </section>

        <aside className="props">
          <div className="tabs2">
            {(["element", "theme", "journey", "fields", "versions"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "element" ? "Selected" : t}</button>)}
          </div>
          <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
            {tab === "element" && (selComp
              ? <ComponentPanel comp={selComp} device={device} index={selIdx} count={def.welcome.components.length} set={edit} upload={upload} assetUrl={assetUrl} />
              : <p className="muted">Click an element in the preview to edit it.</p>)}
            {tab === "theme" && <ThemePanel def={def} set={edit} upload={upload} assetUrl={assetUrl} />}
            {tab === "journey" && <JourneyPanel def={def} set={edit} />}
            {tab === "fields" && <FieldsPanel def={def} set={edit} />}
          </fieldset>
          {tab === "versions" && (
            <div>
              <p className="muted">Restoring copies an old version into the draft. It only goes live when you publish.</p>
              {st.versions.map((v) => (
                <div key={v.version} className="step">
                  <div className="inl"><b>v{v.version}</b><span className={"pill " + (v.state === "published" ? "active" : "")}>{v.state}</span>
                    {canEdit && v.state !== "draft" && <button className="mini" style={{ marginLeft: "auto" }} onClick={() => restore(v.version)} disabled={busy}>Restore</button>}</div>
                  <div className="muted">{new Date(v.createdAt).toLocaleString()} {v.author ? `· ${v.author}` : ""}{v.note ? ` · ${v.note}` : ""}</div>
                </div>
              ))}
              {!st.versions.length && <p className="muted">No saved versions yet.</p>}
            </div>
          )}
        </aside>
      </div>

      {showJourney && <JourneyModal def={def} info={info} onClose={() => setShowJourney(false)} />}
    </>
  );
}

/** Storyboard of the enabled steps in order. The working capture/frame/edit screens are built in the next phases. */
function JourneyModal({ def, info, onClose }: { def: PageDefinition; info: EventInfo; onClose: () => void }) {
  const steps = def.journey.steps.filter((s) => s.enabled);
  const [i, setI] = useState(0); const s = steps[i];
  const t = def.theme;
  return (
    <div className="modal" onClick={onClose}>
      <div className="mbox" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Journey preview">
        <div className="muted">Step {i + 1} of {steps.length}: <b>{s.id}</b> (storyboard: the working screens arrive in later phases)</div>
        <div style={{ background: t.background.type === "color" ? t.background.color : `linear-gradient(${t.background.gradientAngle}deg, ${t.background.gradientFrom}, ${t.background.gradientTo})`, color: t.textColor, padding: 28, borderRadius: 12, margin: "12px 0", textAlign: "center", minHeight: 200 }}>
          <h2 style={{ margin: "0 0 8px" }}>{fillTokens(s.id === "success" ? def.messages.success : s.title, info)}</h2>
          <p>{fillTokens(s.instructions, info)}</p>
          {s.id === "details" && def.fields.map((f) => <div key={f.id} style={{ opacity: .85 }}>{f.label}{f.required ? " *" : " (optional)"}</div>)}
          <button className="btn-demo" style={{ background: t.button.color, color: t.button.textColor, border: 0, padding: "10px 28px", borderRadius: t.button.shape === "pill" ? 99 : t.button.shape === "rounded" ? 10 : 0, fontWeight: 700, marginTop: 10, width: "auto" }}>{s.buttonLabel}</button>
        </div>
        <div className="inl"><button className="mini" disabled={i === 0} onClick={() => setI(i - 1)}>Back</button><button className="mini" disabled={i === steps.length - 1} onClick={() => setI(i + 1)}>Next</button><button className="mini" style={{ marginLeft: "auto" }} onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

export default function BuilderPage() { return <Shell active="events">{(me) => <Builder me={me} />}</Shell>; }
