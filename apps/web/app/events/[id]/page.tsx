"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, type Me } from "../../../lib/api";
import { Shell } from "../../../components/Shell";

interface Settings {
  printMode: string; defaultCopies: number; maxUploadMb: number; retentionDays: number; requireConsent: boolean;
  photoWallEnabled: boolean; mosaicEnabled: boolean; instagramHandle: string | null; suggestedCaption: string | null;
  branding: { primaryColor?: string; clientLogo?: string; eventLogo?: string };
}
interface Ev {
  id: string; name: string; slug: string; guestToken: string; clientName: string | null; hashtag: string | null;
  eventDate: string | null; status: string; settings: Settings;
}
const TABS = ["Overview", "Branding", "Settings", "Guest page", "Frames (Phase 6)", "Printing (Phase 10)"];

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [ev, setEv] = useState<Ev | null>(null);
  const [tab, setTab] = useState("Overview");
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [logoVer, setLogoVer] = useState(0);
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";
  const isSuper = role === "super_admin";

  const load = useCallback(async () => {
    try { setEv((await api<{ event: Ev }>(`/api/v1/events/${id}`)).event); } catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setErr(""); setMsg("");
    try { await fn(); setMsg(ok); await load(); } catch (x: any) { setErr(x.message); }
  }
  const patch = (body: object, ok = "Saved.") => act(() => api(`/api/v1/events/${id}`, { method: "PATCH", body }), ok);
  const setStatus = (status: string) => act(() => api(`/api/v1/events/${id}/status`, { method: "POST", body: { status } }), `Event is now ${status}.`);

  async function upload(kind: "client" | "event", f: File | undefined) {
    if (!f) return;
    setErr(""); setMsg("");
    const res = await fetch(`/api/v1/events/${id}/logo/${kind}`, {
      method: "POST", credentials: "same-origin", body: f,
      headers: { "content-type": f.type || "application/octet-stream", "x-rsp-csrf": (await api<{ csrf: string }>("/api/v1/auth/me")).csrf },
    });
    if (res.ok) { setMsg("Logo uploaded."); setLogoVer((v) => v + 1); await load(); }
    else setErr(({ unsupported_image: "Use a PNG, JPG, WebP or SVG image.", unsafe_svg: "That SVG contains scripts or external references and was rejected.", unsupported: "Unsupported file." } as any)[(await res.json().catch(() => ({}))).error] ?? "Upload failed (max 5 MB).");
  }
  async function duplicate() {
    try { const r = await api<{ event: { id: string } }>(`/api/v1/events/${id}/duplicate`, { method: "POST" }); window.location.href = `/events/${r.event.id}`; } catch (x: any) { setErr(x.message); }
  }
  async function del() {
    const name = prompt(`Permanently delete this event and ALL its photos and records. This cannot be undone.\nType the event name to confirm:\n${ev?.name}`);
    if (name === null) return;
    try { await api(`/api/v1/events/${id}`, { method: "DELETE", body: { confirmName: name } }); window.location.href = "/events"; } catch (x: any) { setErr(x.message === "confirmation_mismatch" ? "Name did not match; nothing was deleted." : x.message); }
  }

  if (!ev) return err ? <div className="err">{err}</div> : null;
  const guestUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/g/${ev.guestToken}`;
  const s = ev.settings;
  return (
    <>
      <a href="/events" className="muted">&larr; All events</a>
      <h1>{ev.name} <span className={"pill " + ev.status}>{ev.status}</span></h1>
      <div className="sub">{ev.clientName ?? "No client"} &middot; {ev.eventDate ?? "No date"} {ev.hashtag && <>&middot; #{ev.hashtag}</>}</div>
      <div className="tabs">{TABS.map((t) => <button key={t} className={"tab" + (tab === t ? " on" : "")} disabled={t.includes("Phase")} onClick={() => (t === "Guest page" ? (window.location.href = `/events/${id}/builder`) : setTab(t))}>{t}</button>)}</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}

      {tab === "Overview" && (
        <div className="card">
          <p><b>Guest URL</b> (becomes live once the guest site ships in Phase 5):<br /><code>{guestUrl}</code></p>
          <p><b>Print mode:</b> {s.printMode} &middot; <b>Retention:</b> {s.retentionDays} days &middot; <b>Consent required:</b> {s.requireConsent ? "yes" : "no"}</p>
          {canEdit && (
            <div className="row">
              {ev.status !== "active" && ev.status !== "archived" && <button className="inline" onClick={() => setStatus("active")}>Activate</button>}
              {ev.status === "active" && <button className="inline alt" onClick={() => setStatus("inactive")}>Deactivate</button>}
              {ev.status !== "archived" && <button className="inline alt" onClick={() => confirm("Archive this event?") && setStatus("archived")}>Archive</button>}
              {ev.status === "archived" && <button className="inline alt" onClick={() => setStatus("inactive")}>Restore</button>}
              {isSuper && <button className="inline alt" onClick={duplicate}>Duplicate</button>}
              {isSuper && <button className="inline danger" onClick={del}>Delete</button>}
            </div>
          )}
        </div>
      )}

      {tab === "Branding" && (
        <div className="card">
          {(["client", "event"] as const).map((k) => {
            const has = k === "client" ? s.branding.clientLogo : s.branding.eventLogo;
            return (
              <div key={k} style={{ marginBottom: 20 }}>
                <label>{k === "client" ? "Client logo" : "Event logo"} (PNG, JPG, WebP or SVG, max 5 MB)</label>
                {has ? <img className="logo" alt={`${k} logo`} src={`/api/v1/events/${id}/logo/${k}?v=${logoVer}`} /> : <div className="muted">No logo uploaded.</div>}
                {canEdit && <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => upload(k, e.target.files?.[0])} />}
              </div>
            );
          })}
          <label>Primary colour</label>
          <input type="color" disabled={!canEdit} value={s.branding.primaryColor ?? "#b8862b"} onChange={(e) => patch({ settings: { primaryColor: e.target.value } }, "Colour saved.")} style={{ width: 80, padding: 2 }} />
        </div>
      )}

      {tab === "Settings" && <SettingsForm key={ev.id + ev.settings.retentionDays} ev={ev} canEdit={canEdit} onSave={patch} />}
    </>
  );
}

function SettingsForm({ ev, canEdit, onSave }: { ev: Ev; canEdit: boolean; onSave: (b: object) => void }) {
  const [f, setF] = useState({
    name: ev.name, clientName: ev.clientName ?? "", hashtag: ev.hashtag ?? "", eventDate: ev.eventDate ?? "",
    printMode: ev.settings.printMode, defaultCopies: ev.settings.defaultCopies, maxUploadMb: ev.settings.maxUploadMb,
    retentionDays: ev.settings.retentionDays, requireConsent: ev.settings.requireConsent, photoWallEnabled: ev.settings.photoWallEnabled,
    mosaicEnabled: ev.settings.mosaicEnabled, instagramHandle: ev.settings.instagramHandle ?? "", suggestedCaption: ev.settings.suggestedCaption ?? "",
  });
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const fs = useRef<HTMLFormElement>(null);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name: f.name, clientName: f.clientName, hashtag: f.hashtag.replace(/^#/, ""), ...(f.eventDate ? { eventDate: f.eventDate } : {}),
      settings: {
        printMode: f.printMode, defaultCopies: +f.defaultCopies, maxUploadMb: +f.maxUploadMb, retentionDays: +f.retentionDays,
        requireConsent: f.requireConsent, photoWallEnabled: f.photoWallEnabled, mosaicEnabled: f.mosaicEnabled,
        instagramHandle: f.instagramHandle || null, suggestedCaption: f.suggestedCaption || null,
      },
    });
  }
  return (
    <form ref={fs} className="card" onSubmit={submit}>
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <label>Event name</label><input value={f.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
        <label>Client</label><input value={f.clientName} onChange={(e) => set("clientName", e.target.value)} />
        <label>Hashtag (no #)</label><input value={f.hashtag} onChange={(e) => set("hashtag", e.target.value)} />
        <label>Event date</label><input type="date" value={f.eventDate} onChange={(e) => set("eventDate", e.target.value)} />
        <label>Print mode</label>
        <select value={f.printMode} onChange={(e) => set("printMode", e.target.value)}>
          <option value="manual">Manual approval</option><option value="auto">Automatic printing</option><option value="batch">Batch printing</option>
        </select>
        <label>Default copies (1-10)</label><input type="number" min={1} max={10} value={f.defaultCopies} onChange={(e) => set("defaultCopies", e.target.value)} />
        <label>Max upload size (MB, 1-100)</label><input type="number" min={1} max={100} value={f.maxUploadMb} onChange={(e) => set("maxUploadMb", e.target.value)} />
        <label>Photo retention (days) before automatic deletion</label><input type="number" min={1} max={3650} value={f.retentionDays} onChange={(e) => set("retentionDays", e.target.value)} />
        <label>Instagram account</label><input value={f.instagramHandle} onChange={(e) => set("instagramHandle", e.target.value)} />
        <label>Suggested caption</label><input value={f.suggestedCaption} onChange={(e) => set("suggestedCaption", e.target.value)} />
        <label className="check"><input type="checkbox" checked={f.requireConsent} onChange={(e) => set("requireConsent", e.target.checked)} /> Require guest consent</label>
        <label className="check"><input type="checkbox" checked={f.photoWallEnabled} onChange={(e) => set("photoWallEnabled", e.target.checked)} /> Live photo wall</label>
        <label className="check"><input type="checkbox" checked={f.mosaicEnabled} onChange={(e) => set("mosaicEnabled", e.target.checked)} /> Photo mosaic</label>
        {canEdit && <button>Save settings</button>}
      </fieldset>
    </form>
  );
}

export default function EventPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
