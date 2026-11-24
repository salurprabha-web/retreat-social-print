import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import sharp from "sharp";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** 10 characters from a 32-letter alphabet (50 random bits): short enough to type, impossible to guess or enumerate. */
export const newQrCode = () => Array.from(randomBytes(10), (b) => ALPHABET[b % 32]).join("");
export const QR_CODE_RE = /^[a-z2-7]{10}$/;

export interface QrStyle { fg: string; bg: string; logo: boolean; margin: number }
export const DEFAULT_QR_STYLE: QrStyle = { fg: "#000000", bg: "#ffffff", logo: false, margin: 2 };

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** A QR that phones cannot read is worse than none: dark-on-light with at least 4:1 contrast. */
export function qrContrastOk(fg: string, bg: string): boolean {
  const a = lum(fg), b = lum(bg);
  return a < b && (b + 0.05) / (a + 0.05) >= 4;
}

/** Prepares an uploaded logo (any supported format) as a PNG square that fits the centre of the code. */
async function logoPng(logo: Buffer, side: number): Promise<Buffer> {
  return sharp(logo, { density: 300 }).resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

export async function qrPng(url: string, style: QrStyle, size: number, logo: Buffer | null): Promise<Buffer> {
  const useLogo = style.logo && !!logo;
  const png = await QRCode.toBuffer(url, { type: "png", width: size, margin: style.margin, errorCorrectionLevel: useLogo ? "H" : "M", color: { dark: style.fg, light: style.bg } });
  if (!useLogo) return png;
  const side = Math.round(size * 0.2), pad = Math.round(side * 0.14);
  const plate = await sharp({ create: { width: side + 2 * pad, height: side + 2 * pad, channels: 4, background: style.bg } })
    .composite([{ input: await logoPng(logo!, side), gravity: "center" }]).png().toBuffer();
  return sharp(png).composite([{ input: plate, gravity: "center" }]).png().toBuffer();
}

export async function qrSvg(url: string, style: QrStyle, size: number, logo: Buffer | null): Promise<string> {
  const useLogo = style.logo && !!logo;
  let svg = await QRCode.toString(url, { type: "svg", width: size, margin: style.margin, errorCorrectionLevel: useLogo ? "H" : "M", color: { dark: style.fg, light: style.bg } });
  if (!useLogo) return svg;
  const n = Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1] ?? 0);
  if (!n) return svg;
  const side = n * 0.2, pad = side * 0.14, x = (n - side) / 2;
  const data = (await logoPng(logo!, 400)).toString("base64");
  const plate = `<rect x="${x - pad}" y="${x - pad}" width="${side + 2 * pad}" height="${side + 2 * pad}" fill="${style.bg}"/>` +
    `<image x="${x}" y="${x}" width="${side}" height="${side}" href="data:image/png;base64,${data}"/>`;
  return svg.replace("</svg>", `${plate}</svg>`);
}
