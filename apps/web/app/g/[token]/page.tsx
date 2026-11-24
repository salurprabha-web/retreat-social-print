"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { deviceForWidth, DEVICE_INFO, type Device, type EventInfo, type PageDefinition } from "@rsp/shared";
import { GuestPage } from "../../../components/GuestPage";

interface Pub { definition: PageDefinition; event: EventInfo; logos: { event: boolean; client: boolean } }

export default function Guest() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Pub | null>(null);
  const [missing, setMissing] = useState(false);
  const [device, setDevice] = useState<Device>("mobile");
  const [notice, setNotice] = useState(false);
  const [vw, setVw] = useState(390);
  const [vh, setVh] = useState(780);

  useEffect(() => {
    fetch(`/api/v1/public/g/${token}`).then(async (r) => { if (r.ok) setData(await r.json()); else setMissing(true); }).catch(() => setMissing(true));
  }, [token]);
  useEffect(() => {
    const f = () => { setVw(window.innerWidth); setVh(window.innerHeight); setDevice(deviceForWidth(window.innerWidth)); };
    f(); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f);
  }, []);

  if (missing) return <div style={{ padding: 32, textAlign: "center" }}><h1>This page is not available</h1><p>The event may not have started, or the link is no longer active.</p></div>;
  if (!data) return null;
  // Fit the logical design width to the real screen (kiosk/43-inch designs are laid out at their native size).
  const zoom = vw / DEVICE_INFO[device].width;
  return (
    <div style={{ width: vw, overflowX: "hidden" }}>
      <div style={{ zoom }}>
        <GuestPage def={data.definition} event={data.event} device={device} minHeight={vh / zoom} guestUrl={typeof window !== "undefined" ? window.location.href : ""}
          assetUrl={(n) => `/api/v1/public/g/${token}/asset/${n}`}
          logoUrl={(k) => (data.logos[k] ? `/api/v1/public/g/${token}/logo/${k}` : null)}
          onStart={() => setNotice(true)} />
      </div>
      {notice && <div role="status" style={{ position: "fixed", left: 12, right: 12, bottom: 12, background: "#111", color: "#fff", padding: 14, borderRadius: 10, textAlign: "center" }}>
        The photo experience arrives in the next release. This is your event's landing page.</div>}
    </div>
  );
}
