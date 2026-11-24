"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { MODE_LABEL, PRINT_MODES, STATUS_LABEL, type PrintMode, type PrintStatus } from "@rsp/shared";
import { api, loadMe, type Me } from "../../../lib/api";

interface Job {
  id: string; status: PrintStatus; kind: "print" | "reprint"; copies: number; attempt: number; error: string | null; note: string | null;
  createdAt: string; approvedAt: string | null; startedAt: string | null; finishedAt: string | null;
  composition: { id: string; guestCode: string | null; frameName: string; widthPx: number; heightPx: number; moderation: string; createdAt: string; uploadIds: string[] };
}
interface AgentSummary { id: string; name: string; paired: boolean; enabled: boolean; online: boolean; printers: { name: string; enabled: boolean; status: string; detail: string | null; paperSize: string }[] }
interface Data { queue: { mode: PrintMode; paused: boolean; defaultCopies: number }; counts: Record<PrintStatus, number>; jobs: Job[]; agents: AgentSummary[] }
interface Hist { history: { id: number; at: string; from: string | null; to: string; note: string | null; by: string; guestCode: string | null; kind: string }[]; queueEvents: { at: string; action: string; by: string | null; detail: any }[] }

const ago = (iso: string) => { const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
const COLS: { key: string; title: string; hint: string; statuses: PrintStatus[] }[] = [
  { key: "needs", title: "Needs approval", hint: "Check the picture, then approve or reject", statuses: ["pending", "reprint_requested", "received"] },
  { key: "queue", title: "Printing queue", hint: "Approved, goes to the printer in this order", statuses: ["approved", "printing"] },
  { key: "done", title: "Printed", hint: "Latest prints", statuses: ["printed"] },
  { key: "problems", title: "Problems", hint: "Failed prints", statuses: ["failed"] },
];

function Operator({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Data | null>(null); const [eventName, setEventName] = useState("");
  const [live, setLive] = useState<"live" | "reconnecting" | "offline">("reconnecting");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const [sound, setSound] = useState(false); const [showHist, setShowHist] = useState(false); const [hist, setHist] = useState<Hist | null>(null);
  const [tab, setTab] = useState("needs");
  const [zoom, setZoom] = useState<Job | null>(null);
  const [, setTick] = useState(0);
  const audio = useRef<AudioContext | null>(null); const lastNeeds = useRef<number | null>(null);
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canOperate = role === "super_admin" || role === "event_manager" || role === "print_operator";

  const load = useCallback(async () => {
    try {
      const d = await api<Data>(`/api/v1/events/${id}/print/jobs?limit=200`);
      setData(d); setErr(""); setLive((l) => (l === "offline" ? "reconnecting" : l));
      const needs = d.counts.pending + d.counts.reprint_requested;
      if (sound && lastNeeds.current !== null && needs > lastNeeds.current) beep();
      lastNeeds.current = needs;
    } catch (x: any) { setLive("offline"); setErr(x.status === 403 ? "You do not have access to printing for this event." : "Can't reach the server. Retrying…"); }
  }, [id, sound]);
  const beep = () => {
    try { const ctx = audio.current ?? new AudioContext(); audio.current = ctx; const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.12; o.start(); o.stop(ctx.currentTime + 0.18); } catch { /* sound unavailable */ }
  };

  useEffect(() => { api<{ event: { name: string } }>(`/api/v1/events/${id}`).then((r) => setEventName(r.event.name)).catch(() => {}); }, [id]);
  useEffect(() => { load(); }, [load]);
  // Live: the server pushes a tick whenever anything changes. A slow poll backs it up, so a dropped stream never leaves the screen stale.
  useEffect(() => {
    const es = new EventSource(`/api/v1/events/${id}/print/stream`);
    es.addEventListener("hello", () => setLive("live")); es.addEventListener("tick", () => load());
    es.onerror = () => setLive("reconnecting");
    const poll = setInterval(load, 10000); const clock = setInterval(() => setTick((t) => t + 1), 15000);
    return () => { es.close(); clearInterval(poll); clearInterval(clock); };
  }, [id, load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setErr("");
    try { await fn(); await load(); } catch (x: any) { setErr(({ invalid_state: "That job already changed. The screen has been refreshed.", job_in_progress: "This picture is already being reprinted.", picture_rejected: "This picture was rejected, so it can't be printed." } as any)[x.message] ?? x.message); await load(); }
    setBusy(null);
  }
  const act = (job: Job, action: string, extra: object = {}) => run(job.id + action, () => api(`/api/v1/events/${id}/print/jobs/${job.id}/action`, { method: "POST", body: { action, ...extra } }));
  const reject = (job: Job) => { const note = prompt("Why reject this picture? (optional)"); if (note !== null) void act(job, "reject", note ? { note } : {}); };
  const bulk = (ids: string[], action: string) => run("bulk" + action, () => api(`/api/v1/events/${id}/print/jobs/bulk`, { method: "POST", body: { ids, action } }));
  const setPaused = (paused: boolean) => run("pause", () => api(`/api/v1/events/${id}/print/queue`, { method: "POST", body: { paused } }));
  const setMode = (mode: string) => run("mode", () => api(`/api/v1/events/${id}/print/mode`, { method: "POST", body: { mode } }));
  async function openHistory() { setShowHist(true); try { setHist(await api<Hist>(`/api/v1/events/${id}/print/history?limit=150`)); } catch (x: any) { setErr(x.message); } }

  const T = (cid: string) => `/api/v1/events/${id}/compositions/${cid}/thumb?size=400`;
  const jobsOf = (statuses: PrintStatus[]) => (data?.jobs ?? []).filter((j) => statuses.includes(j.status));
  const needsOldestFirst = (a: Job, b: Job) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

  const card = (j: Job) => {
    const b = (k: string) => busy === j.id + k;
    return (
      <div key={j.id} className={"opcard st-" + j.status}>
        <div className="oprow">
          <button className="opthumb" onClick={() => setZoom(j)} aria-label={`Look at picture ${j.composition.guestCode}`}><img src={T(j.composition.id)} alt="" style={{ aspectRatio: `${j.composition.widthPx} / ${j.composition.heightPx}` }} /></button>
          <div className="opinfo">
            <div className="opguest">{j.composition.guestCode ?? "—"} {j.kind === "reprint" && <span className="opbadge">reprint</span>}</div>
            <div className="opmeta">{j.composition.frameName} · {ago(j.createdAt)}</div>
            <div className="opstatus">{STATUS_LABEL[j.status]}{j.status === "printing" && j.attempt > 1 ? ` (try ${j.attempt})` : ""}</div>
            {j.error && <div className="operr">{j.error}</div>}
            <div className="opcopies">
              Copies
              {["pending", "reprint_requested", "approved", "received"].includes(j.status) && canOperate
                ? <><button aria-label="Fewer copies" disabled={j.copies <= 1 || !!busy} onClick={() => act(j, "copies", { copies: j.copies - 1 })}>−</button><b>{j.copies}</b><button aria-label="More copies" disabled={j.copies >= 50 || !!busy} onClick={() => act(j, "copies", { copies: j.copies + 1 })}>+</button></>
                : <b>{j.copies}</b>}
            </div>
            <div className="opthumbs">{j.composition.uploadIds.slice(0, 3).map((u, i) => <a key={u + i} href={`/api/v1/events/${id}/uploads/${u}/original`} target="_blank" rel="noopener noreferrer" title="Open the original photo"><img src={`/api/v1/events/${id}/uploads/${u}/thumb?size=200`} alt={`Original ${i + 1}`} /></a>)}</div>
          </div>
        </div>
        {canOperate && (
          <div className="opactions">
            {["pending", "reprint_requested", "received"].includes(j.status) && <><button className="op-go" disabled={!!busy} onClick={() => act(j, "approve")}>{b("approve") ? "…" : "Approve & print"}</button><button className="op-no" disabled={!!busy} onClick={() => reject(j)}>Reject</button></>}
            {j.status === "approved" && <><button disabled={!!busy} onClick={() => act(j, "hold")}>Hold</button><button className="op-no" disabled={!!busy} onClick={() => confirm("Cancel this print?") && act(j, "cancel")}>Cancel</button></>}
            {j.status === "failed" && <><button className="op-go" disabled={!!busy} onClick={() => act(j, "retry")}>Retry</button><button className="op-no" disabled={!!busy} onClick={() => confirm("Cancel this print?") && act(j, "cancel")}>Cancel</button></>}
            {j.status === "printed" && <><button disabled={!!busy} onClick={() => act(j, "reprint", { requestId: crypto.randomUUID() })}>Reprint</button><a className="opbtn" href={`/api/v1/events/${id}/compositions/${j.composition.id}/image`} download={`${j.composition.guestCode ?? "photo"}.jpg`}>Download</a></>}
            {j.status === "cancelled" && <button disabled={!!busy} onClick={() => act(j, "reprint", { requestId: crypto.randomUUID() })}>Print again</button>}
          </div>
        )}
      </div>
    );
  };

  const q = data?.queue; const c = data?.counts;
  const needsCount = c ? c.pending + c.reprint_requested + c.received : 0;
  return (
    <div className="op">
      <header className="ophead">
        <div><a href={`/events/${id}`} className="opback">&larr; Event</a><h1>{eventName || "Printing"}</h1></div>
        <div className={"oplive " + live}>{live === "live" ? "● Live" : live === "offline" ? "● Offline" : "● Connecting…"}</div>
        {canOperate && q && <div className="opctl">
          <label>Mode <select value={q.mode} disabled={!!busy} onChange={(e) => setMode(e.target.value)}>{PRINT_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select></label>
          <button className={q.paused ? "op-go" : "op-pause"} disabled={!!busy} onClick={() => setPaused(!q.paused)}>{q.paused ? "▶ Resume printing" : "⏸ Pause printing"}</button>
          <button onClick={() => { setSound(!sound); if (!sound) beep(); }} aria-pressed={sound}>{sound ? "🔔 Sound on" : "🔕 Sound off"}</button>
          <button onClick={openHistory}>History</button>
        </div>}
      </header>
      {q?.paused && <div className="oppaused" role="status">Printing is paused. Approved pictures wait until you press Resume.</div>}
      {data && (() => {
        // The one thing staff must never miss: pictures are being approved but nothing can print them.
        const live = data.agents.filter((a) => a.online && a.enabled);
        const ready = live.flatMap((a) => a.printers.filter((p) => p.enabled && (p.status === "ready" || p.status === "busy")));
        const waiting = (data.counts.approved ?? 0) + (data.counts.printing ?? 0);
        const problem = !data.agents.length ? "No print computer is set up for this event. Pictures will wait in the queue."
          : !live.length ? "The print computer is offline. Pictures wait in the queue until it reconnects."
          : !ready.length ? "No printer is ready: " + (live.flatMap((a) => a.printers.filter((p) => p.enabled).map((p) => `${p.name}: ${p.detail ?? p.status}`)).join("; ") || "turn a printer on under Printers in the event settings.")
          : null;
        return problem ? <div className="operrbar" role="alert">⚠ {problem}{waiting ? ` (${waiting} waiting)` : ""}</div>
          : <div className="muted" style={{ margin: "4px 0" }}>🖨 {ready.map((p) => `${p.name} (${p.paperSize})`).join(", ")} ready</div>;
      })()}
      {err && <div className="operrbar" role="alert">{err}</div>}

      <nav className="optabs" aria-label="Columns">
        {COLS.map((col) => <button key={col.key} className={tab === col.key ? "on" : ""} onClick={() => setTab(col.key)}>{col.title} <b>{col.statuses.reduce((n, s) => n + (c?.[s] ?? 0), 0)}</b></button>)}
      </nav>
      <div className="opcols">
        {COLS.map((col) => {
          const list = jobsOf(col.statuses).sort(col.key === "needs" || col.key === "queue" ? needsOldestFirst : (a, b) => needsOldestFirst(b, a)).slice(0, col.key === "done" ? 30 : 100);
          const releasable = col.key === "needs" ? list.filter((j) => j.status !== "received") : [];
          return (
            <section key={col.key} className={"opcol" + (tab === col.key ? " show" : "")}>
              <div className="opcolhead">
                <h2>{col.title} <span className="opcount">{col.statuses.reduce((n, s) => n + (c?.[s] ?? 0), 0)}</span></h2>
                <div className="muted">{col.hint}</div>
                {col.key === "needs" && canOperate && releasable.length > 1 && <button className="op-go" disabled={!!busy} onClick={() => confirm(`Approve and print all ${releasable.length} waiting pictures?`) && bulk(releasable.map((j) => j.id), "approve")}>{q?.mode === "batch" ? `Print batch (${releasable.length})` : `Approve all (${releasable.length})`}</button>}
              </div>
              {list.map(card)}
              {!list.length && <p className="opempty">{col.key === "needs" ? (q?.mode === "auto" ? "Automatic mode: pictures go straight to the printer." : needsCount ? "" : "Nothing waiting.") : "Nothing here."}</p>}
            </section>
          );
        })}
      </div>

      {zoom && (
        <div className="modal" onClick={() => setZoom(null)}>
          <div className="mbox" style={{ width: "min(560px, 100%)", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <img src={`/api/v1/events/${id}/compositions/${zoom.composition.id}/image`} alt="Final picture" style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 6 }} />
            <div style={{ margin: "8px 0" }}><b>{zoom.composition.guestCode}</b> · {zoom.composition.frameName} · {STATUS_LABEL[zoom.status]}</div>
            <button className="op-neutral" onClick={() => setZoom(null)}>Close</button>
          </div>
        </div>
      )}
      {showHist && (
        <div className="modal" onClick={() => setShowHist(false)}>
          <div className="mbox" style={{ width: "min(720px, 100%)", maxHeight: "88vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Print history">
            <h2 style={{ marginTop: 0 }}>Print history</h2>
            {!hist ? <p>Loading…</p> : (
              <>
                {hist.queueEvents.length > 0 && <><h4>Queue controls</h4><ul>{hist.queueEvents.slice(0, 8).map((e, i) => <li key={i}>{new Date(e.at).toLocaleTimeString()} · {e.by ?? "System"} · {e.action === "print_pause" ? "paused printing" : e.action === "print_resume" ? "resumed printing" : `changed mode ${e.detail?.from} → ${e.detail?.to}`}</li>)}</ul></>}
                <h4>Jobs</h4>
                <table><thead><tr><th>Time</th><th>Guest</th><th>Change</th><th>By</th><th>Note</th></tr></thead>
                  <tbody>{hist.history.map((h) => <tr key={h.id}><td>{new Date(h.at).toLocaleTimeString()}</td><td>{h.guestCode ?? "—"}{h.kind === "reprint" ? " (reprint)" : ""}</td><td>{h.from ? `${STATUS_LABEL[h.from as PrintStatus] ?? h.from} → ` : ""}{STATUS_LABEL[h.to as PrintStatus] ?? h.to}</td><td>{h.by}</td><td className="muted">{h.note ?? ""}</td></tr>)}</tbody></table>
              </>
            )}
            <button className="op-neutral" style={{ marginTop: 12 }} onClick={() => setShowHist(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PrintPage() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { loadMe().then((u) => (u ? setMe(u) : (window.location.href = "/login"))); }, []);
  return me ? <Operator me={me} /> : null;
}
