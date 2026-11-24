"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { NO_ADJUST, fillTokens, validateGuestInput, type Device, type EventInfo, type PageDefinition, type PhotoAdjust, type StepId } from "@rsp/shared";
import { GuestPage } from "../GuestPage";
import { ThemeFrame } from "./ThemeFrame";
import { PhotoEditor } from "./PhotoEditor";
import { Webcam } from "./Webcam";
import { FRIENDLY, PhotoError, prepare, uploadPhoto } from "../../lib/photo";

export interface PublicData {
  definition: PageDefinition; event: EventInfo; logos: { event: boolean; client: boolean };
  settings: { maxUploadMb: number; requireConsent: boolean };
}
/** Screens that exist so far. Frame, edit, preview and share are added in later phases and are skipped until then. */
const IMPLEMENTED: StepId[] = ["welcome", "details", "capture"];
type Screen = StepId | "done";

export function GuestFlow({ token, data, device, zoom, vh }: { token: string; data: PublicData; device: Device; zoom: number; vh: number }) {
  const def = data.definition; const t = def.theme;
  const assetUrl = useCallback((n: string) => `/api/v1/public/g/${token}/asset/${n}`, [token]);
  const needsDetails = def.journey.steps.some((s) => s.id === "details" && s.enabled) || data.settings.requireConsent;

  // Enabled steps in the administrator's order. Details (which carries consent) always sits right before capture.
  const seq: Screen[] = useMemo(() => {
    const s = def.journey.steps.filter((x) => x.enabled && IMPLEMENTED.includes(x.id)).map((x) => x.id as Screen);
    const noDetails: Screen[] = s.filter((x) => x !== "details");
    if (needsDetails) { const i = noDetails.indexOf("capture"); noDetails.splice(i < 0 ? noDetails.length : i, 0, "details"); }
    return [...noDetails, "done"];
  }, [def, needsDetails]);

  const [i, setI] = useState(0);
  const screen = seq[Math.min(i, seq.length - 1)];
  const stepInfo = (id: StepId) => def.journey.steps.find((s) => s.id === id)!;
  const [consent, setConsent] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [session, setSession] = useState<{ id: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const [photo, setPhoto] = useState<{ url: string; blob: Blob; w: number; h: number } | null>(null);
  const [adjust, setAdjust] = useState<PhotoAdjust>(NO_ADJUST);
  const [cam, setCam] = useState(false); const [progress, setProgress] = useState<number | null>(null);
  const [lowRes, setLowRes] = useState(false);
  const [idle, setIdle] = useState(false);
  const active = useRef(Date.now());
  const camInput = useRef<HTMLInputElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const hasCamera = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const restart = useCallback(() => {
    setI(0); setConsent(false); setFields({}); setErrors({}); setSession(null); setMsg(""); setCam(false); setProgress(null); setLowRes(false);
    setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return null; }); setAdjust(NO_ADJUST); setBusy(false);
  }, []);

  // Idle screen on the landing page; session reset on any other screen (kiosk hygiene: the next guest never sees the previous one's photo).
  useEffect(() => {
    const touch = () => { active.current = Date.now(); setIdle(false); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, touch, { passive: true });
    const iv = setInterval(() => {
      const quiet = (Date.now() - active.current) / 1000;
      if (screen === seq[0] && def.journey.idleSeconds > 0 && quiet > def.journey.idleSeconds) setIdle(true);
      if (screen !== seq[0] && def.journey.timeoutSeconds > 0 && quiet > def.journey.timeoutSeconds && !busy) restart();
      if (screen === "done" && def.journey.autoAdvanceSeconds > 0 && quiet > def.journey.autoAdvanceSeconds) restart();
    }, 1000);
    return () => { for (const ev of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(ev, touch); clearInterval(iv); };
  }, [screen, seq, def.journey, busy, restart]);

  const consentField = def.fields.find((f) => f.type === "consent");
  const go = () => setI((n) => Math.min(n + 1, seq.length - 1));

  async function submitDetails() {
    const input = { consent, fields };
    const v = validateGuestInput(def, input, data.settings.requireConsent);
    setErrors(v.errors); if (!v.ok) return;
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`/api/v1/public/g/${token}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (j.errors) setErrors(j.errors); else setMsg(FRIENDLY[j.error] ?? FRIENDLY.network); setBusy(false); return; }
      setSession({ id: j.sessionId, code: j.guestCode }); setBusy(false); go();
    } catch { setMsg(FRIENDLY.network); setBusy(false); }
  }
  // No details screen at all (consent not required, no step): create the session when the guest starts.
  async function startWithoutDetails() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`/api/v1/public/g/${token}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: false, fields: {} }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(FRIENDLY[j.error] ?? FRIENDLY.network); setBusy(false); return; }
      setSession({ id: j.sessionId, code: j.guestCode }); setBusy(false); go();
    } catch { setMsg(FRIENDLY.network); setBusy(false); }
  }
  const onStart = () => {
    const next = seq[i + 1];
    if (next === "capture" && !session) void startWithoutDetails(); else go();
  };

  async function chooseFile(file: File | Blob | undefined) {
    if (!file) return;
    setMsg(""); setBusy(true);
    try {
      const blob = await prepare(file, data.settings.maxUploadMb * 1024 * 1024);
      const url = URL.createObjectURL(blob);
      const dims = await new Promise<{ w: number; h: number }>((res, rej) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => rej(new PhotoError("unsupported_image", FRIENDLY.unsupported_image)); im.src = url; });
      setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return { url, blob, ...dims }; }); setAdjust(NO_ADJUST); setCam(false);
    } catch (e: any) { setMsg(e instanceof PhotoError ? e.message : FRIENDLY.unsupported_image); }
    setBusy(false);
  }

  async function usePhoto() {
    if (!photo || !session) return;
    setBusy(true); setMsg(""); setProgress(0);
    try {
      const up = await uploadPhoto(token, session.id, photo.blob, setProgress);
      const r = await fetch(`/api/v1/public/g/${token}/photo/${up.uploadId}/adjust`, { method: "PUT", headers: { "content-type": "application/json", "x-guest-session": session.id }, body: JSON.stringify(adjust) });
      if (!r.ok) throw new PhotoError("network", FRIENDLY.network);
      setLowRes(up.lowResolution); setProgress(null); setBusy(false); go();
    } catch (e: any) {
      if (e?.code === "session_invalid" || e?.code === "session_required") { setMsg(FRIENDLY.session_invalid); setTimeout(restart, 2500); }
      else setMsg(e?.message ?? FRIENDLY.network);
      setProgress(null); setBusy(false);
    }
  }

  const btn = (primary = true): CSSProperties => ({
    background: primary ? t.button.color : "transparent", color: primary ? t.button.textColor : "inherit", border: primary ? 0 : `1px solid ${t.button.color}`,
    padding: ".75em 2em", fontSize: "1.05em", fontWeight: 700, cursor: busy ? "wait" : "pointer", fontFamily: "inherit", width: "auto", margin: 0,
    borderRadius: t.button.shape === "pill" ? 999 : t.button.shape === "rounded" ? 12 : 0, opacity: busy ? 0.7 : 1,
  });
  const input: CSSProperties = { width: "100%", padding: ".7em .8em", borderRadius: 8, border: "1px solid rgba(0,0,0,.25)", background: "#fff", color: "#111", fontFamily: "inherit", fontSize: "1em" };
  const Title = ({ id }: { id: StepId }) => <><h2 style={{ margin: 0, fontSize: "1.7em" }}>{fillTokens(stepInfo(id).title, data.event)}</h2><p style={{ margin: 0, opacity: .9 }}>{fillTokens(stepInfo(id).instructions, data.event)}</p></>;
  const Msg = () => (msg ? <p role="alert" style={{ background: "rgba(0,0,0,.55)", color: "#fff", padding: "8px 12px", borderRadius: 8, margin: 0 }}>{msg}</p> : null);
  const footer = def.welcome.components.find((c) => c.type === "footer");
  const privacy = typeof footer?.props.privacyUrl === "string" ? footer.props.privacyUrl : "";
  const terms = typeof footer?.props.termsUrl === "string" ? footer.props.termsUrl : "";

  let body: ReactNode;
  if (screen === "welcome") {
    body = null;
  } else if (screen === "details") {
    const fieldsOnForm = def.journey.steps.some((s) => s.id === "details" && s.enabled) ? def.fields.filter((f) => f.type !== "consent") : [];
    body = (
      <form onSubmit={(e) => { e.preventDefault(); void submitDetails(); }} style={{ width: "min(100%, 28em)", display: "flex", flexDirection: "column", gap: 12, textAlign: "left" }} noValidate>
        <div style={{ textAlign: "center" }}><Title id="details" /></div>
        {fieldsOnForm.map((f) => (
          <label key={f.id} style={{ display: "block", margin: 0, color: "inherit", fontSize: ".95em" }}>
            {f.label}{f.required ? " *" : " (optional)"}
            <input style={{ ...input, marginTop: 4 }} type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"} value={fields[f.id] ?? ""} maxLength={f.type === "email" ? 120 : 80}
              autoComplete={f.type === "email" ? "email" : f.type === "phone" ? "tel" : f.type === "name" ? "name" : "off"} onChange={(e) => setFields({ ...fields, [f.id]: e.target.value })} aria-invalid={!!errors[f.id]} />
            {errors[f.id] && <span style={{ background: "#b3261e", color: "#fff", fontSize: ".85em", padding: "2px 8px", borderRadius: 6, display: "inline-block", marginTop: 4 }}>{errors[f.id]}</span>}
          </label>
        ))}
        {(data.settings.requireConsent || consentField) && (
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: 0, color: "inherit", fontSize: ".95em" }}>
            <input type="checkbox" checked={consent} style={{ width: "1.3em", height: "1.3em", marginTop: 2, flex: "none" }}
              onChange={(e) => { setConsent(e.target.checked); if (consentField) setFields({ ...fields, [consentField.id]: e.target.checked ? "true" : "" }); }} />
            <span>{consentField?.label || "I agree that my photo may be printed and shown at this event."}
              {(privacy || terms) && <> <a style={{ color: "inherit" }} href={privacy || terms} target="_blank" rel="noopener noreferrer">Privacy notice</a></>}</span>
          </label>
        )}
        {(errors._consent || (consentField && errors[consentField.id])) && <span role="alert" style={{ background: "#b3261e", color: "#fff", padding: "4px 10px", borderRadius: 6, alignSelf: "flex-start" }}>{errors._consent || errors[consentField!.id]}</span>}
        <Msg />
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button type="button" style={btn(false)} onClick={() => setI((n) => Math.max(0, n - 1))}>Back</button>
          <button type="submit" style={btn()} disabled={busy}>{busy ? "Please wait…" : stepInfo("details").buttonLabel}</button>
        </div>
      </form>
    );
  } else if (screen === "capture") {
    body = (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Title id="capture" />
        <Msg />
        {cam ? <Webcam onCapture={(b) => void chooseFile(b)} onClose={() => setCam(false)} />
          : photo ? (
            <>
              <PhotoEditor src={photo.url} width={photo.w} height={photo.h} adjust={adjust} onChange={setAdjust} button={t.button} />
              {photo.w && Math.max(photo.w, photo.h) < 1200 && <p style={{ margin: 0, fontSize: ".85em", opacity: .9 }}>This photo is small, so the print may look soft. A larger photo will print sharper.</p>}
              {progress !== null && <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} style={{ width: "min(100%, 20em)", height: 10, background: "rgba(255,255,255,.25)", borderRadius: 99, overflow: "hidden" }}><div style={{ width: `${progress}%`, height: "100%", background: t.button.color, transition: "width .2s" }} /></div>}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                <button type="button" style={btn(false)} disabled={busy} onClick={() => { setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return null; }); setMsg(""); }}>Replace photo</button>
                <button type="button" style={btn()} disabled={busy} onClick={() => void usePhoto()}>{busy ? (progress !== null ? `Uploading ${progress}%` : "Please wait…") : stepInfo("capture").buttonLabel}</button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "min(100%, 22em)" }}>
              <button type="button" style={btn()} disabled={busy} onClick={() => camInput.current?.click()}>Take a photo</button>
              <button type="button" style={btn(false)} disabled={busy} onClick={() => fileInput.current?.click()}>Choose from gallery</button>
              {hasCamera && device !== "mobile" && <button type="button" style={btn(false)} disabled={busy} onClick={() => setCam(true)}>Use camera</button>}
              {busy && <p style={{ margin: 0 }}>Getting your photo ready…</p>}
              <input ref={camInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void chooseFile(e.target.files?.[0]); e.target.value = ""; }} />
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { void chooseFile(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          )}
      </div>
    );
  } else {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: "1.8em" }}>{def.messages.success}</h2>
        {session && <p style={{ margin: 0 }}>Your guest ID: <b style={{ fontSize: "1.4em", letterSpacing: ".1em" }}>{session.code}</b></p>}
        {lowRes && <p style={{ margin: 0, fontSize: ".9em", opacity: .9 }}>Your photo is small, so the print may look soft.</p>}
        <p style={{ margin: 0, opacity: .85, maxWidth: "28em" }}>Your photo has been saved. Choosing a frame, previewing, sharing and printing arrive in the next releases of this event experience.</p>
        <button type="button" style={btn()} onClick={restart}>{stepInfo("success").buttonLabel}</button>
      </div>
    );
  }

  return (
    <>
      {screen === "welcome" ? (
        <GuestPage def={def} event={data.event} device={device} minHeight={vh / zoom} guestUrl={typeof window !== "undefined" ? window.location.href : ""}
          assetUrl={assetUrl} logoUrl={(k) => (data.logos[k] ? `/api/v1/public/g/${token}/logo/${k}` : null)} onStart={onStart} />
      ) : (
        <ThemeFrame def={def} device={device} minHeight={vh / zoom} assetUrl={assetUrl}>{body}</ThemeFrame>
      )}
      {screen === "welcome" && msg && <p role="alert" style={{ position: "fixed", left: 12, right: 12, bottom: 12, background: "#111", color: "#fff", padding: 12, borderRadius: 10, textAlign: "center", zoom: 1 }}>{msg}</p>}
      {idle && (
        <div onClick={() => setIdle(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.82)", color: "#fff", display: "grid", placeItems: "center", textAlign: "center", fontSize: "2em", zoom: 1, cursor: "pointer" }}>
          {def.messages.idleTitle}
        </div>
      )}
    </>
  );
}
