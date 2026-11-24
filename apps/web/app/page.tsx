"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Shell } from "../components/Shell";
import { LineChart, VIZ_CSS } from "../components/charts";
import type { ActivityDay, EventsOverviewRow } from "@rsp/shared";

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

function Body({ name, role }: { name: string; role: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [act, setAct] = useState<ActivityDay[] | null>(null); const [evs, setEvs] = useState<EventsOverviewRow[] | null>(null);
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
    api<{ days: ActivityDay[] }>(`/api/v1/dashboard/activity?days=14&tz=${encodeURIComponent(tz)}`).then((r) => setAct(r.days)).catch(() => {});
    api<{ events: EventsOverviewRow[] }>(`/api/v1/reports/events?from=${day(new Date(Date.now() - 29 * 86400000))}&to=${day(new Date())}&tz=${encodeURIComponent(tz)}`).then((r) => setEvs(r.events)).catch(() => {});
  }, []);
  useEffect(() => { api<Overview>("/api/v1/dashboard/overview").then(setData).catch((x) => setErr(x.message)); }, []);
  return (
    <>
      <h1>Dashboard</h1>
      <div className="sub">Signed in as {name} ({role.replace("_", " ")})</div>
      {err && <div className="err">{err}</div>}
      <div className="grid">
        {data && CARDS.map(([k, label, bad]) => (
          <div key={k} className={"card" + (bad && data[k] > 0 ? " bad" : "")}>
            <div className="n">{data[k]}</div><div className="l">{label}</div>
          </div>
        ))}
      </div>
      <style>{VIZ_CSS}</style>
      {act && <div style={{ marginTop: 18 }}><LineChart title="Last 14 days" sub="Finished pictures and completed prints across your events" rows={act} series={[{ key: "completed", label: "Finished pictures", slot: 1 }, { key: "printed", label: "Prints completed", slot: 2 }]} height={220} /></div>}
      {evs && evs.length > 0 && (
        <>
          <h2 style={{ marginTop: 22 }}>Events, last 30 days</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            <table><thead><tr><th>Event</th><th>Status</th><th>Guests</th><th>Finished</th><th>Printed</th><th>Failed attempts</th><th>Shares</th><th>Downloads</th><th>QR scans</th><th /></tr></thead>
              <tbody>{evs.map((e) => <tr key={e.eventId}><td><a href={`/events/${e.eventId}`}>{e.name}</a></td><td><span className={"pill " + (e.status === "active" ? "active" : "")}>{e.status}</span></td><td>{e.sessions}</td><td>{e.completed}</td><td>{e.printed}</td><td style={e.failedAttempts ? { color: "var(--bad)" } : undefined}>{e.failedAttempts}</td><td>{e.shareAttempts}</td><td>{e.downloads}</td><td>{e.scans}</td><td><a href={`/events/${e.eventId}/reports`}>Report</a></td></tr>)}</tbody></table>
          </div>
        </>
      )}
    </>
  );
}

export default function Dashboard() {
  return <Shell active="dashboard">{(me) => <Body name={me.name} role={me.globalRole} />}</Shell>;
}
