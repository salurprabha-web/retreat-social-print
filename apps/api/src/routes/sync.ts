import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { SYNC_MAX_FILE_BYTES, SYNC_TABLE, SYNC_TABLES, parseRowKey, syncFileKeyOk, syncFilesCheckSchema, syncPushSchema, type Row, type SyncTable } from "@rsp/shared";
import type { Pool, Tx } from "../db";
import { withTx } from "../db";
import { audit } from "../audit";
import { requirePermission, requireUser, tagAuth } from "../auth";
import { config } from "../config";
import { deleteFile, statFile, writeStable } from "../storage";
import { notifyWall } from "../wallBus";
import { notifyPrint } from "../printService";
import { wallImageKeys } from "./wall";
import { mosaicTileKey } from "../mosaicService";
import { MAX_PACKAGE_BYTES, PackageError, buildPackage, importPackage, latestSchema } from "../offlinePackage";
import { getSyncStatus, runSyncCycle } from "../syncService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THUMB_SIZES = [200, 400, 800];
const MAX_ACTIVE_CREDENTIALS = 10;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

declare module "fastify" { interface FastifyRequest { sync?: { id: string; eventId: string } } }

const colCache = new Map<string, string[]>();
async function columns(tx: Tx, table: string): Promise<string[]> {
  const hit = colCache.get(table); if (hit) return hit;
  const cols = (await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position", [table])).rows.map((r) => r.column_name as string);
  colCache.set(table, cols); return cols;
}
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Rows from a local server are rewritten to be safe here: this event only, no references to the local server's own staff, printers or devices. */
function sanitise(t: SyncTable, rows: Row[], eventId: string, credId: string): Row[] {
  return rows.map((r) => {
    const c: Row = { ...r };
    for (const col of t.nullCols) c[col] = null;
    c.event_id = eventId;
    if (t.name === "print_jobs") c.synced_from = credId;                     // makes the job a read-only record here
    return c;
  });
}

async function writeRows(tx: Tx, t: SyncTable, rows: Row[], credId: string): Promise<number> {
  if (!rows.length) return 0;
  const all = await columns(tx, t.name);
  if (t.serial) {
    // The local number means nothing here: this server numbers the row itself, and the origin makes a repeated delivery a no-op.
    const cols = all.filter((c) => c !== "id");
    const tagged = rows.map((r) => { const { id, ...rest } = r; return { ...rest, origin_key: `${credId}:${String(id)}` }; });
    const res = await tx.query(
      `INSERT INTO ${q(t.name)} (${cols.map(q).join(",")}) SELECT ${cols.map(q).join(",")} FROM jsonb_populate_recordset(NULL::${q(t.name)}, $1::jsonb)
         ON CONFLICT (origin_key) WHERE origin_key IS NOT NULL DO NOTHING RETURNING ${t.name === "qr_scan_events" ? "qr_id" : "1 AS x"}`, [JSON.stringify(tagged)]);
    if (t.name === "qr_scan_events") {                                       // scans seen at the venue count in the code's total here too
      const per = new Map<string, number>(); for (const r of res.rows) per.set(r.qr_id, (per.get(r.qr_id) ?? 0) + 1);
      for (const [qr, n] of per) await tx.query("UPDATE qr_tracking SET scans=scans+$2 WHERE id=$1", [qr, n]);
    }
    return res.rowCount ?? 0;
  }
  const update = all.filter((c) => !t.pk.includes(c));
  await tx.query(
    `INSERT INTO ${q(t.name)} (${all.map(q).join(",")}) SELECT ${all.map(q).join(",")} FROM jsonb_populate_recordset(NULL::${q(t.name)}, $1::jsonb)
       ON CONFLICT (${t.pk.map(q).join(",")}) DO UPDATE SET ${update.map((c) => `${q(c)}=EXCLUDED.${q(c)}`).join(",")}`, [JSON.stringify(rows)]);
  return rows.length;
}

/** Files and cached copies that belong to a picture or original that is being removed. */
function derivedKeys(table: string, eventId: string, id: string, key: string): string[] {
  const out = [key];
  if (table === "final_compositions") out.push(mosaicTileKey(eventId, id), ...wallImageKeys(eventId, id), ...THUMB_SIZES.map((s) => `events/${eventId}/thumbs/c-${id}-${s}.jpg`));
  if (table === "photo_uploads") out.push(...THUMB_SIZES.map((s) => `events/${eventId}/thumbs/u-${id}-${s}.jpg`));
  return out;
}

async function deleteRows(tx: Tx, t: SyncTable, keys: string[], eventId: string): Promise<{ n: number; files: string[] }> {
  const parsed = keys.map((k) => parseRowKey(t, k)); if (parsed.some((p) => !p)) throw new PackageError("bad_row_key", 422, { table: t.name });
  const ps = parsed as string[][]; const files: string[] = [];
  if (t.pk.length === 1) {
    const ids = ps.map((p) => p[0]); if (ids.some((i) => !UUID.test(i))) throw new PackageError("bad_row_key", 422, { table: t.name });
    if (t.files.length) for (const r of (await tx.query(`SELECT id, ${t.files.map(q).join(",")} FROM ${q(t.name)} WHERE event_id=$1 AND id = ANY($2::uuid[])`, [eventId, ids])).rows)
      for (const col of t.files) if (r[col]) files.push(...derivedKeys(t.name, eventId, r.id, r[col]));
    const res = await tx.query(`DELETE FROM ${q(t.name)} WHERE event_id=$1 AND ${q(t.pk[0])} = ANY($2::uuid[])`, [eventId, ids]);
    return { n: res.rowCount ?? 0, files };
  }
  const ids = ps.map((p) => p[0]); const slots = ps.map((p) => Number(p[1]));
  if (ids.some((i) => !UUID.test(i)) || slots.some((s) => !Number.isInteger(s))) throw new PackageError("bad_row_key", 422, { table: t.name });
  const res = await tx.query(`DELETE FROM ${q(t.name)} WHERE event_id=$1 AND (${t.pk.map(q).join(",")}) IN (SELECT * FROM unnest($2::uuid[], $3::int[]))`, [eventId, ids, slots]);
  return { n: res.rowCount ?? 0, files };
}

export async function syncRoutes(app: FastifyInstance, pool: Pool) {
  const edit = requirePermission(pool, "builder:edit", { eventParam: "eventId" });
  const view = requirePermission(pool, "event:view", { eventParam: "eventId" });
  const limit = { rateLimit: { max: () => config.agentRateLimitPerMin * 4, timeWindow: "1 minute" } };

  const cloudOnly = async (_req: FastifyRequest, reply: FastifyReply) => { if (app.rspMode !== "cloud") return reply.code(404).send({ error: "not_cloud_server" }); };

  /** Bearer sync credential: only a hash is stored, and it can be revoked at any time. */
  const auth = tagAuth(async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.rspMode !== "cloud") return reply.code(404).send({ error: "not_cloud_server" });
    const m = /^Bearer (sync_[a-f0-9]{48})$/.exec(String(req.headers.authorization ?? ""));
    const c = m ? (await pool.query("SELECT id,event_id FROM sync_credentials WHERE token_hash=$1 AND revoked_at IS NULL", [hashToken(m[1])])).rows[0] : null;
    if (!c) return reply.code(401).send({ error: "invalid_credential" });
    await pool.query("UPDATE sync_credentials SET last_seen_at=now(), last_ip=$2 WHERE id=$1", [c.id, req.ip]);
    req.sync = { id: c.id, eventId: c.event_id };
  }, { kind: "sync" });

  // ----- Cloud: staff manage credentials and download the event package -----
  app.post("/api/v1/events/:eventId/sync-credentials", { preHandler: [edit, cloudOnly] }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const n = (await pool.query("SELECT count(*)::int c FROM sync_credentials WHERE event_id=$1 AND revoked_at IS NULL", [eventId])).rows[0].c;
    if (n >= MAX_ACTIVE_CREDENTIALS) return reply.code(409).send({ error: "too_many_credentials" });
    const token = `sync_${randomBytes(24).toString("hex")}`;
    const r = (await pool.query("INSERT INTO sync_credentials(event_id,name,token_hash,created_by) VALUES ($1,$2,$3,$4) RETURNING id", [eventId, name, hashToken(token), req.user!.id])).rows[0];
    await audit(pool, req.user!.id, "sync_credential_create", { eventId, entity: "sync_credential", entityId: r.id, detail: { name }, ip: req.ip });
    return reply.code(201).send({ id: r.id, name, token });                  // shown once; only its hash is kept
  });

  app.get("/api/v1/events/:eventId/sync-credentials", { preHandler: [view, cloudOnly] }, async (req) => {
    const rows = (await pool.query("SELECT id,name,created_at,last_seen_at,last_ip,revoked_at FROM sync_credentials WHERE event_id=$1 ORDER BY created_at DESC", [(req.params as any).eventId])).rows;
    return { credentials: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, lastIp: r.last_ip, revoked: !!r.revoked_at })) };
  });

  app.delete("/api/v1/events/:eventId/sync-credentials/:id", { preHandler: [edit, cloudOnly] }, async (req, reply) => {
    const { eventId, id } = req.params as { eventId: string; id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "not_found" });
    const r = await pool.query("UPDATE sync_credentials SET revoked_at=now() WHERE id=$1 AND event_id=$2 AND revoked_at IS NULL", [id, eventId]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, "sync_credential_revoke", { eventId, entity: "sync_credential", entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.get("/api/v1/events/:eventId/offline/package", { preHandler: [edit, cloudOnly] }, async (req, reply) => {
    const eventId = (req.params as any).eventId as string;
    const pkg = await buildPackage(pool, eventId);
    if (!pkg) return reply.code(404).send({ error: "not_found" });
    await audit(pool, req.user!.id, "offline_package_export", { eventId, entity: "event", entityId: eventId, detail: { files: pkg.manifest.files.length, bytes: pkg.buffer.length }, ip: req.ip });
    reply.header("Content-Disposition", `attachment; filename="event-${eventId.slice(0, 8)}.rspkg"`);
    return reply.type("application/octet-stream").send(pkg.buffer);
  });

  // ----- Cloud: a local server delivers its data (credential-authenticated, one event only) -----
  app.get("/api/v1/sync/ping", { preHandler: auth, config: limit }, async (req) => {
    const e = (await pool.query("SELECT id,name FROM events WHERE id=$1", [req.sync!.eventId])).rows[0];
    return { ok: true, eventId: e.id, name: e.name, serverTime: new Date().toISOString() };
  });

  app.post("/api/v1/sync/files/check", { preHandler: auth, config: limit }, async (req, reply) => {
    const { files } = syncFilesCheckSchema.parse(req.body); const eventId = req.sync!.eventId;
    if (files.some((f) => !syncFileKeyOk(eventId, f.key))) return reply.code(422).send({ error: "bad_file_key" });
    const missing: string[] = [];
    for (const f of files) if ((await statFile(f.key)) !== f.size) missing.push(f.key);
    return { missing };
  });

  app.put("/api/v1/sync/file", { preHandler: auth, bodyLimit: SYNC_MAX_FILE_BYTES + 1024, config: limit }, async (req, reply) => {
    const eventId = req.sync!.eventId; const key = String((req.query as any).key ?? "");
    if (!syncFileKeyOk(eventId, key)) return reply.code(422).send({ error: "bad_file_key" });
    const body = req.body; const want = String(req.headers["x-sha256"] ?? "");
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(415).send({ error: "file_required" });
    if (createHash("sha256").update(body).digest("hex") !== want) return reply.code(422).send({ error: "checksum_mismatch" });   // damaged in transit: never stored
    await writeStable(key, body);
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/v1/sync/push", { preHandler: auth, bodyLimit: 16 * 1024 * 1024, config: limit }, async (req, reply) => {
    const b = syncPushSchema.parse(req.body); const { id: credId, eventId } = req.sync!;
    const mine = await latestSchema(pool);
    if (b.schema !== mine) return reply.code(409).send({ error: "version_mismatch", cloud: mine });                 // same release on both sides, or nothing moves
    for (const name of [...Object.keys(b.rows), ...Object.keys(b.deletes)]) if (!SYNC_TABLE[name]) return reply.code(422).send({ error: "unknown_table", table: name });
    for (const [name, rows] of Object.entries(b.rows)) for (const r of rows) if (r.event_id !== eventId) return reply.code(403).send({ error: "wrong_event", table: name });
    const files: string[] = []; const counts: Record<string, { upserted: number; deleted: number }> = {};
    try {
      await withTx(pool, async (tx) => {
        for (const t of SYNC_TABLES) {
          const rows = b.rows[t.name]; if (!rows?.length) continue;
          counts[t.name] = { upserted: await writeRows(tx, t, sanitise(t, rows, eventId, credId), credId), deleted: 0 };
        }
        for (const t of [...SYNC_TABLES].reverse()) {                          // children before parents
          const keys = b.deletes[t.name]; if (!keys?.length) continue;
          const r = await deleteRows(tx, t, keys, eventId); files.push(...r.files);
          (counts[t.name] ??= { upserted: 0, deleted: 0 }).deleted = r.n;
        }
      });
    } catch (e: any) {
      if (e instanceof PackageError) return reply.code(e.status).send({ error: e.code, ...e.extra });
      if (e.code === "23505") return reply.code(409).send({ error: "conflict", detail: e.constraint });
      if (e.code === "23503") return reply.code(409).send({ error: "missing_parent", detail: e.constraint });
      throw e;
    }
    for (const k of files) await deleteFile(k).catch(() => {});             // after the commit: removed here means removed everywhere
    await audit(pool, null, "sync_push", { eventId, entity: "sync", entityId: credId, detail: counts, ip: req.ip });
    notifyWall(eventId); notifyPrint(eventId);
    return { ok: true, counts };
  });

  // ----- Local server: install an event package, see the connection, deliver now -----
  app.post("/api/v1/offline/import", { preHandler: requireUser(pool), bodyLimit: MAX_PACKAGE_BYTES + 1024 }, async (req, reply) => {
    if (app.rspMode !== "local") return reply.code(409).send({ error: "not_local_mode" });        // a package must never overwrite a cloud event
    if (req.user!.globalRole !== "super_admin") return reply.code(403).send({ error: "forbidden" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(415).send({ error: "package_required" });
    try { return reply.code(201).send(await importPackage(pool, body, req.user!.id, req.ip)); }
    catch (e: any) { if (e instanceof PackageError) return reply.code(e.status).send({ error: e.code, ...e.extra }); throw e; }
  });

  const staff = (u: NonNullable<FastifyRequest["user"]>) => u.globalRole === "super_admin" || Object.values(u.eventRoles).some((r) => r === "event_manager" || r === "print_operator");

  app.get("/api/v1/sync/status", { preHandler: requireUser(pool) }, async (req) => {
    if (app.rspMode !== "local") return { mode: "cloud", configured: false, cloudUrl: null, running: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null, cloudReachable: null, events: [], pendingTotal: 0 };
    const st = await getSyncStatus(pool, app.rspSync);
    // operators only see their own events' numbers
    const visible = req.user!.globalRole === "super_admin" ? st.events : st.events.filter((e) => req.user!.eventRoles[e.eventId]);
    return { ...st, events: visible, pendingTotal: visible.reduce((n, e) => n + e.pending, 0) };
  });

  app.post("/api/v1/sync/run", { preHandler: requireUser(pool) }, async (req, reply) => {
    if (app.rspMode !== "local") return reply.code(409).send({ error: "not_local_mode" });
    if (!staff(req.user!)) return reply.code(403).send({ error: "forbidden" });
    if (!app.rspSync?.cloudUrl || !app.rspSync.tokens.length) return reply.code(409).send({ error: "sync_not_configured" });
    return runSyncCycle(pool, { ...app.rspSync, storageDir: app.rspStorageDir ?? undefined });
  });
}
