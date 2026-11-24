export const config = {
  port: Number(process.env.PORT ?? 4100),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5434/rsp",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  loginRateLimitPerMin: Number(process.env.LOGIN_RATE_LIMIT_PER_MIN ?? 10),
  guestRateLimitPerMin: Number(process.env.GUEST_RATE_LIMIT_PER_MIN ?? 240),
  globalRateLimitPerMin: Number(process.env.GLOBAL_RATE_LIMIT_PER_MIN ?? 1200),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  storageDir: process.env.STORAGE_DIR ?? "./storage",
};
