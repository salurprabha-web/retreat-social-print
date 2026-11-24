const isProd = process.env.NODE_ENV === "production";
if (isProd && !process.env.SESSION_SECRET) throw new Error("SESSION_SECRET must be set in production (signs photo links)");

export const config = {
  port: Number(process.env.PORT ?? 4100),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5434/rsp",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  loginRateLimitPerMin: Number(process.env.LOGIN_RATE_LIMIT_PER_MIN ?? 10),
  guestRateLimitPerMin: Number(process.env.GUEST_RATE_LIMIT_PER_MIN ?? 240),
  composeRateLimitPerMin: Number(process.env.COMPOSE_RATE_LIMIT_PER_MIN ?? 120),
  globalRateLimitPerMin: Number(process.env.GLOBAL_RATE_LIMIT_PER_MIN ?? 1200),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  storageDir: process.env.STORAGE_DIR ?? "./storage",
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
