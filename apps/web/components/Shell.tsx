"use client";
import { useEffect, useState, type ReactNode } from "react";
import { api, loadMe, type Me } from "../lib/api";

export function Shell({ active, children }: { active: "dashboard" | "events"; children: (me: Me) => ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { loadMe().then((u) => { if (!u) window.location.href = "/login"; else setMe(u); }); }, []);
  async function logout() { await api("/api/v1/auth/logout", { method: "POST" }); window.location.href = "/login"; }
  if (!me) return null;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">RETREAT SOCIAL PRINT</div>
        <div className="tag">CAPTURE. CUSTOMIZE. SHARE. PRINT.</div>
        <a className={"nav" + (active === "dashboard" ? " on" : "")} href="/">Dashboard</a>
        <a className={"nav" + (active === "events" ? " on" : "")} href="/events">Events</a>
        <button className="ghost" onClick={logout}>Sign out</button>
      </aside>
      <main className="main">{children(me)}</main>
    </div>
  );
}
