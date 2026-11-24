"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { SyncStatus } from "@rsp/shared";
import { api, type Me } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";

interface Cred { id: string; name: string; createdAt: string; lastSeenAt: string | null; lastIp: string | null; revoked: boolean }
const ERR: Record<string, string> = {
  not_a_package: "That file is not an event package.", package_damaged: "The package is damaged or incomplete. Download it again.", checksum_mismatch: "A file in the package is damaged. Download it again.",
  version_mismatch: "This server runs a different version of the software than the cloud. Update it to the same release first.", bad_file_name: "The package contains a file name that is not allowed.",
  unknown_table: "The package contains data this server does not accept.", wrong_event_in_package: "The package is inconsistent.", event_name_or_link_in_use: "Another event on this server already uses this name or link.",
  forbidden: "Only a super administrator can install a package.", not_local_mode: "This is the cloud server. Packages are installed on the local venue server.", too_many_credentials: "That is the most active sync credentials one event can have.",
  sync_not_configured: "This server has no cloud address and sync credential yet (see the setup steps).",
};

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const [st, setSt] = useState<SyncStatus | null>(null); const [creds, setCreds] = useState<Cred[]>([]);
  const [name, setName] = useState(""); const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const role = me.globalRole === "super_admin" ? "super_admin" : me.eventRoles[id];
  const canEdit = role === "super_admin" || role === "event_manager"; const isSuper = me.globalRole === "super_admin";

  const load = useCallback(async () => {
    try {
      const s = await api<SyncStatus>("/api/v1/sync/status"); setSt(s);
      if (s.mode === "cloud") setCreds((await api<{ credentials: Cred[] }>(`/api/v1/events/${id}/sync-credentials`)).credentials);
    } catch (x: any) { setErr(x.status === 403 ? "You do not have access to this event." : x.message); }
  }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); setBusy(true); try { await fn(); setMsg(ok); await load(); } catch (x: any) { setErr(ERR[x.message] ?? x.message); } setBusy(false); };

  if (!st) return <>{err && <div className="err" role="alert">{err}</div>}</>;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const ev = st.events.find((e) => e.eventId === id);

  return (
    <>
      <a href={`/events/${id}`} className="muted">&larr; Event</a>
      <h1>Offline mode</h1>
      <div className="sub">For venues with unreliable internet: run a local server at the venue. Guests, printing and the wall keep working on the local network, and everything is delivered to the cloud when the connection allows.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}

      {st.mode === "cloud" && (
        <>
          <div className="card">
            <b>1. Event package</b>
            <p className="muted">Everything the venue server needs to run this event: settings, the published guest page, frames, sponsors, QR codes, wall and mosaic settings and their image files. It contains no guest data, no staff accounts and no printers. Links and QR codes stay the same.</p>
            {canEdit ? <a className="mini" href={`/api/v1/events/${id}/offline/package`}>Download event package</a> : <span className="muted">Only an event manager can download it.</span>}
            <p className="muted">Download it again after you change the event; installing it again refreshes the configuration without touching guests already on the venue server.</p>
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <b>2. Sync credentials</b>
            <p className="muted">A credential lets one venue server deliver this event&apos;s data, and nothing else. It is shown once. Revoke it at any time.</p>
            {canEdit && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api<{ name: string; token: string }>(`/api/v1/events/${id}/sync-credentials`, { method: "POST", body: { name } }); setFresh(r); setName(""); }, "Credential created. Copy it now: it is not shown again."); }}>
                <input placeholder="Name of the venue server, e.g. Ballroom laptop *" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
                <button className="inline" disabled={busy}>Create credential</button>
              </form>
            )}
            {fresh && (
              <div className="card" style={{ borderColor: "var(--brand)", marginTop: 10 }}>
                <b>{fresh.name}</b> — put these two lines in the venue server&apos;s environment:
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "Consolas, monospace", fontSize: 13, margin: "8px 0" }}>{`CLOUD_URL=${origin}\nSYNC_TOKENS=${fresh.token}`}</pre>
                <button className="mini" onClick={() => navigator.clipboard?.writeText(`CLOUD_URL=${origin}\nSYNC_TOKENS=${fresh.token}`).then(() => setMsg("Copied."))}>Copy</button> <button className="mini" onClick={() => setFresh(null)}>Done</button>
              </div>
            )}
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Venue server</th><th>Created</th><th>Last contact</th><th /></tr></thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.id} style={{ opacity: c.revoked ? .55 : 1 }}>
                    <td>{c.name} {c.revoked && <span className="pill">revoked</span>}</td>
                    <td>{new Date(c.createdAt).toLocaleString()}</td>
                    <td>{c.lastSeenAt ? <>{new Date(c.lastSeenAt).toLocaleString()}<div className="muted">{c.lastIp}</div></> : <span className="muted">never</span>}</td>
                    <td>{canEdit && !c.revoked && <button className="mini" onClick={() => confirm(`Revoke "${c.name}"? That venue server can no longer deliver data.`) && run(() => api(`/api/v1/events/${id}/sync-credentials/${c.id}`, { method: "DELETE" }), "Credential revoked.")}>Revoke</button>}</td>
                  </tr>
                ))}
                {!creds.length && <tr><td colSpan={4} className="muted">No credentials yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <b>3. At the venue</b>
            <ol className="muted" style={{ margin: "6px 0 0 18px" }}>
              <li>Install the software on a laptop or mini PC and start it with <code>RSP_MODE=local</code>, its own database, and the two lines from step 2. See <code>docs/OFFLINE.md</code>.</li>
              <li>Sign in there as super administrator and install the event package (Event &gt; Offline mode).</li>
              <li>Print the QR codes from the <i>local</i> server, so they point at the venue network, and pair the print computer with the local server&apos;s address.</li>
            </ol>
            <p className="muted">Pictures delivered from a venue server appear here as read-only records. They are never printed again from the cloud.</p>
          </div>
        </>
      )}

      {st.mode === "local" && (
        <>
          <div className="card">
            <div className="inl" style={{ justifyContent: "space-between" }}>
              <b>Connection to the cloud</b>
              <button className="inline" disabled={busy || !st.configured} onClick={() => run(() => api("/api/v1/sync/run", { method: "POST" }), "Delivery finished.")}>{busy ? "Delivering…" : "Deliver now"}</button>
            </div>
            {!st.configured ? <p className="muted">Not configured: this server has no cloud address or sync credential. Set <code>CLOUD_URL</code> and <code>SYNC_TOKENS</code> in its environment and restart it.</p> : (
              <div className="grid" style={{ marginTop: 10 }}>
                <div className="card"><div className="n" style={{ fontSize: 20 }}>{st.cloudReachable === null ? "…" : st.cloudReachable && !st.lastError ? "Connected" : st.cloudReachable ? "Refused" : "Offline"}</div><div className="l">{st.cloudUrl}</div></div>
                <div className="card"><div className="n">{ev ? ev.pending : st.pendingTotal}</div><div className="l">waiting to be delivered</div></div>
                <div className="card"><div className="n" style={{ fontSize: 18 }}>{st.lastSuccessAt ? new Date(st.lastSuccessAt).toLocaleTimeString() : "never"}</div><div className="l">last complete delivery</div></div>
              </div>
            )}
            {st.lastError && <div className="err" role="alert">{st.lastError}</div>}
            <p className="muted">While the cloud is unreachable, guests, the print queue and the wall keep working here. Nothing is lost: pending items are delivered automatically, in the right order, without duplicates. Sharing to Instagram and WhatsApp needs the guest&apos;s own internet and may not work on venue Wi-Fi without it.</p>
          </div>

          {isSuper && (
            <div className="card" style={{ marginTop: 14 }}>
              <b>Install or refresh an event package</b>
              <p className="muted">Choose the package downloaded from the cloud. Installing it again refreshes the event&apos;s configuration; guests already here are not touched.</p>
              <label className="mini" style={{ display: "inline-block", cursor: "pointer" }}>Choose package file…
                <input type="file" hidden accept=".rspkg,application/octet-stream" disabled={busy} onChange={(e) => {
                  const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
                  run(async () => {
                    const csrf = (await api<{ csrf: string }>("/api/v1/auth/me")).csrf;
                    const res = await fetch("/api/v1/offline/import", { method: "POST", credentials: "same-origin", body: f, headers: { "content-type": "application/octet-stream", "x-rsp-csrf": csrf } });
                    const j = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
                    setMsg(`Installed "${j.name}" (${j.files} files).`);
                  }, "Package installed.");
                }} /></label>
            </div>
          )}
        </>
      )}
    </>
  );
}
export default function OfflinePage() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
