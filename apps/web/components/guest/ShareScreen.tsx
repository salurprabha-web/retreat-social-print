"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { buildCaption, hashtagLine, whatsappUrl, type EventInfo, type ShareChannel } from "@rsp/shared";
import type { PublicData } from "./GuestFlow";

async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.cssText = "position:fixed;opacity:0;left:-999px";
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}
const isMobile = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * Sharing. Instagram does not let any web page or app publish to a personal account, so this never claims to. The honest paths:
 *  1. native share sheet with the picture attached (the guest picks Instagram there), caption copied first;
 *  2. otherwise: save the picture, copy the caption, try to open the Instagram app, and show a short guide.
 * Every tap is logged as an ATTEMPT only.
 */
export function ShareScreen({ token, sessionId, compositionId, finalUrl, data, btn, onDone, doneLabel, title, instructions, sponsorTags = [] }: {
  token: string; sessionId: string; compositionId: string; finalUrl: string; data: PublicData; btn: (primary?: boolean) => CSSProperties;
  onDone: () => void; doneLabel: string; title: string; instructions: string; sponsorTags?: string[];
}) {
  const { share, instagramHandle, suggestedCaption } = data.settings;
  const ev: EventInfo = data.event;
  // Event-wide hashtags from the Sharing tab, then the sponsors' own (a sponsor with frames only tags pictures made in its frames).
  const allTags = useMemo(() => [...share.sponsorHashtags, ...sponsorTags.filter((t) => !share.sponsorHashtags.some((x) => x.toLowerCase() === t.toLowerCase()))].slice(0, 8), [share.sponsorHashtags, sponsorTags]);
  const caption = useMemo(() => buildCaption(suggestedCaption, ev, { instagram: instagramHandle, sponsorHashtags: allTags }), [suggestedCaption, ev, instagramHandle, allTags]);
  const tags = useMemo(() => hashtagLine(ev, allTags), [ev, allTags]);
  const [file, setFile] = useState<File | null>(null);
  const [toast, setToast] = useState(""); const [guide, setGuide] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);   // did the caption really reach the clipboard? (never assume)
  const copiedRef = useRef<boolean | null>(null);
  const [captionOpen, setCaptionOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = (m: string) => { setToast(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 3500); };

  // Fetch the picture up front: browsers only allow the share sheet straight from a tap, with the file already in hand.
  useEffect(() => {
    let dead = false;
    fetch(finalUrl).then((r) => r.blob()).then((b) => { if (!dead) setFile(new File([b], "photo.jpg", { type: "image/jpeg" })); }).catch(() => {});
    return () => { dead = true; };
  }, [finalUrl]);
  const canShareFile = !!file && typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });
  const canShareAny = typeof navigator !== "undefined" && !!navigator.share;
  const absolute = typeof window !== "undefined" ? new URL(finalUrl, window.location.origin).toString() : finalUrl;

  const track = (channel: ShareChannel) => {
    fetch(`/api/v1/public/g/${token}/composition/${compositionId}/share`, { method: "POST", keepalive: true,
      headers: { "content-type": "application/json", "x-guest-session": sessionId }, body: JSON.stringify({ channel }) }).catch(() => {});
  };
  const saveFile = () => { const a = document.createElement("a"); a.href = `${finalUrl}&dl=1`; a.download = "photo.jpg"; document.body.appendChild(a); a.click(); a.remove(); };

  async function instagram() {
    track("instagram");
    // Instagram ignores shared text, so the caption goes to the clipboard. Not awaited: the share sheet must open straight from the tap.
    copiedRef.current = null; setCopied(null);
    void copyText(caption).then((ok) => { copiedRef.current = ok; setCopied(ok); });
    if (canShareFile) {
      try {
        await navigator.share({ files: [file!], text: caption });
        say(copiedRef.current ? "Choose Instagram in the share list. Your caption is copied: paste it into your post." : "Choose Instagram in the share list. Use “Copy caption” below, then paste it into your post.");
        return;
      }
      catch (e: any) { if (e?.name === "AbortError") return; /* otherwise fall back to the guide */ }
    }
    saveFile(); setGuide(true);
    if (isMobile()) setTimeout(() => { window.location.href = "instagram://app"; }, 700);   // opens the app if installed; harmless otherwise
  }
  async function nativeShare() {
    track("native");
    try {
      if (canShareFile) await navigator.share({ files: [file!], text: caption });
      else await navigator.share({ text: caption, url: absolute });
    } catch { /* cancelled */ }
  }
  async function copy(channel: "copy_caption" | "copy_hashtag") {
    track(channel);
    const ok = await copyText(channel === "copy_caption" ? caption : tags);
    if (channel === "copy_caption") { copiedRef.current = ok; setCopied(ok); }
    say(ok ? "Copied!" : "Couldn't copy automatically. Open “Caption” below, then press and hold to copy.");
    if (!ok) setCaptionOpen(true);
  }
  const handle = (instagramHandle ?? "").replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "");
  const L = share.labels, C = share.channels;
  const row: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, width: "min(100%, 22em)" };

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: "1.7em" }}>{title}</h2>
      {instructions && <p style={{ margin: 0, opacity: .9 }}>{instructions}</p>}
      <img src={finalUrl} alt="Your final picture" style={{ width: "min(100%, 15em)", borderRadius: 6, boxShadow: "0 6px 24px rgba(0,0,0,.4)", background: "#fff" }} />
      {share.instructions && <p style={{ margin: 0, maxWidth: "28em", whiteSpace: "pre-line" }}>{share.instructions}</p>}
      <div style={row}>
        {C.instagram && <button type="button" style={btn()} onClick={() => void instagram()}>{L.instagram}</button>}
        {C.native && canShareAny && <button type="button" style={btn(false)} onClick={() => void nativeShare()}>{L.native}</button>}
        {C.whatsapp && <a href={whatsappUrl(`${caption}\n${absolute}`)} target="_blank" rel="noopener noreferrer" onClick={() => track("whatsapp")} style={{ ...btn(false), textDecoration: "none", textAlign: "center", display: "block" }}>{L.whatsapp}</a>}
        {C.download && <a href={`${finalUrl}&dl=1`} download="photo.jpg" onClick={() => track("download")} style={{ ...btn(false), textDecoration: "none", textAlign: "center", display: "block" }}>{L.download}</a>}
        {(C.copyCaption || C.copyHashtag) && (
          <div style={{ display: "flex", gap: 10 }}>
            {C.copyCaption && <button type="button" style={{ ...btn(false), flex: 1, padding: ".6em .8em", fontSize: ".95em" }} onClick={() => void copy("copy_caption")}>{L.copyCaption}</button>}
            {C.copyHashtag && tags && <button type="button" style={{ ...btn(false), flex: 1, padding: ".6em .8em", fontSize: ".95em" }} onClick={() => void copy("copy_hashtag")}>{L.copyHashtag}</button>}
          </div>
        )}
      </div>
      <details open={captionOpen} onToggle={(e) => setCaptionOpen((e.target as HTMLDetailsElement).open)} style={{ maxWidth: "28em", textAlign: "left", fontSize: ".9em" }}>
        <summary style={{ cursor: "pointer", textAlign: "center" }}>Caption</summary>
        <p style={{ whiteSpace: "pre-line", margin: "8px 0" }}>{caption}</p>
      </details>
      {handle && <p style={{ margin: 0 }}>Follow <a style={{ color: "inherit", fontWeight: 700 }} href={`https://instagram.com/${handle}`} target="_blank" rel="noopener noreferrer">@{handle}</a></p>}
      {C.whatsapp && <p style={{ margin: 0, fontSize: ".8em", opacity: .8 }}>WhatsApp shares a link that works for 24 hours.</p>}
      {data.settings.localMode && <p style={{ margin: 0, fontSize: ".8em", opacity: .85, maxWidth: "28em" }}>Sharing to Instagram or WhatsApp needs an internet connection and may not work on this event&apos;s Wi-Fi. You can download your photo now and share it later.</p>}
      {toast && <p role="status" style={{ margin: 0, background: "rgba(0,0,0,.65)", color: "#fff", padding: "8px 14px", borderRadius: 8 }}>{toast}</p>}
      <button type="button" style={btn()} onClick={onDone}>{doneLabel}</button>

      {guide && (
        <div role="dialog" aria-label="How to post on Instagram" onClick={() => setGuide(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", color: "#111", borderRadius: 14, padding: 20, maxWidth: "26em", textAlign: "left", fontFamily: "system-ui, sans-serif", fontSize: 16 }}>
            <h3 style={{ margin: "0 0 8px" }}>Post it on Instagram</h3>
            <p style={{ margin: "0 0 10px", fontSize: 14, color: "#555" }}>Instagram doesn&apos;t let other apps post for you, so it takes three quick steps:</p>
            <ol style={{ margin: "0 0 12px", paddingLeft: 20, lineHeight: 1.5 }}>
              <li>Your photo was saved to this device (check your Downloads or Photos).</li>
              <li>{copied === false ? <>Tap <b>Copy caption again</b> below (your browser didn&apos;t allow automatic copying), then paste it into the caption box.</> : <>Your caption is copied. Paste it into the caption box.</>}</li>
              <li>Open Instagram, tap <b>+</b>, choose <b>Post</b>, and pick your photo.</li>
            </ol>
            {!isMobile() && <p style={{ margin: "0 0 12px", fontSize: 14 }}>On a computer, open <a href="https://www.instagram.com/" target="_blank" rel="noopener noreferrer">instagram.com</a> and use the + button.</p>}
            {copied === false && <p style={{ margin: "0 0 12px", fontSize: 14, whiteSpace: "pre-line", background: "#f3f3f3", padding: 8, borderRadius: 8, userSelect: "all" }}>{caption}</p>}
            {tags && <p style={{ margin: "0 0 12px", fontSize: 14 }}>Hashtags: <b>{tags}</b></p>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={{ ...btn(false), color: "#111", borderColor: "#999", padding: ".5em 1em", fontSize: 15 }} onClick={() => void copy("copy_caption")}>Copy caption again</button>
              <button type="button" style={{ ...btn(), padding: ".5em 1.2em", fontSize: 15 }} onClick={() => setGuide(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
