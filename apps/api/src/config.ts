const isProd = process.env.NODE_ENV === "production";
if (isProd && !process.env.SESSION_SECRET) {
  console.error("[config] ERROR: SESSION_SECRET is not set. It signs photo links; use at least 32 random characters (for example: openssl rand -hex 32).\nRefusing to start with an unsafe configuration.");
  process.exit(1);
}

import { parseTrustProxy } from "./prodcheck";

export const config = {
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  logLevel: process.env.LOG_LEVEL ?? (isProd ? "info" : "silent"),
  port: Number(process.env.PORT ?? 4100),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5434/rsp",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  loginRateLimitPerMin: Number(process.env.LOGIN_RATE_LIMIT_PER_MIN ?? 10),
  guestRateLimitPerMin: Number(process.env.GUEST_RATE_LIMIT_PER_MIN ?? 240),
  composeRateLimitPerMin: Number(process.env.COMPOSE_RATE_LIMIT_PER_MIN ?? 120),
  globalRateLimitPerMin: Number(process.env.GLOBAL_RATE_LIMIT_PER_MIN ?? 1200),
  // Secure cookies are the default in production (set COOKIE_SECURE=false only for plain-http development).
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProd,
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  // STORAGE_BACKEND=s3 keeps files in S3-compatible object storage (Cloudflare R2); otherwise they are on the local disk (STORAGE_DIR).
  storage: {
    backend: (process.env.STORAGE_BACKEND === "s3" ? "s3" : "disk") as "s3" | "disk",
    s3: {
      endpoint: process.env.S3_ENDPOINT || undefined,           // R2: https://<account id>.r2.cloudflarestorage.com
      bucket: process.env.S3_BUCKET ?? "",
      region: process.env.S3_REGION ?? "auto",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      prefix: process.env.S3_PREFIX ?? "",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    },
  },
  directUrlTtlSeconds: Number(process.env.DIRECT_URL_TTL_SECONDS ?? 300),   // lifetime of a signed storage address handed to a browser
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
  urlSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret",
  compositionUrlTtlHours: Number(process.env.COMPOSITION_URL_TTL_HOURS ?? 24),
  printStaleSeconds: Number(process.env.PRINT_STALE_SECONDS ?? 300),     // a job "printing" longer than this goes back in the queue
  agentRateLimitPerMin: Number(process.env.AGENT_RATE_LIMIT_PER_MIN ?? 600),
  // Offline mode: "local" = a venue server that keeps working without internet and pushes its data to the cloud when it can.
  mode: (process.env.RSP_MODE === "local" ? "local" : "cloud") as "cloud" | "local",
  cloudUrl: (process.env.CLOUD_URL ?? "").replace(/\/+$/, ""),
  syncTokens: (process.env.SYNC_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  syncIntervalSeconds: Number(process.env.SYNC_INTERVAL_SECONDS ?? 20),
  agentRegisterLimitPerMin: Number(process.env.AGENT_REGISTER_LIMIT_PER_MIN ?? 10),
};
