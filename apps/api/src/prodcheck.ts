/**
 * Startup checks for a production server. A misconfigured production server must refuse to start with a clear message,
 * not run with a development secret or insecure cookies. Pure function of the environment, so it is unit-tested.
 */
export interface EnvCheck { errors: string[]; warnings: string[] }

const DEV_SECRETS = new Set(["dev-only-insecure-secret", "changeme", "secret", "password", "please-change-me"]);

export function checkProductionEnv(env: Record<string, string | undefined>): EnvCheck {
  const errors: string[] = [], warnings: string[] = [];
  const secret = env.SESSION_SECRET ?? "";
  if (!secret) errors.push("SESSION_SECRET is not set. It signs photo links; use at least 32 random characters (for example: openssl rand -hex 32).");
  else if (secret.length < 32) errors.push(`SESSION_SECRET is too short (${secret.length} characters). Use at least 32 random characters.`);
  else if (DEV_SECRETS.has(secret.toLowerCase()) || /^(.)\1+$/.test(secret)) errors.push("SESSION_SECRET is a placeholder. Use at least 32 random characters.");

  const db = env.DATABASE_URL ?? "";
  if (!db) errors.push("DATABASE_URL is not set.");
  else if (/postgres:postgres@/i.test(db) || /:(postgres|password|changeme)@/i.test(db)) errors.push("DATABASE_URL uses a default database password. Create a dedicated user with a strong password.");
  else if (!/^postgres(ql)?:\/\//i.test(db)) errors.push("DATABASE_URL must start with postgres://");

  const base = env.PUBLIC_BASE_URL ?? "";
  if (!base) warnings.push("PUBLIC_BASE_URL is not set: QR codes will use the address of the admin page that created them. Set it to the public https:// address.");
  else if (!/^https:\/\//i.test(base)) errors.push("PUBLIC_BASE_URL must be an https:// address in production (guest cameras and share sheets need a secure page).");

  if ((env.COOKIE_SECURE ?? "").toLowerCase() === "false") errors.push("COOKIE_SECURE=false would send the staff session cookie over plain http. Remove it or set it to true.");
  if (env.RSP_MODE === "local") {
    // A venue server is normally reached over the venue network (plain http), so only the secrets are checked strictly.
    if (env.CLOUD_URL && !/^https:\/\//i.test(env.CLOUD_URL)) errors.push("CLOUD_URL must be an https:// address: the sync credential travels with every request.");
    if (env.CLOUD_URL && !env.SYNC_TOKENS) warnings.push("CLOUD_URL is set but SYNC_TOKENS is empty: nothing will be delivered to the cloud.");
    if (!env.CLOUD_URL && env.SYNC_TOKENS) warnings.push("SYNC_TOKENS is set but CLOUD_URL is empty: nothing will be delivered to the cloud.");
  }
  const s3 = env.STORAGE_BACKEND === "s3";
  if (s3) {
    if (!env.S3_BUCKET) errors.push("STORAGE_BACKEND=s3 needs S3_BUCKET.");
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) errors.push("STORAGE_BACKEND=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.");
    if (env.S3_ENDPOINT && !/^https:\/\//i.test(env.S3_ENDPOINT) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(env.S3_ENDPOINT)) errors.push("S3_ENDPOINT must be an https:// address (the storage credentials and every photo travel over it).");
  }
  // A host that runs the API as short-lived functions (Vercel) has no disk to keep, no memory shared between requests and no timers.
  // Each of these would otherwise fail silently, so they are refused at start.
  if (env.VERCEL) {
    if (!s3) errors.push("On Vercel there is no persistent disk: set STORAGE_BACKEND=s3 (Cloudflare R2 or another S3-compatible bucket).");
    if (env.RATE_LIMIT_STORE !== "pg") errors.push("On Vercel set RATE_LIMIT_STORE=pg: counters kept in memory are per function instance and would not limit anything.");
    if ((env.CRON_SECRET ?? "").length < 32) errors.push("On Vercel set CRON_SECRET (32+ random characters): the scheduled jobs (automatic data deletion, print requeue) are switched off without it.");
    if (env.RSP_MODE === "local") errors.push("RSP_MODE=local (an offline venue server) must not run on Vercel.");
  }
  if (!s3 && !env.STORAGE_DIR) warnings.push("STORAGE_DIR is not set: photos are stored in ./storage relative to the working directory. Set an absolute path on a persistent, backed-up volume.");
  else if (!s3 && env.STORAGE_DIR && !/^([A-Za-z]:[\\/]|\/)/.test(env.STORAGE_DIR)) warnings.push("STORAGE_DIR is a relative path. Use an absolute path so it does not depend on where the server is started.");
  const tp = (env.TRUST_PROXY ?? "").toLowerCase();
  if (!tp) warnings.push("TRUST_PROXY is not set (default: trust the first proxy). The API must only be reachable through your reverse proxy, otherwise clients can fake their address and dodge rate limits.");
  return { errors, warnings };
}

/** TRUST_PROXY: "false", "true", a number of proxy hops, or a comma-separated list of proxy addresses/networks. */
export function parseTrustProxy(v: string | undefined): boolean | number | string[] {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "" || s === "true") return true;
  if (s === "false" || s === "0") return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
