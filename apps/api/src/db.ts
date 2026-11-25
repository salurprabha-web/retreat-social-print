import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, opts: { max?: number; idleMs?: number; connectMs?: number } = {}): Pool {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 20, ...(opts.idleMs ? { idleTimeoutMillis: opts.idleMs } : {}), ...(opts.connectMs ? { connectionTimeoutMillis: opts.connectMs } : {}) });
  // An idle connection can be dropped at any time (database restart, network blip). Without this handler Node treats
  // the pool's 'error' event as fatal and the whole server exits; with it the bad connection is discarded and replaced.
  pool.on("error", (e) => { console.error(`[db] idle connection error (connection discarded): ${e.message}`); });
  return pool;
}

/** Run fn inside a transaction; commits on success, rolls back on any throw. */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const out = await fn(tx);
    await tx.query("COMMIT");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Applies pending *.sql files in name order, each in its own transaction. Safe to re-run. */
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    await withTx(pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(727002)"); // serialize concurrent migrators
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    });
    applied.push(f);
  }
  return applied;
}
