"use client";
import { useState } from "react";
import { api } from "../../lib/api";

export default function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api("/api/v1/auth/login", { method: "POST", body: { email, password } }); window.location.href = "/"; }
    catch (x: any) { setErr(x.status === 429 ? "Too many attempts. Try again in a few minutes." : "Incorrect email or password."); }
    finally { setBusy(false); }
  }
  return (
    <form className="login" onSubmit={submit}>
      <div className="brand">RETREAT SOCIAL PRINT</div>
      <div className="tag">CAPTURE. CUSTOMIZE. SHARE. PRINT.</div>
      <h1>Sign in</h1>
      <label htmlFor="e">Email</label>
      <input id="e" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label htmlFor="p">Password</label>
      <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      {err && <div className="err" role="alert">{err}</div>}
    </form>
  );
}
