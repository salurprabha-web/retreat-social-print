"use client";
import { useState } from "react";
import { MIN_PASSWORD } from "@rsp/shared";
import { api, type Me } from "../../lib/api";
import { Shell } from "../../components/Shell";

const WHY: Record<string, string> = { too_short: `Use at least ${MIN_PASSWORD} characters.`, too_common: "That password is too easy to guess.", contains_identity: "The password must not contain your email or name.", repetitive: "That password is too repetitive.", too_long: "That password is too long." };

function Body({ me }: { me: Me }) {
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState("");
  const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(""); setErr("");
    if (next !== again) { setErr("The two new passwords are not the same."); return; }
    setBusy(true);
    try { await api("/api/v1/auth/password", { method: "POST", body: { current: cur, next } }); setMsg("Password changed. Your other sign-ins were ended."); setCur(""); setNext(""); setAgain(""); }
    catch (x: any) { setErr(x.message === "wrong_password" ? "The current password is not right." : x.message === "weak_password" ? "Not strong enough: " + (WHY[x.reason] ?? "choose a longer password.") : x.message === "same_password" ? "Choose a password different from the current one." : x.message); }
    setBusy(false);
  }
  return (
    <>
      <h1>Account</h1>
      <div className="sub">{me.name} · {me.email}</div>
      {msg && <div className="ok" role="status">{msg}</div>}{err && <div className="err" role="alert">{err}</div>}
      <form className="card" style={{ maxWidth: 440 }} onSubmit={save}>
        <b>Change password</b>
        <label>Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
        <label>New password (at least {MIN_PASSWORD} characters; a sentence works well)<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={MIN_PASSWORD} /></label>
        <label>New password again<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></label>
        <button disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
      </form>
    </>
  );
}
export default function AccountPage() { return <Shell active="account">{(me) => <Body me={me} />}</Shell>; }
