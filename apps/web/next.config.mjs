import path from "node:path";
import { fileURLToPath } from "node:url";

const api = process.env.API_URL ?? "http://localhost:4100";
const isProd = process.env.NODE_ENV === "production";
const standalone = process.env.NEXT_STANDALONE === "1";
// With object storage (Cloudflare R2) the phone uploads photos straight to the bucket, so the page must be allowed to connect there.
// Set STORAGE_CONNECT_ORIGIN (build time) to the bucket's address, e.g. https://<account id>.r2.cloudflarestorage.com. Nothing else is opened.
const storageOrigin = (process.env.STORAGE_CONNECT_ORIGIN ?? "").trim();
if (storageOrigin && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(storageOrigin)) throw new Error("STORAGE_CONNECT_ORIGIN must look like https://host (no path, no wildcard)");

/**
 * Browser-side protection for every page. The camera is allowed on our own pages only (guests take photos with it); everything else
 * that a page could ask the browser for is switched off. The Content-Security-Policy applies in production only (the development
 * server needs eval and web sockets). Scripts and styles still allow 'unsafe-inline' because Next.js writes inline bootstrap data.
 */
const csp = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self' data:",
  `connect-src 'self'${storageOrigin ? " " + storageOrigin : ""}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'", "worker-src 'self' blob:",
].join("; ");
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(self), fullscreen=(self), screen-wake-lock=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProd ? [{ key: "Content-Security-Policy", value: csp }] : []),
];

export default {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",   // lets a second dev server (a local venue server demo) run beside the first
  ...(standalone ? { output: "standalone", outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../..") } : {}),
  poweredByHeader: false,
  transpilePackages: ["@rsp/shared"],
  compress: false,   // gzip would buffer the live (SSE) print stream; compression belongs to the reverse proxy
  async headers() { return [{ source: "/:path*", headers: securityHeaders }]; },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      // What a scanned QR code opens: the API counts the scan and redirects to the guest page.
      { source: "/q/:code", destination: `${api}/api/v1/public/q/:code` },
    ];
  },
};
