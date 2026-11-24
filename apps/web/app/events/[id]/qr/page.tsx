"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface Qr {
  id: string; code: string; label: string; enabled: boolean; expiresAt: string | null; landingUrl: string | null; kioskLabel: string | null;
  style: { fg: string; bg: string; logo: boolean; margin: number }; scans: number; path: string; url: string | null; scansByDay: { day: string; count: number }[];
}
const ERR: Record<string, string> = {
  low_contrast: "Those colours are too close: phones may not scan the code. Use a dark colour on a light background.",
  validation: "Check the values: a landing link must start with https:// and the expiry must be a valid date.",
  too_many_qr_codes: "An event can have up to 50 QR codes.",
};

function Bars({ data }: { data: { day: string; count: number }[] }) {
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(Date.now() - (13 - i) * 864e5); return d.toISOString().slice(0, 10); });
  const by = new Map(data.map((d) => [d.day, d.count])); const max = Math.max(1, ...days.map((d) => by.get(d) ?? 0));
  return (
    <svg viewBox="0 0 140 28" width="140" height="28" role="img" aria-label="Scans in the last 14 days">
      {days.map((d, i) => { const h = ((by.get(d) ?? 0) / max) * 24; return <rect key={d} x={i * 10 + 1} y={27 - h} width="8" height={Math.max(h, 1)} fill={by.get(d) ? "var(--brand)" : "var(--line)"}><title>{`${d}: ${by.get(d) ?? 0}`}</title></rect>; })}
    </svg>
  );
}

function Card({ q, id, base, canEdit, reload, setMsg, setErr }: { q: Qr; id: string; base: string; canEdit: boolean; reload: () => void; setMsg: (s: string) => void; setErr: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ label: q.label, kiosk: q.kioskLabel ?? "", landing: q.landingUrl ?? "", expires: q.expiresAt ? q.expiresAt.slice(0, 16) : "", fg: q.style.fg, bg: q.style.bg, logo: q.style.logo, margin: q.style.margin });
  const expired = !!q.expiresAt && new Date(q.expiresAt) < new Date();
  const status = !q.enabled ? "off" : expired ? "expired" : "active";
  const root = `/api/v1/events/${id}/qr/${q.id}`; const b = `base=${encodeURIComponent(base)}`;
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); reload(); } catch (x: any) { setErr(ERR[x.message] ?? x.message); } };
  const save = (e: React.FormEvent) => { e.preventDefault(); run(() => api(`${root}?${b}`, { method: "PATCH", body: {
    label: f.label, kioskLabel: f.kiosk.trim() || null, landingUrl: f.landing.trim() || null, expiresAt: f.expires ? new Date(f.expires).toISOString() : null,
    style: { fg: f.fg, bg: f.bg, logo: f.logo, margin: Number(f.margin) } } }), "QR code saved."); };
  const fullUrl = `${base}/q/${q.code}`;
  return (
    <div className="card qrcard">
      <img src={`${root}/image?${b}&size=360&v=${q.style.fg}${q.style.bg}${q.style.logo}${q.style.margin}${q.code}`} alt={`QR code ${q.label}`} width={180} height={180} style={{ background: "#fff", borderRadius: 6, border: "1px solid var(--line)" }} />
      <div style={{ flex: 1, minWidth: 220 }}>
        <div><b>{q.label}</b> <span className={"pill " + (status === "active" ? "active" : "")}>{status}</span></div>
        {q.kioskLabel && <div className="muted">Assigned to: {q.kioskLabel}</div>}
        <div className="muted" style={{ wordBreak: "break-all" }}>{fullUrl}</div>
        {q.landingUrl && <div className="muted">Sends guests to: {q.landingUrl}</div>}
        {q.expiresAt && <div className="muted">Expires: {new Date(q.expiresAt).toLocaleString()}</div>}
        <div className="inl" style={{ margin: "8px 0" }}><b>{q.scans}</b> scans <Bars data={q.scansByDay} /></div>
        <div className="inl">
          <a className="mini lnk" href={`${root}/image?${b}&format=png&size=2048&download=1`}>PNG</a>
          <a className="mini lnk" href={`${root}/image?${b}&format=svg&size=1024&download=1`}>SVG</a>
          <a className="mini lnk" href={`${root}/poster?${b}`}>Poster (A4)</a>
          <a className="mini lnk" href={`/d/${q.code}`} target="_blank" rel="noopener noreferrer">Display mode</a>
          <button className="mini" onClick={async () => { await navigator.clipboard.writeText(fullUrl).catch(() => {}); setMsg("Link copied."); }}>Copy link</button>
        </div>
        {canEdit && (
          <div className="inl" style={{ marginTop: 8 }}>
            <button className="mini" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</button>
            <button className="mini" onClick={() => run(() => api(`${root}?${b}`, { method: "PATCH", body: { enabled: !q.enabled } }), q.enabled ? "QR code turned off." : "QR code turned on.")}>{q.enabled ? "Turn off" : "Turn on"}</button>
            <button className="mini" onClick={() => confirm("Make a NEW code? Printed or displayed copies of the current code stop working immediately.") && run(() => api(`${root}/regenerate?${b}`, { method: "POST" }), "New code created. Download and replace the old one.")}>Regenerate</button>
            <button className="mini danger" onClick={() => confirm(`Delete "${q.label}"? Its scan history is deleted too.`) && run(() => api(root, { method: "DELETE" }), "QR code deleted.")}>Delete</button>
          </div>
        )}
        {open && (
          <form onSubmit={save} style={{ marginTop: 10 }}>
            <div className="grid2">
              <div className="prow"><label>Name</label><input value={f.label} maxLength={80} onChange={(e) => setF({ ...f, label: e.target.value })} required /></div>
              <div className="prow"><label>Kiosk / screen</label><input value={f.kiosk} maxLength={80} placeholder="Kiosk 1 (22-inch)" onChange={(e) => setF({ ...f, kiosk: e.target.value })} /></div>
              <div className="prow"><label>Expires</label><input type="datetime-local" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></div>
              <div className="prow"><label>Custom landing link (blank = event page)</label><input value={f.landing} placeholder="https://" onChange={(e) => setF({ ...f, landing: e.target.value })} /></div>
              <div className="prow"><label>Code colour</label><input type="color" className="swatch" value={f.fg} onChange={(e) => setF({ ...f, fg: e.target.value })} /></div>
              <div className="prow"><label>Background</label><input type="color" className="swatch" value={f.bg} onChange={(e) => setF({ ...f, bg: e.target.value })} /></div>
              <div className="prow"><label>Quiet margin</label><input type="number" min={1} max={8} value={f.margin} onChange={(e) => setF({ ...f, margin: +e.target.value })} /></div>
              <label className="chk"><input type="checkbox" checked={f.logo} onChange={(e) => setF({ ...f, logo: e.target.checked })} /> Put the event logo in the middle (upload it under Branding first)</label>
            </div>
            <button className="mini primary" style={{ marginTop: 8 }}>Save</button>
          </form>
        )}
      </div>
    </div>
  );
}

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [qrs, setQrs] = useState<Qr[] | null>(null);
  const [base, setBase] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [name, setName] = useState(""); const [kiosk, setKiosk] = useState("");
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";
  useEffect(() => setBase(window.location.origin), []);
  const load = useCallback(async () => {
    if (!base) return;
    try { setQrs((await api<{ qrCodes: Qr[] }>(`/api/v1/events/${id}/qr?base=${encodeURIComponent(base)}`)).qrCodes); } catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id, base]);
  useEffect(() => { load(); }, [load]);
  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setMsg("");
    try { await api(`/api/v1/events/${id}/qr?base=${encodeURIComponent(base)}`, { method: "POST", body: { label: name, ...(kiosk.trim() ? { kioskLabel: kiosk.trim() } : {}) } }); setName(""); setKiosk(""); setMsg("QR code created."); load(); }
    catch (x: any) { setErr(ERR[x.message] ?? x.message); }
  }
  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; Event</a>
      <h1>QR codes</h1>
      <div className="sub">Each code opens this event&apos;s guest page and counts scans. Make a separate code per kiosk, table or poster to see which gets used. Codes only work while the event is Active and its page is published.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}
      {canEdit && (
        <form className="card row" onSubmit={create}>
          <input placeholder="Name, e.g. Lobby poster *" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          <input placeholder="Kiosk / screen (optional)" value={kiosk} onChange={(e) => setKiosk(e.target.value)} maxLength={80} />
          <button className="inline">Add QR code</button>
        </form>
      )}
      <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
        {qrs && base && qrs.map((q) => <Card key={q.id + q.code} q={q} id={id} base={base} canEdit={canEdit} reload={load} setMsg={setMsg} setErr={setErr} />)}
      </div>
      <p className="muted">Printed codes point at <code>{base}</code>. If the event will run on a different address, open this page from that address before downloading.</p>
    </>
  );
}
export default function QrPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
