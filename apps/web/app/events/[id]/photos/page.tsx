"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface Comp {
  id: string; guestCode: string | null; frame: { id: string; name: string }; widthPx: number; heightPx: number; bytes: number;
  moderation: "pending" | "approved" | "rejected"; moderationNote: string | null; moderatedBy: string | null; moderatedAt: string | null;
  showOnWall: boolean; createdAt: string; downloads: number; shareAttempts: number; printJobs: number; slots: { slot: number; uploadId: string; width: number; height: number }[];
}
interface Detail { composition: Comp; printJobsByStatus: Record<string, number>; guest: { code: string; startedAt: string; consentAt: string | null; fields?: Record<string, string>; fieldsHidden: boolean } }
interface Counts { pending: number; approved: number; rejected: number; all: number }
interface Frame { id: string; name: string }
type Status = "" | "pending" | "approved" | "rejected";
const PAGE = 48;
const COLOUR = { pending: "#b7791f", approved: "#1d7a4d", rejected: "#b3261e" } as const;

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [items, setItems] = useState<Comp[]>([]); const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Counts>({ pending: 0, approved: 0, rejected: 0, all: 0 });
  const [frames, setFrames] = useState<Frame[]>([]);
  const [f, setF] = useState({ status: "" as Status, q: "", frameId: "", wall: "", sort: "newest", from: "", to: "", drafts: false });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null); const [detail, setDetail] = useState<Detail | null>(null);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(0);
  const loadedAll = useRef(0);
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canManage = role === "super_admin" || role === "event_manager";
  const canOperate = canManage || role === "print_operator";

  const query = useCallback((offset: number) => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort: f.sort });
    if (!f.drafts) p.set("finalized", "true");           // abandoned drafts (guest never tapped Finish) are hidden unless asked for
    if (f.status) p.set("status", f.status); if (f.q.trim()) p.set("q", f.q.trim()); if (f.frameId) p.set("frameId", f.frameId); if (f.wall) p.set("wall", f.wall);
    if (f.from) p.set("from", new Date(f.from + "T00:00:00").toISOString()); if (f.to) p.set("to", new Date(new Date(f.to + "T00:00:00").getTime() + 864e5).toISOString());
    return p;
  }, [f]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ compositions: Comp[]; total: number; counts: Counts }>(`/api/v1/events/${id}/compositions?${query(0)}`);
      setItems(r.compositions); setTotal(r.total); setCounts(r.counts); loadedAll.current = r.counts.all; setFresh(0); setSel(new Set());
    } catch (x: any) { setErr(x.status === 403 ? "You do not have access to photos for this event." : x.message); }
  }, [id, query]);
  useEffect(() => { const t = setTimeout(load, f.q ? 250 : 0); return () => clearTimeout(t); }, [load, f.q]);
  useEffect(() => { api<{ frames: Frame[] }>(`/api/v1/events/${id}/frames`).then((r) => setFrames(r.frames)).catch(() => {}); }, [id]);
  // New pictures: check the count every few seconds and offer them, instead of shifting the grid under the operator's cursor.
  useEffect(() => {
    const t = setInterval(async () => {
      try { const r = await api<{ counts: Counts }>(`/api/v1/events/${id}/compositions?${query(0)}&limit=1`); setFresh(Math.max(0, r.counts.all - loadedAll.current)); } catch { /* offline: ignore */ }
    }, 6000);
    return () => clearInterval(t);
  }, [id, query]);
  async function more() {
    const r = await api<{ compositions: Comp[] }>(`/api/v1/events/${id}/compositions?${query(items.length)}`); setItems((x) => [...x, ...r.compositions]);
  }

  const openItem = useCallback(async (cid: string | null) => {
    setOpen(cid); setDetail(null); if (!cid) return;
    try { setDetail(await api<Detail>(`/api/v1/events/${id}/compositions/${cid}`)); } catch (x: any) { setErr(x.message); }
  }, [id]);

  async function bulk(ids: string[], action: string, extra: object = {}) {
    if (!ids.length) return; setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api<any>(`/api/v1/events/${id}/compositions/bulk`, { method: "POST", body: { ids, action, ...extra } });
      if (action === "delete" && r.blocked?.length) {
        if (confirm(`${r.blocked.length} picture(s) were already sent to the printer. Deleting them also removes their print history. Delete anyway?`)) await api(`/api/v1/events/${id}/compositions/bulk`, { method: "POST", body: { ids: r.blocked, action: "delete", confirmPrinted: true } });
      }
      setMsg(action === "delete" ? "Deleted." : "Updated."); await load();
      if (open) { if (action === "delete" && ids.includes(open)) setOpen(null); else openItem(open); }
    } catch (x: any) { setErr(x.message); }
    setBusy(false);
  }
  const selected = [...sel];
  const toggle = (cid: string) => setSel((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  const reject = (ids: string[]) => { const note = prompt("Reason (optional, visible to staff):") ; if (note === null) return; void bulk(ids, "reject", note ? { note } : {}); };
  const del = (ids: string[]) => confirm(`Permanently delete ${ids.length} picture(s) and their original photos? This cannot be undone.`) && bulk(ids, "delete");

  // Keyboard for the viewer: arrows move, A approves, R rejects, Esc closes.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
      const i = items.findIndex((x) => x.id === open);
      if (e.key === "Escape") setOpen(null);
      else if (e.key === "ArrowRight" && items[i + 1]) openItem(items[i + 1].id);
      else if (e.key === "ArrowLeft" && items[i - 1]) openItem(items[i - 1].id);
      else if (canOperate && e.key.toLowerCase() === "a") { void bulk([open], "approve").then(() => items[i + 1] && openItem(items[i + 1].id)); }
      else if (canOperate && e.key.toLowerCase() === "r") reject([open]);
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  });

  async function deleteGuest(code: string) {
    if (!confirm(`Delete EVERYTHING about guest ${code}: their pictures, original photos, details and share records? This cannot be undone.`)) return;
    try { const r = await api<any>(`/api/v1/events/${id}/guests/${code}`, { method: "DELETE" }); setMsg(`Guest ${code} deleted (${r.pictures} picture(s), ${r.originals} original(s)).`); setOpen(null); await load(); } catch (x: any) { setErr(x.message); }
  }
  const T = (cid: string, size = 400) => `/api/v1/events/${id}/compositions/${cid}/thumb?size=${size}`;
  const exportUrl = () => { const p = query(0); p.delete("limit"); p.delete("offset"); p.delete("sort"); if (!f.status) p.set("status", "approved"); return `/api/v1/events/${id}/compositions-export?${p}`; };
  const chip = (s: Status, label: string, n: number) => <button key={label} className={"mini" + (f.status === s ? " primary" : "")} onClick={() => setF({ ...f, status: s })}>{label} <b>{n}</b></button>;
  const idx = items.findIndex((x) => x.id === open);

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; Event</a>
      <h1>Photos</h1>
      <div className="sub">Every finished picture from guests. Approve or reject, hide from the photo wall, download or delete. Contact details are visible to managers only.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}
      <div className="inl" style={{ margin: "10px 0" }}>
        {chip("", "All", counts.all)}{chip("pending", "Pending", counts.pending)}{chip("approved", "Approved", counts.approved)}{chip("rejected", "Rejected", counts.rejected)}
        {fresh > 0 && <button className="mini primary" onClick={load}>{fresh} new picture{fresh > 1 ? "s" : ""}: show</button>}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Guest ID (e.g. G4K7)" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value.toUpperCase() })} maxLength={6} aria-label="Search guest ID" />
        <select value={f.frameId} onChange={(e) => setF({ ...f, frameId: e.target.value })} aria-label="Frame"><option value="">All frames</option>{frames.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select value={f.wall} onChange={(e) => setF({ ...f, wall: e.target.value })} aria-label="Photo wall"><option value="">Wall: any</option><option value="true">Shown on wall</option><option value="false">Hidden from wall</option></select>
        <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From date" />
        <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To date" />
        <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} aria-label="Sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
        <label className="chk"><input type="checkbox" checked={f.drafts} onChange={(e) => setF({ ...f, drafts: e.target.checked })} /> Show unfinished</label>
        <a className="mini" href={exportUrl()} style={{ color: "var(--ink)" }}>Download ZIP ({f.status || "approved"})</a>
      </div>

      {canOperate && selected.length > 0 && (
        <div className="card inl" style={{ position: "sticky", top: 0, zIndex: 5, marginBottom: 10 }}>
          <b>{selected.length} selected</b>
          <button className="mini" disabled={busy} onClick={() => bulk(selected, "approve")}>Approve</button>
          <button className="mini" disabled={busy} onClick={() => reject(selected)}>Reject</button>
          <button className="mini" disabled={busy} onClick={() => bulk(selected, "pending")}>Back to pending</button>
          <button className="mini" disabled={busy} onClick={() => bulk(selected, "hide_wall")}>Hide from wall</button>
          <button className="mini" disabled={busy} onClick={() => bulk(selected, "show_wall")}>Show on wall</button>
          <button className="mini danger" disabled={busy} onClick={() => del(selected)}>Delete</button>
          <button className="mini" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {canOperate && items.length > 0 && <label className="chk" style={{ marginBottom: 8 }}><input type="checkbox" checked={sel.size === items.length} onChange={(e) => setSel(e.target.checked ? new Set(items.map((x) => x.id)) : new Set())} /> Select all {items.length} shown</label>}

      <div className="pgrid">
        {items.map((c) => (
          <div key={c.id} className={"pcard" + (sel.has(c.id) ? " sel" : "")}>
            {canOperate && <input type="checkbox" className="pcheck" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select picture ${c.guestCode ?? ""}`} />}
            <button className="pimg" onClick={() => openItem(c.id)} aria-label={`Open picture ${c.guestCode ?? ""}`}>
              <img src={T(c.id)} alt="" loading="lazy" style={{ aspectRatio: `${c.widthPx} / ${c.heightPx}` }} />
            </button>
            <div className="pmeta">
              <span className="dot" style={{ background: COLOUR[c.moderation] }} title={c.moderation} /> <b>{c.guestCode ?? "—"}</b>
              <span className="muted"> {new Date(c.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              {!c.showOnWall && <span className="pill" title="Hidden from the photo wall">wall off</span>}
              {c.printJobs > 0 && <span className="pill" title="Print jobs">🖨 {c.printJobs}</span>}
            </div>
          </div>
        ))}
      </div>
      {items.length === 0 && <p className="muted">No pictures match these filters yet.</p>}
      {items.length < total && <button className="inline alt" style={{ margin: "16px 0" }} onClick={more}>Load more ({total - items.length} left)</button>}

      {open && (
        <div className="modal" onClick={() => setOpen(null)}>
          <div className="mbox pview" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Picture details">
            <div className="pleft">
              <img src={`/api/v1/events/${id}/compositions/${open}/image`} alt="Final picture" />
              <div className="inl" style={{ justifyContent: "space-between", marginTop: 6 }}>
                <button className="mini" disabled={idx <= 0} onClick={() => openItem(items[idx - 1].id)}>&larr; Previous</button>
                <span className="muted">{idx + 1} / {items.length}</span>
                <button className="mini" disabled={idx < 0 || idx >= items.length - 1} onClick={() => openItem(items[idx + 1].id)}>Next &rarr;</button>
              </div>
            </div>
            <div className="pright">
              {!detail ? <p className="muted">Loading…</p> : (
                <>
                  <h3 style={{ margin: "0 0 4px" }}>Guest {detail.guest.code} <span className="pill" style={{ color: COLOUR[detail.composition.moderation], borderColor: COLOUR[detail.composition.moderation] }}>{detail.composition.moderation}</span></h3>
                  <div className="muted">{detail.composition.frame.name} · {detail.composition.widthPx}×{detail.composition.heightPx}px · {(detail.composition.bytes / 1024).toFixed(0)} KB<br />{new Date(detail.composition.createdAt).toLocaleString()}</div>
                  {detail.composition.moderatedBy && <div className="muted">By {detail.composition.moderatedBy}{detail.composition.moderationNote ? ` — “${detail.composition.moderationNote}”` : ""}</div>}
                  <div style={{ margin: "8px 0" }}>Downloads <b>{detail.composition.downloads}</b> · Share taps <b>{detail.composition.shareAttempts}</b> · Print jobs <b>{detail.composition.printJobs}</b> · Wall <b>{detail.composition.showOnWall ? "shown" : "hidden"}</b></div>
                  {canOperate && (
                    <div className="inl" style={{ marginBottom: 8 }}>
                      <button className="mini primary" disabled={busy} onClick={() => bulk([detail.composition.id], "approve")}>Approve (A)</button>
                      <button className="mini" disabled={busy} onClick={() => reject([detail.composition.id])}>Reject (R)</button>
                      <button className="mini" disabled={busy} onClick={() => bulk([detail.composition.id], "pending")}>Pending</button>
                      <button className="mini" disabled={busy} onClick={() => bulk([detail.composition.id], detail.composition.showOnWall ? "hide_wall" : "show_wall")}>{detail.composition.showOnWall ? "Hide from wall" : "Show on wall"}</button>
                    </div>
                  )}
                  <h4>Original photo{detail.composition.slots.length > 1 ? "s" : ""}</h4>
                  <div className="inl">{detail.composition.slots.map((s) => (
                    <a key={s.slot} href={`/api/v1/events/${id}/uploads/${s.uploadId}/original`} target="_blank" rel="noopener noreferrer" title={`Photo ${s.slot}: ${s.width}×${s.height}px. Opens the full original.`}>
                      <img src={`/api/v1/events/${id}/uploads/${s.uploadId}/thumb?size=200`} alt={`Original ${s.slot}`} style={{ height: 90, borderRadius: 4, border: "1px solid var(--line)" }} /></a>))}</div>
                  <h4>Guest</h4>
                  <div className="muted">Started {new Date(detail.guest.startedAt).toLocaleString()} · Consent {detail.guest.consentAt ? "given " + new Date(detail.guest.consentAt).toLocaleString() : "not recorded"}</div>
                  {detail.guest.fieldsHidden ? <div className="muted">Contact details are visible to managers only.</div>
                    : Object.keys(detail.guest.fields ?? {}).length ? <table><tbody>{Object.entries(detail.guest.fields!).map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>)}</tbody></table> : <div className="muted">No details were given.</div>}
                  <div className="inl" style={{ marginTop: 12 }}>
                    <a className="mini" href={`/api/v1/events/${id}/compositions/${detail.composition.id}/image`} download={`${detail.guest.code}.jpg`} style={{ color: "var(--ink)" }}>Download final</a>
                    {canOperate && <button className="mini danger" disabled={busy} onClick={() => del([detail.composition.id])}>Delete (this picture)</button>}
                    {canManage && <button className="mini danger" onClick={() => deleteGuest(detail.guest.code)}>Delete all data for this guest</button>}
                    <button className="mini" onClick={() => setOpen(null)}>Close (Esc)</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
export default function PhotosPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
