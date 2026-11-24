"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  NO_ADJUST, fillTokens, resolveShare, validateGuestInput,
  type Device, type EventInfo, type FrameLayer, type PageDefinition, type PhotoAdjust, type StepId,
} from "@rsp/shared";
import { GuestPage } from "../GuestPage";
import { FrameCanvas, type SlotPhoto } from "../FrameCanvas";
import { ThemeFrame } from "./ThemeFrame";
import { PhotoEditor } from "./PhotoEditor";
import { Webcam } from "./Webcam";
import { ShareScreen } from "./ShareScreen";
import { FRIENDLY, PhotoError, prepare, uploadPhoto } from "../../lib/photo";

export interface PublicData {
  definition: PageDefinition; event: EventInfo; logos: { event: boolean; client: boolean };
  settings: {
    maxUploadMb: number; requireConsent: boolean;
    share: ReturnType<typeof resolveShare>; instagramHandle: string | null; suggestedCaption: string | null;
  };
}
interface PubFrame { id: string; name: string; format: string; widthPx: number; heightPx: number; layers: FrameLayer[] }
interface Held { url: string; blob: Blob; w: number; h: number; uploadId: string; adjust: PhotoAdjust }
interface Final { id: string; url: string; width: number; height: number }
type PhotoLayer = Extract<FrameLayer, { type: "photo" }>;

/** Every step has a screen now. Share needs a finished picture, so it is skipped when no frame/picture exists. */
const IMPLEMENTED: StepId[] = ["welcome", "details", "capture", "frame", "edit", "preview", "share"];
const CHAIN: StepId[] = ["frame", "edit", "preview"];
type Screen = StepId | "done";

export function GuestFlow({ token, data, device, zoom, vh }: { token: string; data: PublicData; device: Device; zoom: number; vh: number }) {
  const def = data.definition; const t = def.theme;
  const assetUrl = useCallback((n: string) => `/api/v1/public/g/${token}/asset/${n}`, [token]);
  const needsDetails = def.journey.steps.some((s) => s.id === "details" && s.enabled) || data.settings.requireConsent;
  const [frames, setFrames] = useState<PubFrame[] | null>(null);
  useEffect(() => { fetch(`/api/v1/public/g/${token}/frames`).then((r) => (r.ok ? r.json() : { frames: [] })).then((j) => setFrames(j.frames)).catch(() => setFrames([])); }, [token]);
  const hasFrames = !!frames && frames.length > 0;

  // Enabled steps in the administrator's order. Details (carries consent) sits right before capture; capture always precedes the frame steps.
  const seq: Screen[] = useMemo(() => {
    let s: Screen[] = def.journey.steps.filter((x) => x.enabled && IMPLEMENTED.includes(x.id)).map((x) => x.id);
    if (!hasFrames) s = s.filter((x) => !CHAIN.includes(x as StepId) && x !== "share");
    s = s.filter((x) => x !== "details" && x !== "capture");
    const firstChain = s.findIndex((x) => CHAIN.includes(x as StepId));
    const capAt = firstChain < 0 ? s.length : firstChain;
    s.splice(capAt, 0, "capture");
    if (needsDetails) s.splice(capAt, 0, "details");
    return [...s, "done"];
  }, [def, needsDetails, hasFrames]);

  const [i, setI] = useState(0);
  const screen = seq[Math.min(i, seq.length - 1)];
  const stepInfo = (id: StepId) => def.journey.steps.find((s) => s.id === id)!;
  const [consent, setConsent] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [session, setSession] = useState<{ id: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const [photo, setPhoto] = useState<{ url: string; blob: Blob; w: number; h: number } | null>(null);   // capture step working copy
  const [adjust, setAdjust] = useState<PhotoAdjust>(NO_ADJUST);
  const [held, setHeld] = useState<Record<number, Held>>({});                                           // uploaded photo per frame slot
  const [frameId, setFrameId] = useState<string | null>(null);
  const [activeSlot, setActiveSlot] = useState(1);
  const [final, setFinal] = useState<Final | null>(null);
  const [cam, setCam] = useState(false); const [progress, setProgress] = useState<number | null>(null);
  const [lowRes, setLowRes] = useState(false);
  const [idle, setIdle] = useState(false);
  const active = useRef(Date.now());
  const camInput = useRef<HTMLInputElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const hasCamera = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const frame = frames?.find((f) => f.id === frameId) ?? null;
  const slots = useMemo(() => (frame ? frame.layers.filter((l): l is PhotoLayer => l.type === "photo").sort((a, b) => a.slot - b.slot) : []), [frame]);
  const slotAspect = (n: number) => { const l = slots.find((x) => x.slot === n); return l && frame ? (l.h * frame.heightPx) / (l.w * frame.widthPx) : 1.5; };

  const restart = useCallback(() => {
    setI(0); setConsent(false); setFields({}); setErrors({}); setSession(null); setMsg(""); setCam(false); setProgress(null); setLowRes(false);
    setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return null; }); setAdjust(NO_ADJUST); setBusy(false);
    setHeld((h) => { new Set(Object.values(h).map((x) => x.url)).forEach((u) => URL.revokeObjectURL(u)); return {}; });
    setFrameId(null); setFinal(null); setActiveSlot(1);
  }, []);

  // Idle screen on the landing page; session reset elsewhere (kiosk hygiene: the next guest never sees the previous one's photo).
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
  const back = () => setI((n) => Math.max(0, n - 1));
  const fail = (e: any) => {
    if (e?.code === "session_invalid" || e?.code === "session_required") { setMsg(FRIENDLY.session_invalid); setTimeout(restart, 2500); }
    else setMsg(e?.message ?? FRIENDLY.network);
  };

  async function startSession(body: object): Promise<boolean> {
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`/api/v1/public/g/${token}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (j.errors) setErrors(j.errors); else setMsg(FRIENDLY[j.error] ?? FRIENDLY.network); setBusy(false); return false; }
      setSession({ id: j.sessionId, code: j.guestCode }); setBusy(false); return true;
    } catch { setMsg(FRIENDLY.network); setBusy(false); return false; }
  }
  async function submitDetails() {
    const input = { consent, fields };
    const v = validateGuestInput(def, input, data.settings.requireConsent);
    setErrors(v.errors); if (!v.ok) return;
    if (await startSession(input)) go();
  }
  const onStart = async () => {
    const next = seq[i + 1];
    if (next === "capture" && !session) { if (await startSession({ consent: false, fields: {} })) go(); } else go();
  };

  async function readFile(file: File | Blob) {
    const blob = await prepare(file, data.settings.maxUploadMb * 1024 * 1024);
    const url = URL.createObjectURL(blob);
    const dims = await new Promise<{ w: number; h: number }>((res, rej) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => rej(new PhotoError("unsupported_image", FRIENDLY.unsupported_image)); im.src = url; });
    return { url, blob, ...dims };
  }
  async function chooseFile(file: File | Blob | undefined) {
    if (!file) return;
    setMsg(""); setBusy(true);
    try { const p = await readFile(file); setPhoto((o) => { if (o) URL.revokeObjectURL(o.url); return p; }); setAdjust(NO_ADJUST); setCam(false); }
    catch (e: any) { setMsg(e instanceof PhotoError ? e.message : FRIENDLY.unsupported_image); }
    setBusy(false);
  }
  /** Capture step: upload the photo as slot 1. */
  async function usePhoto() {
    if (!photo || !session) return;
    setBusy(true); setMsg(""); setProgress(0);
    try {
      const up = await uploadPhoto(token, session.id, photo.blob, setProgress, 1);
      const r = await fetch(`/api/v1/public/g/${token}/photo/${up.uploadId}/adjust`, { method: "PUT", headers: { "content-type": "application/json", "x-guest-session": session.id }, body: JSON.stringify(adjust) });
      if (!r.ok) throw new PhotoError("network", FRIENDLY.network);
      setHeld({ 1: { url: photo.url, blob: photo.blob, w: photo.w, h: photo.h, uploadId: up.uploadId, adjust } });
      setFinal(null); setLowRes(up.lowResolution); setProgress(null); setBusy(false); go();
    } catch (e: any) { fail(e); setProgress(null); setBusy(false); }
  }
  /** Edit step: add or replace the photo of one frame slot. */
  async function addSlotPhoto(slot: number, file: File | Blob | undefined) {
    if (!file || !session) return;
    setMsg(""); setBusy(true); setProgress(0);
    try {
      const p = await readFile(file);
      const up = await uploadPhoto(token, session.id, p.blob, setProgress, slot);
      setHeld((h) => ({ ...h, [slot]: { ...p, uploadId: up.uploadId, adjust: NO_ADJUST } })); setCam(false); setFinal(null);
    } catch (e: any) { fail(e); }
    setProgress(null); setBusy(false);
  }
  const useFirstFor = (slot: number) => setHeld((h) => (h[1] ? { ...h, [slot]: { ...h[1], adjust: NO_ADJUST } } : h));
  /** Empty slots use the guest's first photo (used when the editor step is turned off). */
  const fillMissing = (h: Record<number, Held>) => { const n = { ...h }; for (const l of slots) if (!n[l.slot] && h[1]) n[l.slot] = { ...h[1] }; return n; };
  const slotsFilled = slots.length > 0 && slots.every((l) => held[l.slot]);

  /** Renders the ONE final image on the server. Safe to call again: same input = same picture, new input replaces it. */
  async function composeWith(h: Record<number, Held>): Promise<boolean> {
    if (!session || !frame || !slots.every((l) => h[l.slot])) return false;
    setBusy(true); setMsg("");
    try {
      const body = { frameId: frame.id, slots: slots.map((l) => ({ slot: l.slot, uploadId: h[l.slot].uploadId, adjust: h[l.slot].adjust })) };
      const r = await fetch(`/api/v1/public/g/${token}/compose`, { method: "POST", headers: { "content-type": "application/json", "x-guest-session": session.id }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error === "compose_failed" ? "We couldn't create your picture. Please try again." : FRIENDLY[j.error] ?? FRIENDLY.network), { code: j.error });
      setFinal({ id: j.compositionId, url: j.url, width: j.width, height: j.height }); setBusy(false); return true;
    } catch (e: any) { fail(e); setBusy(false); return false; }
  }
  // The picture is created when the guest leaves the last enabled step of frame -> edit -> preview, or on arriving at preview.
  const isLastBeforePreview = (id: StepId) => seq[i] === id && !seq.slice(i + 1).some((x) => x === "edit" || x === "preview");
  async function afterFrame() {
    if (!frame) return;
    const h = seq.includes("edit") ? held : fillMissing(held);
    if (h !== held) setHeld(h);
    if (isLastBeforePreview("frame")) { if (await composeWith(h)) go(); } else go();
  }
  async function afterEdit() { if (isLastBeforePreview("edit")) { if (await composeWith(held)) go(); } else go(); }
  useEffect(() => { if (screen === "preview" && !final && frame && session && !busy) void composeWith(fillMissing(held)); /* eslint-disable-next-line */ }, [screen]);

  const btn = (primary = true): CSSProperties => ({
    background: primary ? t.button.color : "transparent", color: primary ? t.button.textColor : "inherit", border: primary ? 0 : `1px solid ${t.button.color}`,
    padding: ".75em 2em", fontSize: "1.05em", fontWeight: 700, cursor: busy ? "wait" : "pointer", fontFamily: "inherit", width: "auto", margin: 0,
    borderRadius: t.button.shape === "pill" ? 999 : t.button.shape === "rounded" ? 12 : 0, opacity: busy ? 0.7 : 1,
  });
  const input: CSSProperties = { width: "100%", padding: ".7em .8em", borderRadius: 8, border: "1px solid rgba(0,0,0,.25)", background: "#fff", color: "#111", fontFamily: "inherit", fontSize: "1em" };
  const errStyle: CSSProperties = { background: "#b3261e", color: "#fff", fontSize: ".85em", padding: "2px 8px", borderRadius: 6, display: "inline-block", marginTop: 4 };
  const Title = ({ id }: { id: StepId }) => <><h2 style={{ margin: 0, fontSize: "1.7em" }}>{fillTokens(stepInfo(id).title, data.event)}</h2><p style={{ margin: 0, opacity: .9 }}>{fillTokens(stepInfo(id).instructions, data.event)}</p></>;
  const Msg = () => (msg ? <p role="alert" style={{ background: "rgba(0,0,0,.6)", color: "#fff", padding: "8px 12px", borderRadius: 8, margin: 0 }}>{msg}</p> : null);
  const Progress = () => (progress !== null ? <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} style={{ width: "min(100%, 20em)", height: 10, background: "rgba(255,255,255,.25)", borderRadius: 99, overflow: "hidden" }}><div style={{ width: `${progress}%`, height: "100%", background: t.button.color, transition: "width .2s" }} /></div> : null);
  const footer = def.welcome.components.find((c) => c.type === "footer");
  const privacy = typeof footer?.props.privacyUrl === "string" ? footer.props.privacyUrl : "";
  const terms = typeof footer?.props.termsUrl === "string" ? footer.props.termsUrl : "";
  const fcAsset = (n: string) => `/api/v1/public/g/${token}/frame-assets/${n}`;
  const fcLogo = (k: "event" | "client") => (data.logos[k] ? `/api/v1/public/g/${token}/logo/${k}` : null);
  const asSlotPhoto = (h: Held | undefined): SlotPhoto | undefined => (h ? { url: h.url, width: h.w, height: h.h, adjust: h.adjust } : undefined);
  const photosFor = (f: PubFrame, fallbackFirst: boolean) => {
    const o: Record<number, SlotPhoto> = {};
    for (const l of f.layers) if (l.type === "photo") { const p = asSlotPhoto(held[l.slot] ?? (fallbackFirst ? held[1] : undefined)); if (p) o[l.slot] = p; }
    return o;
  };
  const previewW = device === "mobile" ? 260 : device === "tablet" ? 360 : 420;
  const picker = (slot: number, label: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "min(100%, 22em)" }}>
      {label && <p style={{ margin: 0 }}>{label}</p>}
      <button type="button" style={btn()} disabled={busy} onClick={() => camInput.current?.click()}>Take a photo</button>
      <button type="button" style={btn(false)} disabled={busy} onClick={() => fileInput.current?.click()}>Choose from gallery</button>
      {hasCamera && device !== "mobile" && <button type="button" style={btn(false)} disabled={busy} onClick={() => setCam(true)}>Use camera</button>}
      {slot !== 1 && held[1] && <button type="button" style={btn(false)} disabled={busy} onClick={() => useFirstFor(slot)}>Use my first photo here</button>}
    </div>
  );

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
            {errors[f.id] && <span style={errStyle}>{errors[f.id]}</span>}
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
        {(errors._consent || (consentField && errors[consentField.id])) && <span role="alert" style={{ ...errStyle, padding: "4px 10px", alignSelf: "flex-start" }}>{errors._consent || errors[consentField!.id]}</span>}
        <Msg />
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button type="button" style={btn(false)} onClick={back}>Back</button>
          <button type="submit" style={btn()} disabled={busy}>{busy ? "Please wait…" : stepInfo("details").buttonLabel}</button>
        </div>
      </form>
    );
  } else if (screen === "capture") {
    body = (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Title id="capture" /><Msg />
        {cam ? <Webcam onCapture={(b) => void chooseFile(b)} onClose={() => setCam(false)} />
          : photo ? (
            <>
              <PhotoEditor src={photo.url} width={photo.w} height={photo.h} adjust={adjust} onChange={setAdjust} button={t.button} />
              {Math.max(photo.w, photo.h) < 1200 && <p style={{ margin: 0, fontSize: ".85em", opacity: .9 }}>This photo is small, so the print may look soft. A larger photo will print sharper.</p>}
              <Progress />
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                <button type="button" style={btn(false)} disabled={busy} onClick={() => { setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return null; }); setMsg(""); }}>Replace photo</button>
                <button type="button" style={btn()} disabled={busy} onClick={() => void usePhoto()}>{busy ? (progress !== null ? `Uploading ${progress}%` : "Please wait…") : stepInfo("capture").buttonLabel}</button>
              </div>
            </>
          ) : (
            <>{picker(1, "")}{busy && <p style={{ margin: 0 }}>Getting your photo ready…</p>}</>
          )}
      </div>
    );
  } else if (screen === "frame") {
    body = (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Title id="frame" /><Msg />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, justifyContent: "center" }}>
          {frames!.map((f) => (
            <button key={f.id} type="button" onClick={() => { setFrameId(f.id); setActiveSlot(1); setFinal(null); }} aria-pressed={frameId === f.id} aria-label={`Frame ${f.name}`}
              style={{ background: "rgba(255,255,255,.12)", border: frameId === f.id ? `4px solid ${t.accentColor}` : "4px solid transparent", borderRadius: 12, padding: 8, cursor: "pointer", width: "auto", margin: 0, color: "inherit", fontFamily: "inherit" }}>
              <FrameCanvas widthPx={f.widthPx} heightPx={f.heightPx} layers={f.layers} event={data.event} displayWidth={f.widthPx > f.heightPx ? previewW : Math.round(previewW * 0.62)} assetUrl={fcAsset} logoUrl={fcLogo} photos={photosFor(f, true)} />
              <div style={{ marginTop: 6, fontSize: ".85em" }}>{f.name}</div>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" style={btn(false)} disabled={busy} onClick={back}>Back</button>
          <button type="button" style={btn()} disabled={busy || !frame} onClick={() => void afterFrame()}>{busy ? "Please wait…" : stepInfo("frame").buttonLabel}</button>
        </div>
      </div>
    );
  } else if (screen === "edit" && frame) {
    const h = held[activeSlot];
    body = (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <Title id="edit" /><Msg />
        <FrameCanvas widthPx={frame.widthPx} heightPx={frame.heightPx} layers={frame.layers} event={data.event} displayWidth={frame.widthPx > frame.heightPx ? previewW : Math.round(previewW * 0.8)} assetUrl={fcAsset} logoUrl={fcLogo} photos={photosFor(frame, false)} />
        {slots.length > 1 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }} role="tablist" aria-label="Photos in this frame">
            {slots.map((l) => (
              <button key={l.slot} type="button" role="tab" aria-selected={activeSlot === l.slot} onClick={() => { setActiveSlot(l.slot); setCam(false); setMsg(""); }}
                style={{ ...btn(activeSlot === l.slot), padding: ".5em 1.1em", fontSize: ".95em", opacity: 1 }}>Photo {l.slot}{held[l.slot] ? " ✓" : ""}</button>
            ))}
          </div>
        )}
        {cam ? <Webcam onCapture={(b) => void addSlotPhoto(activeSlot, b)} onClose={() => setCam(false)} />
          : h ? (
            <>
              <PhotoEditor key={`${activeSlot}-${h.uploadId}`} src={h.url} width={h.w} height={h.h} aspect={slotAspect(activeSlot)} adjust={h.adjust} button={t.button}
                onChange={(a) => { setFinal(null); setHeld((o) => ({ ...o, [activeSlot]: { ...o[activeSlot], adjust: a } })); }} />
              <button type="button" style={btn(false)} disabled={busy} onClick={() => fileInput.current?.click()}>Replace this photo</button>
            </>
          ) : picker(activeSlot, `Add the photo for position ${activeSlot}`)}
        <Progress />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" style={btn(false)} disabled={busy} onClick={back}>Back</button>
          <button type="button" style={btn()} disabled={busy || !slotsFilled} onClick={() => void afterEdit()}>{busy ? "Creating your picture…" : stepInfo("edit").buttonLabel}</button>
        </div>
        {!slotsFilled && <p style={{ margin: 0, fontSize: ".85em", opacity: .9 }}>Add a photo for every position to continue.</p>}
      </div>
    );
  } else if (screen === "preview") {
    body = (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Title id="preview" /><Msg />
        {final ? <img src={final.url} alt="Your final picture" style={{ width: "min(100%, 24em)", maxHeight: "70vh", objectFit: "contain", borderRadius: 6, boxShadow: "0 6px 24px rgba(0,0,0,.4)", background: "#fff" }} />
          : <p>{busy ? "Creating your picture…" : "Something went wrong creating your picture."}</p>}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" style={btn(false)} disabled={busy} onClick={back}>Change something</button>
          <button type="button" style={btn()} disabled={busy || !final} onClick={go}>{stepInfo("preview").buttonLabel}</button>
        </div>
      </div>
    );
  } else if (screen === "share" && final && session) {
    body = (
      <ShareScreen token={token} sessionId={session.id} compositionId={final.id} finalUrl={final.url} data={data} btn={btn} onDone={go}
        doneLabel={stepInfo("share").buttonLabel} title={fillTokens(stepInfo("share").title, data.event)} instructions={fillTokens(stepInfo("share").instructions, data.event)} />
    );
  } else {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: "1.8em" }}>{def.messages.success}</h2>
        {final && <img src={final.url} alt="Your final picture" style={{ width: "min(100%, 20em)", borderRadius: 6, boxShadow: "0 6px 24px rgba(0,0,0,.4)", background: "#fff" }} />}
        {final && <a href={`${final.url}&dl=1`} download="photo.jpg" style={{ ...btn(), textDecoration: "none", display: "inline-block" }}>Download photo</a>}
        {session && <p style={{ margin: 0 }}>Your guest ID: <b style={{ fontSize: "1.4em", letterSpacing: ".1em" }}>{session.code}</b></p>}
        {lowRes && <p style={{ margin: 0, fontSize: ".9em", opacity: .9 }}>Your photo is small, so the print may look soft.</p>}
        {!final && <p style={{ margin: 0, opacity: .85, maxWidth: "28em" }}>Your photo has been saved. This event has no frames available yet.</p>}
        <button type="button" style={btn(false)} onClick={restart}>{stepInfo("success").buttonLabel}</button>
      </div>
    );
  }

  const fileHandler = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (screen === "edit") void addSlotPhoto(activeSlot, f); else void chooseFile(f);
  };
  return (
    <>
      {screen === "welcome" ? (
        <GuestPage def={def} event={data.event} device={device} minHeight={vh / zoom} guestUrl={typeof window !== "undefined" ? window.location.href : ""}
          assetUrl={assetUrl} logoUrl={fcLogo} onStart={() => void onStart()} />
      ) : (
        <ThemeFrame def={def} device={device} minHeight={vh / zoom} assetUrl={assetUrl}>{body}</ThemeFrame>
      )}
      <input ref={camInput} type="file" accept="image/*" capture="environment" hidden onChange={fileHandler} />
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={fileHandler} />
      {screen === "welcome" && msg && <p role="alert" style={{ position: "fixed", left: 12, right: 12, bottom: 12, background: "#111", color: "#fff", padding: 12, borderRadius: 10, textAlign: "center", zoom: 1 }}>{msg}</p>}
      {idle && (
        <div onClick={() => setIdle(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.82)", color: "#fff", display: "grid", placeItems: "center", textAlign: "center", fontSize: "2em", zoom: 1, cursor: "pointer" }}>
          {def.messages.idleTitle}
        </div>
      )}
    </>
  );
}
