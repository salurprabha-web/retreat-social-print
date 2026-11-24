"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface St { status: string; archivedAt: string | null; retentionDays: number; purgeAt: string | null; daysLeft: number | null; hold: boolean; purgedAt: string | null; due: boolean; counts: { guests: number; pictures: number; photos: number; printJobs: number } }
const ERR: Record<string, string> = { not_archived: "Only an archived event can have its guest data deleted.", already_purged: "The guest data of this event was already deleted.", confirmation_mismatch: "The name does not match.", undelivered_data: "Some data has not reached the cloud yet. Wait until delivery has finished.", forbidden: "Only a super administrator can delete guest data." };

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [s, setS] = useState<St | null>(null); const [name, setName] = useState(""); const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canHold = role === "super_admin" || role === "event_manager"; const isSuper = me.globalRole === "super_admin";
  const load = useCallback(async () => {
    try { setS(await api<St>(`/api/v1/events/${id}/retention`)); setName((await api<{ event: { name: string } }>(`/api/v1/events/${id}`)).event.name); }
    catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); setBusy(true); try { await fn(); setMsg(ok); await load(); } catch (x: any) { setErr(ERR[x.message] ?? x.message); } setBusy(false); };
  if (!s) return <>{err && <div className="err" role="alert">{err}</div>}</>;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "");

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; {name || "Event"}</a>
      <h1>Data retention</h1>
      <div className="sub">Guest photos and details are deleted for good a set number of days after you archive the event. The event&apos;s figures (reports) are kept, without any guest data.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}

      <div className="card">
        {s.purgedAt ? (
          <><b>Guest data deleted on {when(s.purgedAt)}</b><p className="muted">All guests, photos, pictures, print jobs and share records of this event are gone, with their files. The event keeps its settings, frames and sponsors, and its <a href={`/events/${id}/reports`}>reports</a> show the totals frozen at that moment.</p></>
        ) : s.status !== "archived" ? (
          <><b>The clock has not started</b><p className="muted">Retention starts when the event is archived (Overview &gt; Archive). The period is <b>{s.retentionDays} days</b> and can be changed on the Settings tab. Until then the event&apos;s data is kept.</p></>
        ) : (
          <>
            <b>{s.hold ? "On hold: nothing will be deleted automatically" : s.due ? "Due: deletion is about to run" : `Guest data will be deleted on ${when(s.purgeAt)}`}</b>
            <p className="muted">Archived on {when(s.archivedAt)}. Retention period: {s.retentionDays} days{s.daysLeft !== null && !s.hold ? ` · ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left` : ""}.</p>
          </>
        )}
        {!s.purgedAt && <div className="grid" style={{ marginTop: 8 }}>
          <div className="card"><div className="n">{s.counts.guests}</div><div className="l">guests</div></div>
          <div className="card"><div className="n">{s.counts.photos}</div><div className="l">uploaded photos</div></div>
          <div className="card"><div className="n">{s.counts.pictures}</div><div className="l">finished pictures</div></div>
          <div className="card"><div className="n">{s.counts.printJobs}</div><div className="l">print jobs</div></div>
        </div>}
      </div>

      {!s.purgedAt && canHold && (
        <div className="card" style={{ marginTop: 14 }}>
          <label className="chk"><input type="checkbox" checked={s.hold} disabled={busy} onChange={(e) => run(() => api(`/api/v1/events/${id}/retention`, { method: "PUT", body: { hold: e.target.checked } }), e.target.checked ? "Legal hold on: nothing will be deleted automatically." : "Hold lifted.")} /> <b>Legal hold</b></label>
          <div className="muted">Stops the automatic deletion (for example during a dispute or an audit). Lift it and the normal schedule applies again.</div>
        </div>
      )}

      {!s.purgedAt && isSuper && s.status === "archived" && (
        <div className="card" style={{ marginTop: 14, borderColor: "var(--bad)" }}>
          <b style={{ color: "var(--bad)" }}>Delete the guest data now</b>
          <p className="muted">This cannot be undone. Photos, pictures, guest details, print history and shares of this event are deleted immediately instead of on the scheduled date. Reports keep the totals.</p>
          <div className="row"><input placeholder={`Type the event name to confirm: ${name}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button className="inline" style={{ background: "var(--bad)" }} disabled={busy || typed !== name} onClick={() => run(() => api(`/api/v1/events/${id}/retention/purge`, { method: "POST", body: { confirmName: typed } }), "Guest data deleted.")}>Delete now</button></div>
        </div>
      )}
      <p className="muted" style={{ marginTop: 14 }}>Guests are told how their photos are used when they give consent (the consent text and privacy link are set in the guest page). Deleting an individual guest&apos;s data on request is done from the Photos tab.</p>
    </>
  );
}
export default function RetentionPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
