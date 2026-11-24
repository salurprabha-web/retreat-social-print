"use client";
import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "../../lib/api";
import { Shell } from "../../components/Shell";

interface Ev { id: string; name: string; clientName: string | null; hashtag: string | null; eventDate: string | null; status: string; submissions: number }

function Body({ me }: { me: Me }) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState(""); const [q, setQ] = useState("");
  const [form, setForm] = useState({ name: "", clientName: "", hashtag: "", eventDate: "" });
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(true);
  const isSuper = me.globalRole === "super_admin";

  const load = useCallback(async () => {
    const p = new URLSearchParams(); if (status) p.set("status", status); if (q) p.set("q", q);
    try { setEvents((await api<{ events: Ev[] }>(`/api/v1/events?${p}`)).events); } catch (x: any) { setErr(x.message); }
    setLoading(false);
  }, [status, q]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    const body: Record<string, string> = { name: form.name };
    if (form.clientName) body.clientName = form.clientName;
    if (form.hashtag) body.hashtag = form.hashtag.replace(/^#/, "");
    if (form.eventDate) body.eventDate = form.eventDate;
    try {
      const r = await api<{ event: { id: string } }>("/api/v1/events", { method: "POST", body });
      window.location.href = `/events/${r.event.id}`;
    } catch (x: any) { setErr(x.message === "validation" ? "Check the event name (min 2 characters) and hashtag (letters/numbers only)." : x.message); }
  }

  return (
    <>
      <h1>Events</h1>
      <div className="sub">Each event has its own branding, frames, guest journey and records.</div>
      {isSuper && (
        <form className="card row" onSubmit={create}>
          <input placeholder="Event name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input placeholder="Client" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} />
          <input placeholder="Hashtag" value={form.hashtag} onChange={(e) => setForm({ ...form, hashtag: e.target.value })} />
          <input type="date" value={form.eventDate} onChange={(e) => setForm({ ...form, eventDate: e.target.value })} aria-label="Event date" />
          <button className="inline">Create event</button>
        </form>
      )}
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ margin: "16px 0" }}>
        <input placeholder="Search name or client" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          <option value="">All statuses</option>
          {["draft", "active", "inactive", "archived"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Event</th><th>Client</th><th>Date</th><th>Status</th><th>Photos</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td><a href={`/events/${e.id}`}>{e.name}</a>{e.hashtag && <span className="muted"> #{e.hashtag}</span>}</td>
                <td>{e.clientName ?? "-"}</td><td>{e.eventDate ?? "-"}</td>
                <td><span className={"pill " + e.status}>{e.status}</span></td><td>{e.submissions}</td>
              </tr>
            ))}
            {!loading && events.length === 0 && <tr><td colSpan={5} className="muted">No events yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Events() { return <Shell active="events">{(me) => <Body me={me} />}</Shell>; }
