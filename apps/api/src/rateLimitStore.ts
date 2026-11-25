import type { Pool } from "./db";

/**
 * Rate-limit counters for @fastify/rate-limit.
 *
 * The plugin keeps counters in the memory of one process. On a serverless host each request can land in a different instance, so such
 * counters never add up and a limit on sign-in would not limit anything. This store keeps the STRICT per-route limits in the database
 * (one atomic upsert per limited request). The very high global per-address limit stays in memory (it is only a coarse safety net and
 * must not cost a database round trip on every request).
 *
 * The plugin calls `child()` once for every route that has its own `config.rateLimit`; that is where the database store takes over.
 */
export class PgRateLimitStore {
  constructor(private readonly pool: Pool) {}

  /** Counts one request. `timeWindow` is in milliseconds. Returns the count in the current window and the milliseconds until it ends. */
  incr(key: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void, timeWindow: number): void {
    const secs = Math.max(1, timeWindow) / 1000;
    this.pool.query(
      `INSERT INTO rate_limits AS r(key, count, window_start) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         count        = CASE WHEN r.window_start + make_interval(secs => $2) <= now() THEN 1 ELSE r.count + 1 END,
         window_start = CASE WHEN r.window_start + make_interval(secs => $2) <= now() THEN now() ELSE r.window_start END
       RETURNING count, (EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - now())) * 1000)::float8 AS ttl_ms`,
      [key.slice(0, 300), secs],
    ).then((r) => cb(null, { current: r.rows[0].count, ttl: Math.max(0, Math.round(r.rows[0].ttl_ms)) }), (e) => cb(e));
  }

  child() { return this; }
}

/** In-memory store for the global limit; hands every route that has its own limit to the database store. */
export class HybridRateLimitStore {
  private readonly local = new Map<string, { current: number; start: number }>();
  constructor(private readonly db: PgRateLimitStore) {}

  incr(key: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void, timeWindow: number): void {
    const now = Date.now(); let e = this.local.get(key);
    if (!e || e.start + timeWindow <= now) { e = { current: 1, start: now }; if (this.local.size > 20000) this.local.clear(); } else e.current++;
    this.local.set(key, e);
    cb(null, { current: e.current, ttl: e.start + timeWindow - now });
  }

  child() { return this.db; }
}

/** Counters older than a day are of no use any more. Run from the maintenance job. */
export async function purgeRateLimits(pool: Pool): Promise<number> {
  return (await pool.query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'")).rowCount ?? 0;
}
