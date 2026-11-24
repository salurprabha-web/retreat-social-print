"use client";
import { useEffect, useState, type ReactNode } from "react";
import { api, loadMe, type Me } from "../lib/api";
import { SyncBar } from "./SyncBar";

export function Shell({ active, children }: { active: "dashboard" | "events" | "users" | "account"; children: (me: Me) => ReactNode }) {
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
        {me.globalRole === "super_admin" && <a className={"nav" + (active === "users" ? " on" : "")} href="/users">Users</a>}
        <a className={"nav" + (active === "account" ? " on" : "")} href="/account">Account</a>
        <button className="ghost" onClick={logout}>Sign out</button>
      </aside>
      <main className="main"><SyncBar />{children(me)}</main>
    </div>
  );
}
