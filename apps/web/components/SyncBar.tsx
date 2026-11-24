"use client";
import { useEffect, useState } from "react";
import type { SyncStatus } from "@rsp/shared";

/** One line shown on every admin page of a LOCAL venue server: is the cloud reachable and how much is still waiting to be delivered. Absent on the cloud. */
export function SyncBar() {
  const [s, setS] = useState<SyncStatus | null>(null);
  useEffect(() => {
    let live = true; let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch("/api/v1/sync/status", { credentials: "same-origin", cache: "no-store" });
        if (r.ok) { const j = (await r.json()) as SyncStatus; if (live) setS(j); if (j.mode === "cloud") return; }   // the cloud never needs this bar: stop asking
      } catch { /* server unreachable: keep showing the last state */ }
      if (live) t = setTimeout(tick, 10000);
    };
    tick();
    return () => { live = false; clearTimeout(t); };
  }, []);
  if (!s || s.mode !== "local") return null;
  const online = s.cloudReachable === true && !s.lastError;
  const refused = s.cloudReachable === true && !!s.lastError;
  const label = !s.configured ? "Local server: not connected to the cloud (nothing is delivered yet)"
    : online ? "Local server: cloud connected"
    : refused ? `Local server: the cloud refused the connection (${s.lastError})`
    : s.cloudReachable === null ? "Local server: connecting to the cloud…"
    : "Local server: cloud not reachable. Everything keeps working here and is delivered when the connection returns";
  const colour = online ? "var(--ok)" : s.configured ? "var(--bad)" : "var(--muted)";
  return (
    <div role="status" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "8px 14px", marginBottom: 14, borderRadius: 10, border: `1px solid ${colour}`, fontSize: 13 }}>
      <span style={{ width: 10, height: 10, borderRadius: 99, background: colour, flex: "none" }} aria-hidden />
      <span style={{ flex: 1, minWidth: 220 }}>{label}</span>
      {s.configured && <span><b>{s.pendingTotal}</b> item{s.pendingTotal === 1 ? "" : "s"} waiting to be delivered</span>}
      {s.lastSuccessAt && <span className="muted">last delivered {new Date(s.lastSuccessAt).toLocaleTimeString()}</span>}
    </div>
  );
}
