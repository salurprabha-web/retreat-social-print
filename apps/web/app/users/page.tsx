"use client";
import { useCallback, useEffect, useState } from "react";
import { ROLES } from "@rsp/shared";
import { api, type Me } from "../../lib/api";
import { Shell } from "../../components/Shell";

interface U { id: string; email: string; name: string; superAdmin: boolean; active: boolean; locked: boolean; createdAt: string; lastLoginAt: string | null; passwordChangedAt: string | null; eventRoles: { eventId: string; eventName: string; role: string }[] }
interface Ev { id: string; name: string; status: string }
const ERR: Record<string, string> = {
  weak_password: "That password is not strong enough.", email_in_use: "Another account already uses that email.", cannot_deactivate_self: "You cannot deactivate your own account.",
  cannot_demote_self: "You cannot remove your own administrator rights.", last_super_admin: "There must always be at least one active super administrator.", forbidden: "Only a super administrator can manage accounts.",
};
const ROLE_LABEL: Record<string, string> = { event_manager: "Event manager", print_operator: "Print operator", reporting_viewer: "Reporting viewer" };

function Body({ me }: { me: Me }) {
  const [users, setUsers] = useState<U[] | null>(null); const [events, setEvents] = useState<Ev[]>([]);
  const [f, setF] = useState({ email: "", name: "", superAdmin: false });
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [temp, setTemp] = useState<{ who: string; pw: string } | null>(null);
  const load = useCallback(async () => {
    try { setUsers((await api<{ users: U[] }>("/api/v1/users")).users); setEvents((await api<{ events: Ev[] }>("/api/v1/events")).events); }
    catch (x: any) { setErr(x.status === 403 ? ERR.forbidden : x.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); await load(); } catch (x: any) { setErr(ERR[x.message] ?? x.message); } };

  if (me.globalRole !== "super_admin") return <><h1>Users</h1><div className="err" role="alert">{ERR.forbidden}</div></>;
  const patch = (u: U, body: object, ok: string) => run(() => api(`/api/v1/users/${u.id}`, { method: "PATCH", body }), ok);

  return (
    <>
      <h1>Users</h1>
      <div className="sub">Staff accounts. A new account can do nothing until it is given a role on at least one event.</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}
      {temp && (
        <div className="card" style={{ borderColor: "var(--brand)", marginBottom: 14 }}>
          <b>One-time password for {temp.who}</b> (shown once; ask them to change it under Account)
          <div style={{ fontSize: 26, fontFamily: "Consolas, monospace", letterSpacing: ".08em", margin: "6px 0" }}>{temp.pw}</div>
          <button className="mini" onClick={() => navigator.clipboard?.writeText(temp.pw)}>Copy</button> <button className="mini" onClick={() => setTemp(null)}>Done</button>
        </div>
      )}
      <form className="card row" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api<{ user: U; temporaryPassword?: string }>("/api/v1/users", { method: "POST", body: f }); if (r.temporaryPassword) setTemp({ who: r.user.email, pw: r.temporaryPassword }); setF({ email: "", name: "", superAdmin: false }); }, "Account created."); }}>
        <input type="email" placeholder="Email *" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required maxLength={200} />
        <input placeholder="Full name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} />
        <label className="chk" style={{ margin: 0 }}><input type="checkbox" checked={f.superAdmin} onChange={(e) => setF({ ...f, superAdmin: e.target.checked })} /> Super administrator</label>
        <button className="inline">Create account</button>
      </form>

      {users?.map((u) => (
        <div key={u.id} className="card" style={{ marginTop: 14, opacity: u.active ? 1 : .65 }}>
          <div className="inl" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <b>{u.name}</b> {u.superAdmin && <span className="pill active">super admin</span>} {!u.active && <span className="pill">deactivated</span>} {u.locked && <span className="pill" style={{ color: "var(--bad)" }}>locked</span>}
              <div className="muted">{u.email} · last sign-in {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}{u.passwordChangedAt ? ` · password changed ${new Date(u.passwordChangedAt).toLocaleDateString()}` : ""}</div>
            </div>
            <div className="inl">
              {u.locked && <button className="mini" onClick={() => patch(u, { unlock: true }, "Account unlocked.")}>Unlock</button>}
              <button className="mini" onClick={() => confirm(`Make a new one-time password for ${u.email}? Their current sessions end.`) && run(async () => { const r = await api<{ temporaryPassword?: string }>(`/api/v1/users/${u.id}/password`, { method: "POST", body: {} }); if (r.temporaryPassword) setTemp({ who: u.email, pw: r.temporaryPassword }); }, "Password reset.")}>Reset password</button>
              {u.id !== me.id && <button className="mini" onClick={() => patch(u, { superAdmin: !u.superAdmin }, u.superAdmin ? "Administrator rights removed." : "Administrator rights granted.")}>{u.superAdmin ? "Remove admin" : "Make admin"}</button>}
              {u.id !== me.id && <button className="mini" onClick={() => patch(u, { active: !u.active }, u.active ? "Account deactivated and signed out." : "Account reactivated.")}>{u.active ? "Deactivate" : "Reactivate"}</button>}
            </div>
          </div>
          {!u.superAdmin && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ marginBottom: 4 }}>Access to events</div>
              {u.eventRoles.map((r) => (
                <div key={r.eventId} className="inl" style={{ gap: 8, marginBottom: 4 }}>
                  <span style={{ minWidth: 200 }}>{r.eventName}</span>
                  <select value={r.role} onChange={(e) => run(() => api(`/api/v1/users/${u.id}/event-roles`, { method: "PUT", body: { eventId: r.eventId, role: e.target.value } }), "Role changed.")}>{ROLES.filter((x) => x !== "super_admin").map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</select>
                  <button className="mini" onClick={() => run(() => api(`/api/v1/users/${u.id}/event-roles`, { method: "PUT", body: { eventId: r.eventId, role: null } }), "Access removed.")}>Remove</button>
                </div>
              ))}
              {!u.eventRoles.length && <div className="muted">No access yet.</div>}
              <select defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) run(() => api(`/api/v1/users/${u.id}/event-roles`, { method: "PUT", body: { eventId: v, role: "print_operator" } }), "Access added as print operator: change the role if needed."); }} style={{ marginTop: 4, maxWidth: 320 }}>
                <option value="">Add access to an event…</option>
                {events.filter((e) => !u.eventRoles.some((r) => r.eventId === e.id)).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
export default function UsersPage() { return <Shell active="users">{(me) => <Body me={me} />}</Shell>; }
