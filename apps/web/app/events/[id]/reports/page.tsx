"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { DailyReport, FramesReport, OperatorsReport, PrintersReport, SummaryReport, Totals } from "@rsp/shared";
import { api } from "../../../../lib/api";
import { Shell } from "../../../../components/Shell";
import { FunnelChart, LineChart, VIZ_CSS, type Series } from "../../../../components/charts";

const PRESETS = [["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["all", "All time"]] as const;
const ZONES = ["UTC", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"];
const SERIES: Series[] = [{ key: "sessions", label: "Guests", slot: 1 }, { key: "completed", label: "Finished pictures", slot: 2 }, { key: "printed", label: "Prints completed", slot: 3 }, { key: "shareAttempts", label: "Share attempts", slot: 4 }];
const GROUPS: { title: string; items: [keyof Totals, string][] }[] = [
  { title: "Guests", items: [["scans", "QR scans"], ["sessions", "Guests"], ["uploads", "Photos uploaded"], ["frameSelections", "Frame selections"], ["completed", "Finished pictures"]] },
  { title: "Sharing", items: [["instagramAttempts", "Instagram attempts"], ["whatsappAttempts", "WhatsApp attempts"], ["nativeAttempts", "Other share attempts"], ["downloads", "Downloads"], ["uniqueSharers", "Guests who shared or downloaded"]] },
  { title: "Printing", items: [["printJobs", "Print jobs"], ["printed", "Prints completed"], ["copiesPrinted", "Paper copies"], ["failedAttempts", "Failed attempts"], ["reprints", "Reprints"]] },
  { title: "Photo wall (all time)", items: [["wallAppearances", "Wall appearances"], ["wallPictures", "Pictures shown"]] },
];

const dayIn = (tz: string, d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ERR: Record<string, string> = { bad_date: "That is not a valid date.", bad_range: "The start date must not be after the end date.", bad_timezone: "Unknown time zone.", range_too_long: "The daily chart covers at most 366 days. Choose a shorter range." };

function Body() {
  const { id } = useParams<{ id: string }>();
  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const zones = useMemo(() => [...new Set([browserTz, ...ZONES])], [browserTz]);
  const [tz, setTz] = useState(browserTz); const [preset, setPreset] = useState<string>("30");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [data, setData] = useState<{ s: SummaryReport; d: DailyReport; f: FramesReport; o: OperatorsReport; p: PrintersReport } | null>(null);
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false); const [name, setName] = useState("");

  const range = useMemo(() => {
    if (preset === "custom") return { from, to };
    if (preset === "all") return { from: "", to: "" };
    const today = dayIn(tz); return { from: preset === "today" ? today : addDays(today, -(Number(preset) - 1)), to: today };
  }, [preset, from, to, tz]);
  const qs = useMemo(() => { const p = new URLSearchParams({ tz }); if (range.from) p.set("from", range.from); if (range.to) p.set("to", range.to); return p.toString(); }, [range, tz]);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const get = <T,>(r: string) => api<T>(`/api/v1/events/${id}/reports/${r}?${qs}`);
      const [s, d, f, o, p] = await Promise.all([get<SummaryReport>("summary"), get<DailyReport>("daily"), get<FramesReport>("frames"), get<OperatorsReport>("operators"), get<PrintersReport>("printers")]);
      setData({ s, d, f, o, p });
      setName((await api<{ event: { name: string } }>(`/api/v1/events/${id}`)).event.name);
    } catch (x: any) { setErr(x.status === 403 ? "You do not have access to reports for this event." : ERR[x.message] ?? x.message); }
    setLoading(false);
  }, [id, qs]);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const csv = (n: string) => `/api/v1/events/${id}/reports/${n}/csv?${qs}`;
  const t = data?.s.totals;

  return (
    <>
      <style>{VIZ_CSS}</style>
      <a href={`/events/${id}`} className="muted">&larr; {name || "Event"}</a>
      <h1>Reports</h1>
      <div className="sub">What guests did, what was shared and printed, and who handled it. Every number is a count of real records.</div>

      <div className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="inl" role="group" aria-label="Period" style={{ gap: 6 }}>
          {PRESETS.map(([k, l]) => <button key={k} className={"mini" + (preset === k ? " on" : "")} aria-pressed={preset === k} style={{ margin: 0, width: "auto", ...(preset === k ? { outline: "2px solid var(--brand)" } : {}) }} onClick={() => setPreset(k)}>{l}</button>)}
        </div>
        <label style={{ margin: 0 }}>From<input type="date" value={preset === "custom" ? from : range.from} onChange={(e) => { setPreset("custom"); setFrom(e.target.value); if (preset !== "custom") setTo(range.to); }} /></label>
        <label style={{ margin: 0 }}>To<input type="date" value={preset === "custom" ? to : range.to} onChange={(e) => { setPreset("custom"); setTo(e.target.value); if (preset !== "custom") setFrom(range.from); }} /></label>
        <label style={{ margin: 0 }}>Time zone<select value={tz} onChange={(e) => setTz(e.target.value)}>{zones.map((z) => <option key={z}>{z}</option>)}</select></label>
        <span className="muted" style={{ marginLeft: "auto" }}>{loading ? "Updating…" : data ? `Updated ${new Date(data.s.generatedAt).toLocaleTimeString()}` : ""}</span>
      </div>
      {err && <div className="err" role="alert">{err}</div>}

      {data?.s.archived && <div className="card" style={{ marginTop: 14, borderColor: "var(--brand)" }}><b>Archived figures</b><div className="muted">This event's guest data was deleted under the retention policy. These are the totals frozen at that moment for the whole event; the period and time zone filters do not apply, and the list of pictures is empty.</div></div>}
      {data && t && (
        <>
          <div className="inl" style={{ margin: "14px 0 6px", gap: 8 }}>
            <a className="mini" href={`/api/v1/events/${id}/reports/pdf?${qs}`}>Download PDF report</a>
            <span className="muted">CSV:</span>
            {[["summary", "Summary"], ["daily", "Daily"], ["frames", "Frames"], ["printers", "Printers"], ["operators", "Operators"], ["submissions", "All pictures"]].map(([k, l]) => <a key={k} className="mini" href={csv(k)}>{l}</a>)}
          </div>

          {GROUPS.map((g) => (
            <div key={g.title} style={{ marginTop: 14 }}>
              <div className="muted" style={{ marginBottom: 6, fontWeight: 600 }}>{g.title}</div>
              <div className="grid">{g.items.map(([k, l]) => <div key={k} className={"card" + (k === "failedAttempts" && t[k] > 0 ? " bad" : "")}><div className="n">{t[k].toLocaleString()}</div><div className="l">{l}</div></div>)}</div>
            </div>
          ))}
          <p className="muted">Share attempts are taps on a share button: the platform cannot see whether a post was published. QR scans include any visit to the QR link. A failed attempt that was retried successfully still counts as a failed attempt.</p>

          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            <FunnelChart title="Guest journey" sub="Guests who started in this period, and how far they got" steps={data.s.funnel} />
            <LineChart title="Daily activity" sub={`${data.d.range.from} to ${data.d.range.to} (${data.d.range.tz})${preset === "all" ? " · all time shows the last 30 days here" : ""}`} rows={data.d.rows} series={SERIES} />
          </div>

          <h2 style={{ marginTop: 22 }}>Frame popularity</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            <table><thead><tr><th>Frame</th><th>Paper</th><th>Chosen</th><th>Finished</th><th style={{ minWidth: 140 }}>Share of finished</th><th>Printed</th><th>Share attempts</th><th>Downloads</th><th>Shared or downloaded</th></tr></thead>
              <tbody>{data.f.rows.map((f) => (
                <tr key={f.frameId}><td>{f.name}{f.sponsor && <div className="muted">Sponsor: {f.sponsor}</div>}{!f.active && <span className="pill">off</span>}</td><td>{f.format}</td><td>{f.selections}</td><td>{f.completed}</td>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ flex: 1, height: 8, background: "var(--line)", borderRadius: "0 4px 4px 0" }}><div style={{ width: `${f.completedPct}%`, height: 8, background: "#2a78d6", borderRadius: "0 4px 4px 0" }} /></div><span className="muted">{f.completedPct}%</span></div></td>
                  <td>{f.printed}</td><td>{f.shareAttempts}</td><td>{f.downloads}</td><td>{f.sharedOrDownloadedPct}%</td></tr>))}
                {!data.f.rows.length && <tr><td colSpan={9} className="muted">No frames yet.</td></tr>}</tbody></table>
          </div>

          <h2 style={{ marginTop: 22 }}>Printers</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            <table><thead><tr><th>Printer</th><th>Computer</th><th>Paper</th><th>Jobs printed</th><th>Copies</th><th>Jobs failed</th><th>Success</th><th>Avg time per job</th></tr></thead>
              <tbody>{data.p.rows.map((p) => <tr key={p.printerId ?? "none"}><td>{p.name}</td><td>{p.computer ?? ""}</td><td>{p.paper ?? ""}</td><td>{p.printed}</td><td>{p.copiesPrinted}</td><td>{p.failed}</td><td>{p.successPct === null ? "" : `${p.successPct}%`}</td><td>{p.avgSeconds === null ? "" : `${p.avgSeconds} s`}</td></tr>)}
                {!data.p.rows.length && <tr><td colSpan={8} className="muted">No printers yet.</td></tr>}</tbody></table>
            <p className="muted">Jobs are counted when they finish. A job that failed and then printed on a retry counts as printed, on the printer that finished it.</p>
          </div>

          <h2 style={{ marginTop: 22 }}>Operators</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            <table><thead><tr><th>Operator</th><th>Approved</th><th>Rejected</th><th>Hidden</th><th>Deleted</th><th>Print OK</th><th>Held</th><th>Cancelled</th><th>Retried</th><th>Reprints</th><th>Total</th><th>Last action</th></tr></thead>
              <tbody>{data.o.rows.map((o) => <tr key={o.userId ?? o.name}><td>{o.name}{o.email && <div className="muted">{o.email}</div>}</td><td>{o.approved}</td><td>{o.rejected}</td><td>{o.hidden}</td><td>{o.deleted}</td><td>{o.printApproved}</td><td>{o.held}</td><td>{o.cancelled}</td><td>{o.retried}</td><td>{o.reprintsRequested}</td><td><b>{o.total}</b></td><td>{o.lastAt ? new Date(o.lastAt).toLocaleString() : ""}</td></tr>)}
                {!data.o.rows.length && <tr><td colSpan={12} className="muted">No operator actions in this period.</td></tr>}</tbody></table>
            <p className="muted">{data.o.note}</p>
          </div>

          {data.s.qr.length > 0 && (<>
            <h2 style={{ marginTop: 22 }}>QR codes</h2>
            <div className="card"><table><thead><tr><th>Code</th><th>Scans</th></tr></thead><tbody>{data.s.qr.map((q) => <tr key={q.code}><td>{q.label ?? q.code}</td><td>{q.scans}</td></tr>)}</tbody></table></div>
          </>)}
        </>
      )}
    </>
  );
}
export default function ReportsPage() { return <Shell active="events">{() => <Body />}</Shell>; }
