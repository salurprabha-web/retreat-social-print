import { createHash } from "node:crypto";
import {
  SYNC_BATCH_ROWS, SYNC_TABLES, rowKey, stableStringify,
  type Row, type SyncStatus, type SyncTable,
} from "@rsp/shared";
import type { Pool } from "./db";
import { getFile, statFile, storageContext } from "./storage";
import { latestSchema } from "./offlinePackage";

/**
 * Local-server side of offline mode: delivers what happened here (guests, photos, finished pictures, print history) to the cloud.
 * Safe to run any time and as often as wanted: it only sends what changed since the last confirmed delivery, files go before the
 * rows that use them, and the cloud ignores anything it already has, so a crash or a lost connection never loses or duplicates data.
 */
export interface SyncConfig { cloudUrl: string; tokens: string[]; storageDir?: string; fetchImpl?: typeof fetch }

class CloudDown extends Error { }                                          // cannot reach the cloud at all
class CloudRefused extends Error { constructor(public status: number, public code: string) { super(`${status} ${code}`); } }

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const tokenId = (t: string) => sha(t).slice(0, 16);                        // lets status remember which event a token belongs to without storing the token

function client(cfg: SyncConfig, token: string) {
  const f = cfg.fetchImpl ?? fetch;
  async function call(method: string, path: string, body?: unknown, extra: { raw?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {}) {
    let res: Response;
    try {
      res = await f(`${cfg.cloudUrl}${path}`, {
        method, signal: AbortSignal.timeout(extra.timeoutMs ?? 30_000),
        headers: { authorization: `Bearer ${token}`, ...(extra.raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}), ...(extra.headers ?? {}) },
        body: extra.raw ? new Uint8Array(extra.raw) : body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: any) { throw new CloudDown(e?.cause?.code ?? e?.name ?? "network"); }
    // A reverse proxy in front of a cloud that is down or restarting answers 502/503/504: that is "cannot reach the cloud", not a refusal.
    if (res.status === 502 || res.status === 503 || res.status === 504) { await res.arrayBuffer().catch(() => {}); throw new CloudDown(`http_${res.status}`); }
    const text = await res.text(); let j: any = {}; try { j = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    if (!res.ok) throw new CloudRefused(res.status, j.error ?? `http_${res.status}`);
    return j;
  }
  return {
    ping: () => call("GET", "/api/v1/sync/ping") as Promise<{ eventId: string; name: string }>,
    check: (files: { key: string; size: number }[]) => call("POST", "/api/v1/sync/files/check", { files }) as Promise<{ missing: string[] }>,
    putFile: (key: string, data: Buffer) => call("PUT", `/api/v1/sync/file?key=${encodeURIComponent(key)}`, undefined, { raw: data, headers: { "x-sha256": sha(data) }, timeoutMs: 300_000 }),
    push: (payload: unknown) => call("POST", "/api/v1/sync/push", payload, { timeoutMs: 60_000 }) as Promise<{ ok: boolean }>,
  };
}

interface Pending { table: SyncTable; row: Row; key: string; hash: string }

/** Compares this server's rows of one event with what was last delivered. */
async function diff(pool: Pool, eventId: string) {
  const state = new Map<string, string>();
  for (const r of (await pool.query("SELECT entity,row_key,hash FROM sync_state WHERE event_id=$1", [eventId])).rows) state.set(`${r.entity}|${r.row_key}`, r.hash);
  const upserts: Pending[] = []; const seen = new Set<string>();
  for (const table of SYNC_TABLES) {
    const rows = (await pool.query(`SELECT to_jsonb(t) AS j FROM ${table.name} t WHERE t.event_id=$1 ORDER BY ${table.pk.map((c) => `t.${c}`).join(",")}`, [eventId])).rows.map((r) => r.j as Row);
    for (const row of rows) {
      const key = rowKey(table, row); const id = `${table.name}|${key}`; seen.add(id);
      const hash = table.serial ? "1" : sha(stableStringify(row));          // numbered history rows never change, so they are sent once
      if (state.get(id) !== hash) upserts.push({ table, row, key, hash });
    }
  }
  const deletes: { table: SyncTable; key: string }[] = [];
  for (const id of state.keys()) {
    if (seen.has(id)) continue;
    const [entity, key] = [id.slice(0, id.indexOf("|")), id.slice(id.indexOf("|") + 1)];
    const table = SYNC_TABLES.find((t) => t.name === entity);
    if (table && !table.serial) deletes.push({ table, key });
  }
  return { upserts, deletes };
}

export async function countPending(pool: Pool, eventId: string): Promise<number> {
  const d = await diff(pool, eventId); return d.upserts.length + d.deletes.length;
}

/** One delivery round for one event: as many batches as needed (bounded), files before rows. */
async function syncEvent(pool: Pool, cl: ReturnType<typeof client>, eventId: string) {
  const schema = await latestSchema(pool);
  let pushed = 0, deleted = 0, filesSent = 0, skipped = 0;
  for (let round = 0; round < 40; round++) {
    const { upserts, deletes } = await diff(pool, eventId);
    if (!upserts.length && !deletes.length) break;
    const batch = upserts.slice(0, SYNC_BATCH_ROWS); const delBatch = deletes.slice(0, SYNC_BATCH_ROWS);

    // 1. files that go with these rows
    const need: { row: Pending; key: string }[] = [];
    for (const p of batch) for (const col of p.table.files) { const k = p.row[col]; if (typeof k === "string") need.push({ row: p, key: k }); }
    const sizes = new Map<string, number>(); const unsendable = new Set<Pending>();
    for (const n of need) { const s = await statFile(n.key); if (s === null) { unsendable.add(n.row); skipped++; } else sizes.set(n.key, s); }
    if (sizes.size) {
      const { missing } = await cl.check([...sizes].map(([key, size]) => ({ key, size })));
      for (const key of missing) { await cl.putFile(key, await getFile(key)); filesSent++; }
    }
    // 2. the rows (a row whose file is gone is held back and reported, never sent half-complete)
    const send = batch.filter((p) => !unsendable.has(p));
    if (!send.length && !delBatch.length) break;
    const rows: Record<string, Row[]> = {}; for (const p of send) (rows[p.table.name] ??= []).push(p.row);
    const dels: Record<string, string[]> = {}; for (const d of delBatch) (dels[d.table.name] ??= []).push(d.key);
    await cl.push({ schema, rows, deletes: dels });
    // 3. only now is it recorded as delivered
    for (const p of send) await pool.query("INSERT INTO sync_state(event_id,entity,row_key,hash) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id,entity,row_key) DO UPDATE SET hash=EXCLUDED.hash, synced_at=now()", [eventId, p.table.name, p.key, p.hash]);
    for (const d of delBatch) await pool.query("DELETE FROM sync_state WHERE event_id=$1 AND entity=$2 AND row_key=$3", [eventId, d.table.name, d.key]);
    pushed += send.length; deleted += delBatch.length;
    if (unsendable.size && send.length === 0) break;                          // nothing else can move this round
  }
  const left = await countPending(pool, eventId);
  return { pushed, deleted, filesSent, skipped, pending: left };
}

interface Meta { lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null; cloudReachable: boolean | null; events: SyncStatus["events"]; tokens: Record<string, string> }
const emptyMeta = (): Meta => ({ lastAttemptAt: null, lastSuccessAt: null, lastError: null, cloudReachable: null, events: [], tokens: {} });
async function readMeta(pool: Pool): Promise<Meta> {
  const r = (await pool.query("SELECT value FROM sync_meta WHERE key='status'")).rows[0];
  return { ...emptyMeta(), ...(r?.value ?? {}) };
}
async function writeMeta(pool: Pool, m: Meta) {
  await pool.query("INSERT INTO sync_meta(key,value) VALUES ('status',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify(m)]);
}

const inflight = new WeakMap<Pool, Promise<SyncStatus>>();

/** Runs one synchronisation round for every configured sync credential and records the outcome for the status screens. */
export function runSyncCycle(pool: Pool, cfg: SyncConfig): Promise<SyncStatus> {
  const running = inflight.get(pool); if (running) return running;
  const work = () => cycle(pool, cfg);
  const p = (cfg.storageDir ? storageContext.run({ root: cfg.storageDir }, work) : work()).finally(() => inflight.delete(pool));
  inflight.set(pool, p); return p;
}

async function cycle(pool: Pool, cfg: SyncConfig): Promise<SyncStatus> {
  const meta = await readMeta(pool); const now = new Date().toISOString();
  meta.lastAttemptAt = now; const events: SyncStatus["events"] = []; let errors: string[] = []; let reachable: boolean | null = null; let anyOk = false;
  for (const token of cfg.tokens) {
    const cl = client(cfg, token); const tid = tokenId(token);
    try {
      const who = await cl.ping();                                          // proves the cloud is reachable and the credential is valid
      reachable = true; meta.tokens[tid] = who.eventId;
      const r = await syncEvent(pool, cl, who.eventId);
      events.push({ eventId: who.eventId, pending: r.pending, lastSuccessAt: new Date().toISOString(), error: r.skipped ? `${r.skipped} file(s) missing on this server were held back` : null });
      anyOk = true;
    } catch (e: any) {
      const eventId = meta.tokens[tid] ?? null;
      const msg = e instanceof CloudDown ? "Cannot reach the cloud" : e instanceof CloudRefused ? `Cloud refused: ${e.code}` : String(e?.message ?? e);
      if (e instanceof CloudDown) reachable = false;                       // the connection dropped, even if the first call got through
      else reachable = reachable ?? true;
      errors.push(msg);
      const targets = eventId ? [eventId] : (await pool.query("SELECT DISTINCT event_id FROM guest_sessions")).rows.map((r) => r.event_id as string);
      for (const id of targets) events.push({ eventId: id, pending: await countPending(pool, id).catch(() => 0), lastSuccessAt: meta.events.find((x) => x.eventId === id)?.lastSuccessAt ?? null, error: msg });
    }
  }
  meta.events = events; meta.cloudReachable = reachable; meta.lastError = errors[0] ?? null;
  if (anyOk && !errors.length) meta.lastSuccessAt = new Date().toISOString();
  await writeMeta(pool, meta);
  return statusFrom(meta, cfg, false);
}

function statusFrom(meta: Meta, cfg: SyncConfig | null, running: boolean): SyncStatus {
  return {
    mode: "local", configured: !!cfg && !!cfg.cloudUrl && cfg.tokens.length > 0, cloudUrl: cfg?.cloudUrl || null, running,
    lastAttemptAt: meta.lastAttemptAt, lastSuccessAt: meta.lastSuccessAt, lastError: meta.lastError, cloudReachable: meta.cloudReachable,
    events: meta.events, pendingTotal: meta.events.reduce((n, e) => n + e.pending, 0),
  };
}

export async function getSyncStatus(pool: Pool, cfg: SyncConfig | null): Promise<SyncStatus> {
  return statusFrom(await readMeta(pool), cfg, inflight.has(pool));
}

/** Starts the periodic delivery on a local server. Errors are recorded in the status, never thrown into the process. */
export function startSyncTimer(pool: Pool, cfg: SyncConfig, everySeconds: number): () => void {
  const tick = () => { runSyncCycle(pool, cfg).catch((e) => console.error("[sync] cycle failed:", e?.message ?? e)); };
  const t = setInterval(tick, Math.max(5, everySeconds) * 1000); t.unref(); tick();
  return () => clearInterval(t);
}
