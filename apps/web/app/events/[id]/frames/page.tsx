"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { FRAME_FORMATS, PRESETS, PRESET_LABEL, type EventInfo, type FrameLayer } from "@rsp/shared";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";
import { FrameCanvas, SAMPLE_PHOTO } from "../../../../components/FrameCanvas";

interface Frame { id: string; name: string; format: string; orientation: string; widthPx: number; heightPx: number; active: boolean; sponsorId?: string | null; layers: FrameLayer[] }

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [ev, setEv] = useState<(EventInfo & { settings: { branding: { clientLogo?: string; eventLogo?: string } } }) | null>(null);
  const [err, setErr] = useState("");
  const [sponsors, setSponsors] = useState<{ id: string; name: string; hasLogo: boolean }[]>([]);
  useEffect(() => { api<{ sponsors: { id: string; name: string; hasLogo: boolean }[] }>(`/api/v1/events/${id}/sponsors`).then((r) => setSponsors(r.sponsors)).catch(() => {}); }, [id]);
  const [f, setF] = useState({ name: "", format: "4x6", orientation: "portrait", preset: "single", w: 4, h: 6 });
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";

  const load = useCallback(async () => {
    try {
      setFrames((await api<{ frames: Frame[] }>(`/api/v1/events/${id}/frames`)).frames);
      setEv((await api<{ event: any }>(`/api/v1/events/${id}`)).event);
    } catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try {
      const body: any = { name: f.name, format: f.format, orientation: f.orientation, preset: f.preset };
      if (f.format === "custom") { body.customWidthIn = Number(f.w); body.customHeightIn = Number(f.h); }
      const r = await api<{ frame: { id: string } }>(`/api/v1/events/${id}/frames`, { method: "POST", body });
      window.location.href = `/events/${id}/frames/${r.frame.id}`;
    } catch (x: any) { setErr(x.message === "validation" ? "Check the name and custom size (1 to 12 inches)." : x.message); }
  }
  async function dup(fid: string) { try { await api(`/api/v1/events/${id}/frames/${fid}/duplicate`, { method: "POST" }); await load(); } catch (x: any) { setErr(x.message); } }
  async function del(fr: Frame) {
    if (!confirm(`Delete frame "${fr.name}"? This cannot be undone.`)) return;
    try { await api(`/api/v1/events/${id}/frames/${fr.id}`, { method: "DELETE" }); await load(); }
    catch (x: any) { setErr(x.message === "frame_in_use" ? "Photos were already made with this frame, so it can't be deleted. Turn it off in the designer instead." : x.message); }
  }
  const info: EventInfo = ev ?? { name: "Event", hashtag: null, eventDate: null, clientName: null };
  const logos = { event: !!ev?.settings.branding.eventLogo, client: !!ev?.settings.branding.clientLogo };

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; {ev?.name ?? "Event"}</a>
      <h1>Frames</h1>
      <div className="sub">Frames guests choose from. Each frame defines one or more photo placeholders plus overlays, text and logos.</div>
      {err && <div className="err" role="alert">{err}</div>}
      {canEdit && (
        <form className="card" onSubmit={create}>
          <div className="row">
            <input placeholder="Frame name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })} aria-label="Paper size">
              {Object.entries(FRAME_FORMATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select value={f.orientation} onChange={(e) => setF({ ...f, orientation: e.target.value })} aria-label="Orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>
            <select value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value })} aria-label="Starting layout">{PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}</select>
            {f.format === "custom" && <><input type="number" step="0.1" min={1} max={12} value={f.w} onChange={(e) => setF({ ...f, w: +e.target.value })} aria-label="Width in inches" /><input type="number" step="0.1" min={1} max={12} value={f.h} onChange={(e) => setF({ ...f, h: +e.target.value })} aria-label="Height in inches" /></>}
            <button className="inline">Create and design</button>
          </div>
        </form>
      )}
      <div className="fgrid">
        {frames?.map((fr) => (
          <div key={fr.id} className="card fcard">
            <a href={`/events/${id}/frames/${fr.id}`} style={{ display: "block", lineHeight: 0, border: "1px solid var(--line)", alignSelf: "center" }}>
              <FrameCanvas widthPx={fr.widthPx} heightPx={fr.heightPx} layers={fr.layers} event={info} displayWidth={fr.widthPx > fr.heightPx ? 220 : 130}
                assetUrl={(n) => `/api/v1/events/${id}/frame-assets/${n}`} logoUrl={(k) => (logos[k] ? `/api/v1/events/${id}/logo/${k}` : null)} sponsorLogo={sponsors.find((s) => s.id === fr.sponsorId && s.hasLogo) ? `/api/v1/events/${id}/sponsors/${fr.sponsorId}/logo` : null} photos={Object.fromEntries(fr.layers.filter((l) => l.type === "photo").map((l: any) => [l.slot, SAMPLE_PHOTO]))} />
            </a>
            <div><b>{fr.name}</b> {!fr.active && <span className="pill">off</span>}</div>
            <div className="muted">{FRAME_FORMATS[fr.format as keyof typeof FRAME_FORMATS]?.label ?? fr.format} · {fr.widthPx}×{fr.heightPx}px · {fr.layers.filter((l) => l.type === "photo").length} photo(s)</div>
            <div className="inl">
              <a className="mini" href={`/events/${id}/frames/${fr.id}`} style={{ textDecoration: "none", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6, color: "var(--ink)" }}>{canEdit ? "Edit" : "View"}</a>
              {canEdit && <><button className="mini" onClick={() => dup(fr.id)}>Duplicate</button><button className="mini danger" onClick={() => del(fr)}>Delete</button></>}
            </div>
          </div>
        ))}
        {frames && !frames.length && <p className="muted">No frames yet. Create one above.</p>}
      </div>
    </>
  );
}
export default function FramesPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
