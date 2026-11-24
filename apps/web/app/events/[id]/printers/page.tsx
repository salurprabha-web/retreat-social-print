"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface Printer { id: string; name: string; label: string; enabled: boolean; status: string; detail: string | null; paperSize: string; orientation: string; driverPapers: string[]; lastSeenAt: string | null }
interface Agent { id: string; name: string; enabled: boolean; paired: boolean; version: string | null; hostName: string | null; lastSeenAt: string | null; online: boolean; pairingExpiresAt: string | null; printers: Printer[] }
const PAPERS = ["4x6", "5x7", "6x8", "2x6", "A5"];
const ERR: Record<string, string> = { paper_size_required: "Choose the paper loaded in this printer before turning it on.", too_many_agents: "That is the most computers one event can have." };

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [agents, setAgents] = useState<Agent[] | null>(null); const [minV, setMinV] = useState("");
  const [name, setName] = useState(""); const [code, setCode] = useState<{ deviceId: string; code: string; mins: number } | null>(null);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canManage = role === "super_admin" || role === "event_manager";
  const load = useCallback(async () => {
    try { const r = await api<{ agents: Agent[]; minAgentVersion: string }>(`/api/v1/events/${id}/agents`); setAgents(r.agents); setMinV(r.minAgentVersion); }
    catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok = "Saved.") => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); await load(); } catch (x: any) { setErr(ERR[x.message] ?? x.message); } };

  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    try { const r = await api<{ deviceId: string; pairingCode: string; expiresInMinutes: number }>(`/api/v1/events/${id}/agents`, { method: "POST", body: { name } }); setCode({ deviceId: r.deviceId, code: r.pairingCode, mins: r.expiresInMinutes }); setName(""); await load(); }
    catch (x: any) { setErr(ERR[x.message] ?? x.message); }
  }
  const repair = (a: Agent) => confirm(`Make a new pairing code for "${a.name}"? Its current connection stops working immediately.`) &&
    run(async () => { const r = await api<{ pairingCode: string; expiresInMinutes: number }>(`/api/v1/events/${id}/agents/${a.id}/pairing`, { method: "POST" }); setCode({ deviceId: a.id, code: r.pairingCode, mins: r.expiresInMinutes }); }, "New code created.");
  const patchPrinter = (p: Printer, body: object) => run(() => api(`/api/v1/events/${id}/printers/${p.id}`, { method: "PATCH", body }));

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; Event</a>
      <h1>Printers</h1>
      <div className="sub">Print computers run the Retreat Print Agent, which sends approved pictures to the printers attached to that computer. A printer prints nothing until you turn it on and say which paper it holds.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}
      {code && (
        <div className="card" style={{ borderColor: "var(--brand)" }}>
          <b>Pairing code</b> (works once, for {code.mins} minutes)
          <div style={{ fontSize: 34, fontFamily: "Consolas, monospace", letterSpacing: ".15em", margin: "6px 0" }}>{code.code}</div>
          <div className="muted">On the print computer: install the agent, open it, press <i>Pair this computer</i>, enter this server&apos;s address (<code>{typeof window !== "undefined" ? window.location.origin : ""}</code>) and the code.</div>
          <button className="mini" style={{ marginTop: 8 }} onClick={() => setCode(null)}>Done</button>
        </div>
      )}
      {canManage && (
        <form className="card row" onSubmit={create}>
          <input placeholder="Name of the print computer, e.g. Print desk laptop *" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          <button className="inline">Add print computer</button>
        </form>
      )}
      {agents?.map((a) => (
        <div key={a.id} className="card" style={{ marginTop: 14 }}>
          <div className="inl" style={{ justifyContent: "space-between" }}>
            <div><b>{a.name}</b> <span className={"pill " + (a.online ? "active" : "")}>{!a.paired ? "waiting to be paired" : a.online ? "online" : "offline"}</span>{!a.enabled && <span className="pill">disabled</span>}
              <div className="muted">{a.hostName ? `${a.hostName} · ` : ""}{a.version ? `agent v${a.version}` : ""}{a.version && minV && a.version.localeCompare(minV, undefined, { numeric: true }) < 0 ? " (update needed)" : ""}{a.lastSeenAt ? ` · last contact ${new Date(a.lastSeenAt).toLocaleTimeString()}` : ""}</div></div>
            {canManage && <div className="inl">
              <button className="mini" onClick={() => repair(a)}>{a.paired ? "Re-pair…" : "New code"}</button>
              <button className="mini" onClick={() => run(() => api(`/api/v1/events/${id}/agents/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } }), a.enabled ? "Computer disabled." : "Computer enabled.")}>{a.enabled ? "Disable" : "Enable"}</button>
              <button className="mini danger" onClick={() => confirm(`Remove "${a.name}"? Its printers are removed too; print history is kept.`) && run(() => api(`/api/v1/events/${id}/agents/${a.id}`, { method: "DELETE" }), "Removed.")}>Remove</button>
            </div>}
          </div>
          {a.pairingExpiresAt && <div className="muted">A pairing code is waiting (expires {new Date(a.pairingExpiresAt).toLocaleTimeString()}).</div>}
          {a.paired && a.printers.length === 0 && <p className="muted">Waiting for the agent to report its printers…</p>}
          {a.printers.length > 0 && (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Printer on that computer</th><th>Windows says</th><th>Paper loaded</th><th>Orientation</th><th>Use for jobs</th></tr></thead>
              <tbody>
                {a.printers.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}<div className="muted" title={p.driverPapers.join("\n")}>{p.driverPapers.length} driver paper sizes</div></td>
                    <td><span className={"pill " + (p.status === "ready" || p.status === "busy" ? "active" : "")}>{p.status}</span>{p.detail && <div className="muted">{p.detail}</div>}</td>
                    <td><select disabled={!canManage} value={p.paperSize} onChange={(e) => patchPrinter(p, { paperSize: e.target.value })}><option value="any">Choose…</option>{PAPERS.map((x) => <option key={x}>{x}</option>)}</select></td>
                    <td><select disabled={!canManage} value={p.orientation} onChange={(e) => patchPrinter(p, { orientation: e.target.value })}><option value="auto">Automatic</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></td>
                    <td><label className="chk"><input type="checkbox" disabled={!canManage} checked={p.enabled} onChange={(e) => patchPrinter(p, { enabled: e.target.checked })} /> {p.enabled ? "On" : "Off"}</label></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {agents && !agents.length && <p className="muted">No print computers yet. Add one above to get a pairing code.</p>}
    </>
  );
}
export default function PrintersPage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
