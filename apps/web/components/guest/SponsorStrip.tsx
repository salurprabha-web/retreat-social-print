"use client";
import type { SponsorPlacement } from "@rsp/shared";

export interface PubSponsor { id: string; name: string; url: string | null; hashtag: string | null; hasLogo: boolean; placement: SponsorPlacement }

/** "Presented by" logos on guest screens. Sponsors set to show elsewhere only (print, wall) are not listed here. */
export function SponsorStrip({ token, sponsors }: { token: string; sponsors: PubSponsor[] }) {
  const shown = sponsors.filter((s) => s.placement.guest && (s.hasLogo || s.name));
  if (!shown.length) return null;
  return (
    <div aria-label="Sponsors" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginTop: 8 }}>
      <div style={{ fontSize: ".7em", letterSpacing: ".12em", textTransform: "uppercase", opacity: .75 }}>Presented by</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 22px", justifyContent: "center", alignItems: "center" }}>
        {shown.map((s) => {
          const inner = s.hasLogo
            ? <img src={`/api/v1/public/g/${token}/sponsor/${s.id}/logo`} alt={s.name} style={{ maxHeight: "3.2em", maxWidth: "9em", objectFit: "contain", display: "block" }} />
            : <span style={{ fontWeight: 700 }}>{s.name}</span>;
          return s.url
            ? <a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer sponsored" style={{ color: "inherit" }}>{inner}</a>
            : <span key={s.id}>{inner}</span>;
        })}
      </div>
    </div>
  );
}
