"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { MOSAIC_LOGO_POSITIONS, type MosaicSettings } from "@rsp/shared";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface Stats { cells: number; filled: number; percent: number; eligible: number; unused: number; processing: number }
interface Loaded { settings: MosaicSettings; token: string; path: string; master: { width: number; height: number } | null; grid: { cols: number; rows: number; cells: number } | null; stats: Stats }
const ERR: Record<string, string> = {
  validation: "Some values are out of range. Check the limits shown.", unsupported_image: "Use a JPG, PNG or WebP photo (not SVG).",
  too_large: "The master image must be under 25 MB.", master_too_small: "The master image must be at least 200 pixels on its short side.", image_required: "Choose an image file.",
  network: "The upload did not go through. Check the connection and try again.", upload_not_found: "The upload did not arrive. Try again.", bad_ticket: "The upload expired. Try again.",
};
const POS: Record<string, string> = { none: "No logo", center: "Centre", "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right" };

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Loaded | null>(null); const [s, setS] = useState<MosaicSettings | null>(null); const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);                                            // bumps the preview picture after a change
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";

  const load = useCallback(async (keepForm = false) => {
    try { const r = await api<Loaded>(`/api/v1/events/${id}/mosaic`); setD(r); if (!keepForm) { setS(r.settings); setDirty(false); } }
    catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => { load(true); setRev((n) => n + 1); }, 10000); return () => clearInterval(t); }, [load]);   // live progress and preview; never overwrites the form

  if (!d || !s) return <>{err && <div className="err" role="alert">{err}</div>}</>;
  const url = typeof window !== "undefined" ? `${window.location.origin}${d.path}` : d.path;
  const set = (p: Partial<MosaicSettings>) => { setS({ ...s, ...p }); setDirty(true); };
  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); setBusy(true); try { await fn(); setMsg(ok); await load(); setRev((n) => n + 1); } catch (x: any) { setErr(ERR[x.message] ?? x.message); } setBusy(false); };

  const save = () => run(() => api(`/api/v1/events/${id}/mosaic`, { method: "PUT", body: s }), "Saved. Open screens update within seconds.");
  async function uploadMaster(file: File | undefined) {
    if (!file) return;
    if (d!.stats.filled > 0 && !confirm("A new master image places every picture again. Continue?")) return;
    await run(async () => {
      // Object storage (the Vercel deployment): send the file straight to the bucket, then ask the server to check and install it.
      // Local-disk servers answer 501 and take the file themselves.
      let ask: { upload: { method: string; url: string; headers: Record<string, string> }; ticket: string } | null = null;
      try { ask = await api(`/api/v1/events/${id}/mosaic/master/upload-url`, { method: "POST", body: { bytes: file.size } }); }
      catch (e: any) { if (e.message !== "direct_upload_unavailable") throw e; }
      if (ask) {
        let put: Response;
        try { put = await fetch(ask.upload.url, { method: ask.upload.method, headers: ask.upload.headers, body: file }); } catch { throw new Error("network"); }
        if (!put.ok) throw new Error("network");
        await api(`/api/v1/events/${id}/mosaic/master/confirm`, { method: "POST", body: { ticket: ask.ticket } });
        return;
      }
      const csrf = (await api<{ csrf: string }>("/api/v1/auth/me")).csrf;
      const res = await fetch(`/api/v1/events/${id}/mosaic/master`, { method: "POST", credentials: "same-origin", body: file, headers: { "content-type": "application/octet-stream", "x-rsp-csrf": csrf } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    }, "Master image saved. Pictures are placed as they arrive.");
  }
  const rebuild = () => confirm("Clear every tile and place all pictures again?") && run(() => api(`/api/v1/events/${id}/mosaic/rebuild`, { method: "POST" }), "Rebuilt.");
  const regenerate = () => confirm("Make a new mosaic link? Screens showing the old link stop working immediately.") && run(() => api(`/api/v1/events/${id}/mosaic/regenerate-token`, { method: "POST" }), "New link created. The old link no longer works.");
  const st = d.stats; const live = d.settings.enabled;

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; Event</a>
      <h1>Photo mosaic</h1>
      <div className="sub">Guests&apos; finished pictures become tiles of one large picture you choose. Each picture goes to the spot whose colour fits it best, and the mosaic fills in as the event goes on.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}

      <div className="card">
        <div className="inl" style={{ justifyContent: "space-between" }}>
          <label className="chk"><input type="checkbox" disabled={!canEdit} checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> <b>Mosaic is {s.enabled ? "on" : "off"}</b></label>
          <span className="muted">{live ? "Live: anyone with the link can watch." : "Off: nothing is placed and the link shows nothing."}</span>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>Display link (works without a login, for a TV or projector):</div>
        <div className="row"><input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button className="mini" onClick={() => navigator.clipboard?.writeText(url).then(() => setMsg("Link copied."))}>Copy</button>
          <a className="mini" href={d.path} target="_blank" rel="noopener noreferrer">Open display</a>
          {canEdit && <button className="mini" onClick={regenerate}>New link</button>}</div>
        {!d.master && <div className="muted" style={{ marginTop: 6 }}>The display shows nothing until a master image is uploaded.</div>}
      </div>

      {d.grid && (
        <div className="grid" style={{ margin: "14px 0" }}>
          <div className="card"><div className="n">{st.filled}<span className="muted"> / {st.cells}</span></div><div className="l">tiles filled ({st.percent}%)</div></div>
          <div className="card"><div className="n">{st.eligible}</div><div className="l">pictures allowed on the mosaic</div></div>
          <div className="card"><div className="n">{st.unused}</div><div className="l">{st.unused ? "not placed: the mosaic is full (more tiles needed)" : "left over"}</div></div>
          <div className="card"><div className="n">{d.grid.cols}×{d.grid.rows}</div><div className="l">grid of tiles</div></div>
        </div>
      )}
      {st.processing > 0 && <div className="muted">Placing {st.processing} more picture(s)…</div>}

      <div className="card" style={{ marginTop: 14 }}>
        <b>Master image</b>
        <div className="inl" style={{ gap: 16, alignItems: "flex-start", marginTop: 8 }}>
          {d.master ? <img src={`/api/v1/events/${id}/mosaic/master?v=${d.grid?.cells}-${d.master.width}`} alt="Master" style={{ maxWidth: 220, maxHeight: 160, borderRadius: 8, border: "1px solid var(--line)" }} /> : <div className="muted" style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: 24 }}>No master image yet</div>}
          <div>
            {canEdit && <label className="mini" style={{ display: "inline-block", cursor: "pointer" }}>{d.master ? "Replace master image" : "Upload master image"}
              <input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { uploadMaster(e.target.files?.[0]); e.target.value = ""; }} disabled={busy} /></label>}
            <div className="muted" style={{ marginTop: 6 }}>The picture the mosaic will form (for example the event logo or a group photo). JPG, PNG or WebP, up to 25 MB. Replacing it places every picture again.</div>
            {d.master && <div className="muted">{d.master.width}×{d.master.height}px</div>}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <b>Settings</b>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label>Tiles wanted (25 to 5000)<input type="number" disabled={!canEdit} min={25} max={5000} value={s.tileTarget} onChange={(e) => set({ tileTarget: num(e.target.value, 25, 5000) })} /></label>
          <label>Download width in pixels (1600 to 10000)<input type="number" disabled={!canEdit} min={1600} max={10000} step={100} value={s.outputWidth} onChange={(e) => set({ outputWidth: num(e.target.value, 1600, 10000) })} /></label>
          <label>Picture strength over the master ({s.tintPct}% pulled toward the master&apos;s colour)<input type="range" disabled={!canEdit} min={0} max={70} value={s.tintPct} onChange={(e) => set({ tintPct: num(e.target.value, 0, 70) })} /></label>
          <label>Empty tiles<select disabled={!canEdit} value={s.empty} onChange={(e) => set({ empty: e.target.value as any })}><option value="dim">Dimmed master (progress is easy to see)</option><option value="master">Master at full brightness</option></select></label>
          <label>Event logo on the mosaic<select disabled={!canEdit} value={s.logo.position} onChange={(e) => set({ logo: { ...s.logo, position: e.target.value as any } })}>{MOSAIC_LOGO_POSITIONS.map((p) => <option key={p} value={p}>{POS[p]}</option>)}</select></label>
          <label>Logo size (% of width)<input type="number" disabled={!canEdit || s.logo.position === "none"} min={5} max={40} value={s.logo.sizePct} onChange={(e) => set({ logo: { ...s.logo, sizePct: num(e.target.value, 5, 40) } })} /></label>
          <label>Display title<input disabled={!canEdit} maxLength={100} value={s.title} onChange={(e) => set({ title: e.target.value })} /></label>
        </div>
        <div className="inl" style={{ gap: 14, marginTop: 8 }}>
          <label className="chk"><input type="checkbox" disabled={!canEdit} checked={s.moderationRequired} onChange={(e) => set({ moderationRequired: e.target.checked })} /> Only use <b>approved</b> pictures (recommended)</label>
          <label className="chk"><input type="checkbox" disabled={!canEdit || s.logo.position === "none"} checked={s.logo.plate} onChange={(e) => set({ logo: { ...s.logo, plate: e.target.checked } })} /> Light backing behind the logo</label>
          <label className="chk"><input type="checkbox" disabled={!canEdit} checked={s.showProgress} onChange={(e) => set({ showProgress: e.target.checked })} /> Show the progress bar on the display</label>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>Rejected, deleted and hidden-from-the-wall pictures, and pictures of guests who chose to stay off the big screen, are never used. The event logo is the one set under Branding. Changing the number of tiles places every picture again.</div>
        {canEdit && <div className="row" style={{ marginTop: 12 }}>
          <button className="inline" onClick={save} disabled={!dirty || busy}>Save</button>
          {dirty && <span className="muted">Unsaved changes.</span>}
        </div>}
      </div>

      {d.master && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="inl" style={{ justifyContent: "space-between" }}>
            <b>Live preview</b>
            <span className="inl">
              <a className="mini" href={`/api/v1/events/${id}/mosaic/download`}>Download finished mosaic</a>
              {canEdit && <button className="mini" onClick={rebuild} disabled={busy}>Rebuild</button>}
            </span>
          </div>
          {live ? <img src={`/api/v1/events/${id}/mosaic/image?w=1600&r=${rev}`} alt="Mosaic preview" style={{ width: "100%", marginTop: 8, borderRadius: 8, border: "1px solid var(--line)" }} />
            : <p className="muted">Turn the mosaic on to see it fill. The download shows the current state: {st.filled} tile(s).</p>}
          <div className="muted" style={{ marginTop: 6 }}>The download is a JPEG at the width above (kept within about 50 megapixels). It reflects the pictures placed right now.</div>
        </div>
      )}
      {!canEdit && <p className="muted">You can see the mosaic but only an event manager can change it.</p>}
    </>
  );
}
export default function MosaicAdminPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
