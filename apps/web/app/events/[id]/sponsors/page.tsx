"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { MAX_SPONSORS_PER_EVENT } from "@rsp/shared";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface Sponsor { id: string; name: string; url: string | null; hashtag: string | null; active: boolean; hasLogo: boolean; placement: { guest: boolean; wall: boolean }; frames: number }
const ERR: Record<string, string> = {
  validation: "Check the values: the link must start with https:// and the hashtag may only use letters, numbers and underscore.",
  too_many_sponsors: `That is the most sponsors one event can have (${MAX_SPONSORS_PER_EVENT}).`,
  unsupported_image: "Use a PNG, JPG, WebP or SVG image.", unsafe_svg: "That SVG contains scripts or external references and was rejected.", too_large: "The logo must be under 2 MB.", image_required: "Choose an image file.",
};

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [list, setList] = useState<Sponsor[] | null>(null); const [v, setV] = useState(0);        // v busts the logo cache after an upload
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", url: "", hashtag: "" });
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager";
  const load = useCallback(async () => {
    try { setList((await api<{ sponsors: Sponsor[] }>(`/api/v1/events/${id}/sponsors`)).sponsors); }
    catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok = "Saved.") => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); await load(); } catch (x: any) { setErr(ERR[x.message] ?? x.message); } };

  const body = (s: Sponsor, over: Partial<Sponsor> = {}) => { const m = { ...s, ...over }; return { name: m.name, url: m.url || null, hashtag: m.hashtag || null, active: m.active, placement: m.placement }; };
  const save = (s: Sponsor, over: Partial<Sponsor>) => run(() => api(`/api/v1/events/${id}/sponsors/${s.id}`, { method: "PUT", body: body(s, over) }));
  async function add(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => { await api(`/api/v1/events/${id}/sponsors`, { method: "POST", body: { name: draft.name, url: draft.url || null, hashtag: draft.hashtag || null } }); setDraft({ name: "", url: "", hashtag: "" }); }, "Sponsor added. Upload its logo next.");
  }
  async function upload(s: Sponsor, file: File | undefined) {
    if (!file) return;
    await run(async () => {
      const csrf = (await api<{ csrf: string }>("/api/v1/auth/me")).csrf;
      const res = await fetch(`/api/v1/events/${id}/sponsors/${s.id}/logo`, { method: "POST", credentials: "same-origin", body: file, headers: { "content-type": "application/octet-stream", "x-rsp-csrf": csrf } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setV((n) => n + 1);
    }, "Logo uploaded.");
  }
  const move = (i: number, d: number) => { if (!list) return; const ids = list.map((s) => s.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; run(() => api(`/api/v1/events/${id}/sponsors/reorder`, { method: "POST", body: { ids } }), "Order saved."); };
  const remove = (s: Sponsor) => confirm(`Delete sponsor "${s.name}" and its logo?${s.frames ? `\n${s.frames} frame(s) will stay but lose their sponsor.` : ""}`) &&
    run(() => api(`/api/v1/events/${id}/sponsors/${s.id}`, { method: "DELETE" }), "Sponsor deleted.");

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; Event</a>
      <h1>Sponsors</h1>
      <div className="sub">Add the event&apos;s sponsors once, then choose where each one appears: guest screens, the photo wall, and printed pictures (through a sponsor&apos;s own frames).</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}

      {canEdit && (
        <form className="card row" onSubmit={add}>
          <input placeholder="Sponsor name *" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={80} />
          <input placeholder="Website (https://…)" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} maxLength={500} />
          <input placeholder="Hashtag (optional)" value={draft.hashtag} onChange={(e) => setDraft({ ...draft, hashtag: e.target.value })} maxLength={41} />
          <button className="inline">Add sponsor</button>
        </form>
      )}

      {list?.map((s, i) => (
        <div key={s.id} className="card" style={{ marginTop: 14, opacity: s.active ? 1 : .7 }}>
          <div className="inl" style={{ gap: 16, alignItems: "flex-start" }}>
            <div style={{ width: 150, flex: "none" }}>
              {s.hasLogo ? <img className="logo" src={`/api/v1/events/${id}/sponsors/${s.id}/logo?v=${v}`} alt={`${s.name} logo`} style={{ maxWidth: 150 }} /> : <div className="muted" style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: 18, textAlign: "center" }}>No logo yet</div>}
              {canEdit && <label className="mini" style={{ display: "inline-block", marginTop: 6, cursor: "pointer" }}>{s.hasLogo ? "Replace logo" : "Upload logo"}
                <input type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => { upload(s, e.target.files?.[0]); e.target.value = ""; }} /></label>}
              {canEdit && s.hasLogo && <button className="mini" style={{ marginLeft: 6 }} onClick={() => run(() => api(`/api/v1/events/${id}/sponsors/${s.id}/logo`, { method: "DELETE" }), "Logo removed.")}>Remove</button>}
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div className="grid2">
                <label>Name<input disabled={!canEdit} defaultValue={s.name} maxLength={80} onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && save(s, { name: e.target.value })} /></label>
                <label>Website<input disabled={!canEdit} defaultValue={s.url ?? ""} maxLength={500} placeholder="https://…" onBlur={(e) => (e.target.value || null) !== s.url && save(s, { url: e.target.value || null })} /></label>
                <label>Hashtag<input disabled={!canEdit} defaultValue={s.hashtag ? `#${s.hashtag}` : ""} maxLength={41} onBlur={(e) => (e.target.value.replace(/^#/, "") || null) !== s.hashtag && save(s, { hashtag: e.target.value || null })} /></label>
              </div>
              <div className="inl" style={{ gap: 14, marginTop: 8 }}>
                <label className="chk"><input type="checkbox" disabled={!canEdit} checked={s.active} onChange={(e) => save(s, { active: e.target.checked })} /> <b>{s.active ? "Active" : "Off"}</b></label>
                <label className="chk"><input type="checkbox" disabled={!canEdit} checked={s.placement.guest} onChange={(e) => save(s, { placement: { ...s.placement, guest: e.target.checked } })} /> Guest screens</label>
                <label className="chk"><input type="checkbox" disabled={!canEdit} checked={s.placement.wall} onChange={(e) => save(s, { placement: { ...s.placement, wall: e.target.checked } })} /> Photo wall</label>
                <span className="muted">Printed pictures: {s.frames ? `${s.frames} frame${s.frames > 1 ? "s" : ""} (` : "none yet ("}<a href={`/events/${id}/frames`}>Frames</a>)</span>
              </div>
              {s.hashtag && <div className="muted" style={{ marginTop: 6 }}>#{s.hashtag} is added to guests&apos; share captions{s.frames ? ", only for pictures made in this sponsor's frames" : " for every picture"}.</div>}
              {!s.hasLogo && (s.placement.guest || s.placement.wall) && <div className="muted" style={{ marginTop: 6 }}>Without a logo, the wall skips this sponsor and guest screens show its name.</div>}
            </div>
            {canEdit && <div className="inl" style={{ flexDirection: "column", gap: 4 }}>
              <button className="mini" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
              <button className="mini" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
              <button className="mini" onClick={() => remove(s)}>Delete</button>
            </div>}
          </div>
        </div>
      ))}
      {list && !list.length && <p className="muted">No sponsors yet. Add one above.</p>}

      <div className="card" style={{ marginTop: 18 }}>
        <b>How to print a sponsor&apos;s logo</b>
        <ol className="muted" style={{ margin: "6px 0 0 18px" }}>
          <li>Open <a href={`/events/${id}/frames`}>Frames</a> and open (or create) the frame for that sponsor.</li>
          <li>In the bar at the top, set <i>Sponsor</i> to this sponsor.</li>
          <li>Add a <i>Logo</i> layer, choose <i>Frame&apos;s sponsor logo</i>, then place and size it. It is part of the final image, so it appears in the download, the wall and the print.</li>
        </ol>
      </div>
    </>
  );
}
export default function SponsorsPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
