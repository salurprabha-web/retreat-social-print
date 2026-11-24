"use client";
import { useEffect, useState } from "react";
import { api, loadMe, type Me } from "../lib/api";

interface Overview {
  totalEvents: number; activeEvents: number; totalSubmissions: number; photosPending: number; photosApproved: number;
  photosPrinted: number; failedPrints: number; totalDownloads: number; shareAttempts: number; activeDevices: number; totalDevices: number;
}

const CARDS: [keyof Overview, string, boolean?][] = [
  ["totalEvents", "Total events"], ["activeEvents", "Active events"], ["totalSubmissions", "Submissions"],
  ["photosPending", "Photos pending"], ["photosApproved", "Photos approved"], ["photosPrinted", "Photos printed"],
  ["failedPrints", "Failed prints", true], ["totalDownloads", "Downloads"], ["shareAttempts", "Share attempts"],
  ["activeDevices", "Active devices"],
];

export default function Dashboard() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    loadMe().then(async (u) => {
      setMe(u);
      if (!u) { window.location.href = "/login"; return; }
      try { setData(await api<Overview>("/api/v1/dashboard/overview")); } catch (x: any) { setErr(x.message); }
    });
  }, []);
  async function logout() { await api("/api/v1/auth/logout", { method: "POST" }); window.location.href = "/login"; }
  if (!me) return null;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">RETREAT SOCIAL PRINT</div>
        <div className="tag">CAPTURE. CUSTOMIZE. SHARE. PRINT.</div>
        <a className="nav on" href="/">Dashboard</a>
        <a className="nav" href="#" aria-disabled title="Phase 3">Events (Phase 3)</a>
        <button className="ghost" onClick={logout}>Sign out</button>
      </aside>
      <main className="main">
        <h1>Dashboard</h1>
        <div className="sub">Signed in as {me.name} ({me.globalRole.replace("_", " ")})</div>
        {err && <div className="err">{err}</div>}
        <div className="grid">
          {data && CARDS.map(([k, label, bad]) => (
            <div key={k} className={"card" + (bad && data[k] > 0 ? " bad" : "")}>
              <div className="n">{data[k]}</div><div className="l">{label}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
