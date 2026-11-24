import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import { wrapLines } from "./compose";
import { fontFamilies, registerFonts } from "./fonts";

export const POSTER = { width: 2480, height: 3508 };   // A4 at 300 DPI

/** Print-ready A4 poster: logo, event name, big QR, hashtag. Same bundled fonts as the photos. */
export async function renderPoster(o: { eventName: string; hashtag: string | null; qr: Buffer; qrSize: number; logo: Buffer | null; accent: string }): Promise<Buffer> {
  registerFonts();
  const { width: W, height: H } = POSTER;
  const c = createCanvas(W, H); const x = c.getContext("2d");
  x.fillStyle = "#ffffff"; x.fillRect(0, 0, W, H); x.textAlign = "center"; x.textBaseline = "alphabetic";

  let size = 150, lines: string[] = [];
  for (const s of [150, 120, 96]) { size = s; x.font = `${s}px ${fontFamilies("sans", true, false)}`; lines = wrapLines(x, o.eventName, 2100); if (lines.length <= 3) break; }
  lines = lines.slice(0, 4);
  x.fillStyle = "#111111"; x.font = `${size}px ${fontFamilies("sans", true, false)}`;
  let y = 700;
  for (const l of lines) { x.fillText(l, W / 2, y); y += size * 1.15; }
  x.fillStyle = "#444444"; x.font = `86px ${fontFamilies("sans", false, false)}`;
  x.fillText("Scan to take your photo", W / 2, y + 60);

  const qrTop = 1380;
  if (o.hashtag) { x.fillStyle = o.accent; x.font = `110px ${fontFamilies("sans", true, false)}`; x.fillText(`#${o.hashtag}`, W / 2, qrTop + o.qrSize + 190); }
  x.fillStyle = "#888888"; x.font = `44px ${fontFamilies("sans", false, false)}`;
  x.fillText("RETREAT SOCIAL PRINT  ·  CAPTURE. CUSTOMIZE. SHARE. PRINT.", W / 2, H - 140);

  const layers: sharp.OverlayOptions[] = [{ input: o.qr, left: Math.round((W - o.qrSize) / 2), top: qrTop }];
  if (o.logo) {
    const l = await sharp(o.logo, { density: 300 }).resize(900, 340, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
    layers.push({ input: l.data, left: Math.round((W - l.info.width) / 2), top: 200 + Math.round((340 - l.info.height) / 2) });
  }
  return sharp(c.toBuffer("image/png")).composite(layers).png({ compressionLevel: 6 }).withMetadata({ density: 300 }).toBuffer();
}
