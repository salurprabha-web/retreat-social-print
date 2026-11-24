"use client";
import { useEffect, useRef, useState } from "react";

/** Kiosk / laptop camera. The stream is always stopped when this closes or unmounts. */
export function Webcam({ onCapture, onClose }: { onCapture: (b: Blob) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [err, setErr] = useState(""); const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false })
      .then((s) => { if (dead) { s.getTracks().forEach((t) => t.stop()); return; } stream.current = s; if (video.current) { video.current.srcObject = s; video.current.play().catch(() => {}); } })
      .catch((e) => setErr(e?.name === "NotAllowedError" ? "Camera access was blocked. Allow the camera in your browser, or choose a photo instead." : "No camera was found. Choose a photo instead."));
    return () => { dead = true; stream.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  function snap() {
    const v = video.current; if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) { stream.current?.getTracks().forEach((t) => t.stop()); onCapture(b); } }, "image/jpeg", 0.95);
  }
  return (
    <div style={{ width: "min(100%, 40em)" }}>
      {err ? <p role="alert">{err}</p> : (
        <video ref={video} playsInline muted onLoadedMetadata={() => setReady(true)} style={{ width: "100%", borderRadius: 10, background: "#000", transform: "scaleX(-1)" }} />
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 10 }}>
        {!err && <button type="button" onClick={snap} disabled={!ready} style={{ width: "auto", margin: 0, padding: "12px 28px", borderRadius: 999, border: 0, fontWeight: 700, cursor: "pointer" }}>Capture</button>}
        <button type="button" onClick={onClose} style={{ width: "auto", margin: 0, padding: "12px 20px", background: "transparent", color: "inherit", border: "1px solid currentColor", borderRadius: 999, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}
