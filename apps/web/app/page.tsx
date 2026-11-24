"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Shell } from "../components/Shell";

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
    </>
  );
}

export default function Dashboard() {
  return <Shell active="dashboard">{(me) => <Body name={me.name} role={me.globalRole} />}</Shell>;
}
