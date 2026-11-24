"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { deviceForWidth, DEVICE_INFO, type Device } from "@rsp/shared";
import { GuestFlow, type PublicData } from "../../../components/guest/GuestFlow";

export default function Guest() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicData | null>(null);
  const [missing, setMissing] = useState(false);
  const [device, setDevice] = useState<Device>("mobile");
  const [vw, setVw] = useState(390); const [vh, setVh] = useState(780);

  useEffect(() => {
    fetch(`/api/v1/public/g/${token}`).then(async (r) => { if (r.ok) setData(await r.json()); else setMissing(true); }).catch(() => setMissing(true));
  }, [token]);
  useEffect(() => {
    const f = () => { setVw(window.innerWidth); setVh(window.innerHeight); setDevice(deviceForWidth(window.innerWidth)); };
    f(); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f);
  }, []);

  if (missing) return <div style={{ padding: 32, textAlign: "center" }}><h1>This page is not available</h1><p>The event may not have started, or the link is no longer active.</p></div>;
  if (!data) return null;
  // The design is laid out at its native size for the device class, then scaled to the real screen.
  const zoom = vw / DEVICE_INFO[device].width;
  return (
    <div style={{ width: vw, overflowX: "hidden" }}>
      <div style={{ zoom }}><GuestFlow token={token} data={data} device={device} zoom={zoom} vh={vh} /></div>
    </div>
  );
}
