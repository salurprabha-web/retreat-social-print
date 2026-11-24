"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { DEFAULT_WALL_STYLE, FONTS, FONT_STACKS, WALL_MODES, WALL_MODE_LABEL, WALL_TRANSITIONS, type WallSettings } from "@rsp/shared";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface Stats { eligible: number; pendingModeration: number; optedOut: number; hidden: number; totalShown: number; picturesShown: number }
interface Loaded { settings: WallSettings; token: string; path: string; stats: Stats }
const ERR: Record<string, string> = { validation: "Some values are out of range. Check the highlighted limits.", not_found: "This event has no wall settings." };

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Loaded | null>(null); const [s, setS] = useState<WallSettings | null>(null); const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";

  const load = useCallback(async (keepForm = false) => {
    try { const r = await api<Loaded>(`/api/v1/events/${id}/wall`); setD(r); if (!keepForm) { setS(r.settings); setDirty(false); } }
    catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), 10000); return () => clearInterval(t); }, [load]);   // live counts; never overwrites the form

  if (!d || !s) return <>{err && <div className="err" role="alert">{err}</div>}</>;
  const url = typeof window !== "undefined" ? `${window.location.origin}${d.path}` : d.path;
  const set = (p: Partial<WallSettings>) => { setS({ ...s, ...p }); setDirty(true); };
  const style = (p: Partial<WallSettings["style"]>) => set({ style: { ...s.style, ...p } });
  const bgPatch = (p: Partial<WallSettings["style"]["background"]>) => style({ background: { ...s.style.background, ...p } });
  const st = s.style;
  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

  async function save() {
    setErr(""); setMsg("");
    try { await api(`/api/v1/events/${id}/wall`, { method: "PUT", body: s }); setMsg("Saved. Open screens update within seconds."); await load(); }
    catch (x: any) { setErr(ERR[x.message] ?? x.message); }
  }
  async function regenerate() {
    if (!confirm("Make a new wall link? Every screen showing the old link stops working immediately and must be opened again with the new one.")) return;
    setErr(""); setMsg("");
    try { await api(`/api/v1/events/${id}/wall/regenerate-token`, { method: "POST" }); setMsg("New link created. Old link no longer works."); await load(true); }
    catch (x: any) { setErr(x.message); }
  }
  const bg = st.background.type === "gradient" ? `linear-gradient(${st.background.angle}deg, ${st.background.from}, ${st.background.to})` : st.background.color;

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; Event</a>
      <h1>Photo wall</h1>
      <div className="sub">A live slideshow or gallery for a TV or projector. It shows pictures guests have finished, as they arrive.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}

      <div className="grid" style={{ marginBottom: 14 }}>
        <div className="card"><div className="n">{d.stats.eligible}</div><div className="l">on the wall now</div></div>
        <div className="card"><div className="n">{d.stats.pendingModeration}</div><div className="l">waiting for approval{s.moderationRequired && d.stats.pendingModeration ? <> · <a href={`/events/${id}/photos`}>review</a></> : ""}</div></div>
        <div className="card"><div className="n">{d.stats.totalShown}</div><div className="l">times shown ({d.stats.picturesShown} pictures)</div></div>
        <div className="card"><div className="n">{d.stats.hidden + d.stats.optedOut}</div><div className="l">kept off ({d.stats.hidden} hidden, {d.stats.optedOut} guest opt-outs)</div></div>
      </div>

      <div className="card">
        <div className="inl" style={{ justifyContent: "space-between" }}>
          <label className="chk"><input type="checkbox" disabled={!canEdit} checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> <b>Wall is {s.enabled ? "on" : "off"}</b></label>
          <span className="muted">{d.settings.enabled ? "Live: anyone with the link can watch." : "Off: the link shows nothing."}</span>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>Wall link (keep it for the screen operator, it works without a login):</div>
        <div className="row"><input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button className="mini" onClick={() => navigator.clipboard?.writeText(url).then(() => setMsg("Link copied."))}>Copy</button>
          <a className="mini" href={d.path} target="_blank" rel="noopener noreferrer">Open display</a>
          {canEdit && <button className="mini" onClick={regenerate}>New link</button>}</div>
        {dirty && <div className="muted" style={{ marginTop: 6 }}>You have unsaved changes. The display only changes after Save.</div>}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <b>What to show</b>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label>Layout<select disabled={!canEdit} value={s.mode} onChange={(e) => set({ mode: e.target.value as any })}>{WALL_MODES.map((m) => <option key={m} value={m}>{WALL_MODE_LABEL[m]}</option>)}</select></label>
          <label>Seconds per picture / page<input type="number" disabled={!canEdit} min={2} max={60} value={s.displaySeconds} onChange={(e) => set({ displaySeconds: num(e.target.value, 2, 60) })} /></label>
          <label>Transition<select disabled={!canEdit} value={st.transition} onChange={(e) => style({ transition: e.target.value as any })}>{WALL_TRANSITIONS.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Fit<select disabled={!canEdit} value={st.fit} onChange={(e) => style({ fit: e.target.value as any })}><option value="contain">Whole picture</option><option value="cover">Fill the space (crops)</option></select></label>
          <label>Grid columns<input type="number" disabled={!canEdit} min={2} max={8} value={st.gridColumns} onChange={(e) => style({ gridColumns: num(e.target.value, 2, 8) })} /></label>
          <label>Announce new pictures for (seconds, 0 = off)<input type="number" disabled={!canEdit} min={0} max={30} value={st.highlightSeconds} onChange={(e) => style({ highlightSeconds: num(e.target.value, 0, 30) })} /></label>
        </div>
        <label className="chk" style={{ marginTop: 8 }}><input type="checkbox" disabled={!canEdit} checked={s.moderationRequired} onChange={(e) => set({ moderationRequired: e.target.checked })} /> Only show pictures staff have <b>approved</b> (recommended for public events)</label>
        <div className="muted">Rejected, hidden, deleted and guest opt-out pictures never show, whatever this is set to. Pictures a guest is still editing never show.</div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <b>Look</b>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label>Headline<input disabled={!canEdit} maxLength={100} value={st.headline} onChange={(e) => style({ headline: e.target.value })} /></label>
          <label>Font<select disabled={!canEdit} value={st.fontFamily} onChange={(e) => style({ fontFamily: e.target.value as any })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></label>
          <label>Background<select disabled={!canEdit} value={st.background.type} onChange={(e) => bgPatch({ type: e.target.value as any })}><option value="gradient">Gradient</option><option value="color">Solid colour</option></select></label>
          {st.background.type === "color"
            ? <label>Background colour<input type="color" disabled={!canEdit} value={st.background.color} onChange={(e) => bgPatch({ color: e.target.value })} /></label>
            : <label>Gradient from / to / angle<span className="inl"><input type="color" disabled={!canEdit} value={st.background.from} onChange={(e) => bgPatch({ from: e.target.value })} /><input type="color" disabled={!canEdit} value={st.background.to} onChange={(e) => bgPatch({ to: e.target.value })} /><input type="number" disabled={!canEdit} min={0} max={360} value={st.background.angle} onChange={(e) => bgPatch({ angle: num(e.target.value, 0, 360) })} style={{ width: 80 }} /></span></label>}
          <label>Text colour<input type="color" disabled={!canEdit} value={st.textColor} onChange={(e) => style({ textColor: e.target.value })} /></label>
          <label>Accent colour (hashtag, NEW badge)<input type="color" disabled={!canEdit} value={st.accentColor} onChange={(e) => style({ accentColor: e.target.value })} /></label>
        </div>
        <div className="inl" style={{ marginTop: 8, gap: 14 }}>
          {([["showHeader", "Header bar"], ["showEventName", "Event name"], ["showHashtag", "Hashtag"], ["showEventLogo", "Event logo"], ["showClientLogo", "Client logo"], ["showJoinQr", "Join QR code"]] as const).map(([k, label]) => (
            <label key={k} className="chk"><input type="checkbox" disabled={!canEdit} checked={st[k]} onChange={(e) => style({ [k]: e.target.checked } as any)} /> {label}</label>
          ))}
        </div>
        <div style={{ marginTop: 12, borderRadius: 10, padding: 18, background: bg, color: st.textColor, fontFamily: FONT_STACKS[st.fontFamily] }} aria-label="Colour and font preview">
          <div style={{ fontSize: 22, fontWeight: 700 }}>Preview of your event name</div>
          <div style={{ opacity: .85 }}>{st.headline || "Your headline"}</div>
          <div style={{ color: st.accentColor, fontWeight: 700, marginTop: 4 }}>#yourhashtag</div>
        </div>
      </div>

      {canEdit && <div className="row" style={{ marginTop: 14 }}>
        <button className="inline" onClick={save} disabled={!dirty}>Save</button>
        <button className="mini" onClick={() => { setS({ ...s, style: DEFAULT_WALL_STYLE }); setDirty(true); }}>Reset look to default</button>
      </div>}
      {!canEdit && <p className="muted">You can see the wall settings but only an event manager can change them.</p>}
      <p className="muted" style={{ marginTop: 14 }}>Tip: open the display link on the TV&apos;s browser, press <b>Full screen</b>, and leave it. It keeps running if the network drops and catches up when it returns.</p>
    </>
  );
}
export default function WallAdminPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
