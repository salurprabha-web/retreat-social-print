import { createHash } from "node:crypto";
import { z } from "zod";
import { PACKAGE_DIRS, PACKAGE_TABLES, type Row } from "@rsp/shared";
import type { Pool, Tx } from "./db";
import { withTx } from "./db";
import { audit } from "./audit";
import { getFile, listFiles, writeStable } from "./storage";

/**
 * Event package: everything a local event server needs to run an event (settings, published guest page, frames, sponsors, QR codes,
 * wall and mosaic settings, and the asset files they use). Never guest data, users, printers or secrets other than the event's own
 * public links. Identifiers are kept, so QR codes, links and later synchronisation line up with the cloud.
 *
 * File layout: "RSPK1\n" + 4-byte manifest length + manifest JSON + the files' bytes one after another, in manifest order.
 */
const MAGIC = Buffer.from("RSPK1\n");
const FILE_DIRS = [...PACKAGE_DIRS, "mosaic"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;

const manifestSchema = z.object({
  version: z.literal(1), exportedAt: z.string(), eventId: z.string().regex(UUID), schema: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  files: z.array(z.object({ key: z.string().max(300), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(2000),
});
export type Manifest = z.infer<typeof manifestSchema>;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const fileKeyOk = (eventId: string, key: string) => new RegExp(`^events/${eventId}/(${FILE_DIRS.join("|")})/[A-Za-z0-9._-]{1,120}$`).test(key) && !key.includes("..");

export async function latestSchema(pool: Pool | Tx): Promise<string> {
  return (await pool.query("SELECT max(name) AS n FROM schema_migrations")).rows[0].n as string;
}

export async function buildPackage(pool: Pool, eventId: string): Promise<{ buffer: Buffer; manifest: Manifest } | null> {
  const one = async (sql: string) => (await pool.query(sql, [eventId])).rows.map((r) => r.j as Row);
  const ev = await one("SELECT to_jsonb(t) j FROM events t WHERE id=$1");
  if (!ev.length) return null;
  const tables: Record<string, Row[]> = {
    events: ev,
    event_settings: await one("SELECT to_jsonb(t) j FROM event_settings t WHERE event_id=$1"),
    guest_experience_pages: await one("SELECT to_jsonb(t) j FROM guest_experience_pages t WHERE event_id=$1 AND state='published'"),
    sponsors: await one("SELECT to_jsonb(t) j FROM sponsors t WHERE event_id=$1 ORDER BY position, created_at"),
    frames: await one("SELECT to_jsonb(t) j FROM frames t WHERE event_id=$1 ORDER BY created_at"),
    frame_layers: await one("SELECT to_jsonb(t) j FROM frame_layers t WHERE event_id=$1 ORDER BY frame_id, z_index"),
    qr_tracking: await one("SELECT to_jsonb(t) j FROM qr_tracking t WHERE event_id=$1 ORDER BY created_at"),
    photo_wall_settings: await one("SELECT to_jsonb(t) j FROM photo_wall_settings t WHERE event_id=$1"),
    mosaic_projects: await one("SELECT to_jsonb(t) j FROM mosaic_projects t WHERE event_id=$1"),
  };
  // Nothing in the package points at the cloud's staff accounts, and scan counters start again on the local server.
  for (const rows of Object.values(tables)) for (const r of rows) { if ("created_by" in r) r.created_by = null; }
  for (const r of tables.qr_tracking) r.scans = 0;
  const files: { key: string; size: number; sha256: string; data: Buffer }[] = [];
  for (const dir of FILE_DIRS) {
    for (const name of await listFiles(`events/${eventId}/${dir}`)) {
      const key = `events/${eventId}/${dir}/${name}`;
      if (!fileKeyOk(eventId, key)) continue;
      const data = await getFile(key);
      files.push({ key, size: data.length, sha256: sha(data), data });
    }
  }
  const manifest: Manifest = { version: 1, exportedAt: new Date().toISOString(), eventId, schema: await latestSchema(pool), tables, files: files.map(({ key, size, sha256 }) => ({ key, size, sha256 })) };
  const mj = Buffer.from(JSON.stringify(manifest), "utf8");
  const len = Buffer.alloc(4); len.writeUInt32BE(mj.length);
  return { buffer: Buffer.concat([MAGIC, len, mj, ...files.map((f) => f.data)]), manifest };
}

export class PackageError extends Error { constructor(public code: string, public status = 400, public extra: Record<string, unknown> = {}) { super(code); } }

/** Reads and fully checks a package (format, sizes, every checksum, every file name) without touching anything. */
export function readPackage(buf: Buffer): { manifest: Manifest; files: Map<string, Buffer> } {
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new PackageError("not_a_package");
  const mlen = buf.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (mlen === 0 || start + mlen > buf.length) throw new PackageError("package_damaged");
  let manifest: Manifest;
  try { manifest = manifestSchema.parse(JSON.parse(buf.subarray(start, start + mlen).toString("utf8"))); } catch { throw new PackageError("package_damaged"); }
  let at = start + mlen; const files = new Map<string, Buffer>();
  for (const f of manifest.files) {
    if (!fileKeyOk(manifest.eventId, f.key)) throw new PackageError("bad_file_name", 422, { key: f.key });
    if (files.has(f.key)) throw new PackageError("package_damaged");
    if (at + f.size > buf.length) throw new PackageError("package_damaged");
    const data = buf.subarray(at, at + f.size); at += f.size;
    if (sha(data) !== f.sha256) throw new PackageError("checksum_mismatch", 422, { key: f.key });
    files.set(f.key, data);
  }
  if (at !== buf.length) throw new PackageError("package_damaged");           // nothing may hide after the declared files
  for (const t of Object.keys(manifest.tables)) if (!(PACKAGE_TABLES as readonly string[]).includes(t)) throw new PackageError("unknown_table", 422, { table: t });
  for (const [t, rows] of Object.entries(manifest.tables)) for (const r of rows) {
    if (t === "events" ? r.id !== manifest.eventId : r.event_id !== manifest.eventId) throw new PackageError("wrong_event_in_package", 422, { table: t });
  }
  return { manifest, files };
}

const colCache = new Map<string, string[]>();
async function columns(db: Tx, table: string): Promise<string[]> {
  const hit = colCache.get(table); if (hit) return hit;
  const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position", [table])).rows.map((r) => r.column_name as string);
  colCache.set(table, cols); return cols;
}
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function upsert(tx: Tx, table: string, rows: Row[], conflict: string[], keep: string[] = []) {
  if (!rows.length) return;
  const cols = await columns(tx, table);
  const update = cols.filter((c) => !conflict.includes(c) && !keep.includes(c));
  await tx.query(
    `INSERT INTO ${q(table)} (${cols.map(q).join(",")}) SELECT ${cols.map(q).join(",")} FROM jsonb_populate_recordset(NULL::${q(table)}, $1::jsonb)
       ON CONFLICT (${conflict.map(q).join(",")}) ${update.length ? `DO UPDATE SET ${update.map((c) => `${q(c)}=EXCLUDED.${q(c)}`).join(",")}` : "DO NOTHING"}`, [JSON.stringify(rows)]);
}
async function insertAll(tx: Tx, table: string, rows: Row[]) {
  if (!rows.length) return;
  const cols = await columns(tx, table);
  await tx.query(`INSERT INTO ${q(table)} (${cols.map(q).join(",")}) SELECT ${cols.map(q).join(",")} FROM jsonb_populate_recordset(NULL::${q(table)}, $1::jsonb)`, [JSON.stringify(rows)]);
}

/** Installs or refreshes an event on this (local) server. Guest data already here is never touched. */
export async function importPackage(pool: Pool, buf: Buffer, userId: string | null, ip?: string) {
  const { manifest: m, files } = readPackage(buf);
  const mine = await latestSchema(pool);
  if (m.schema !== mine) throw new PackageError("version_mismatch", 409, { package: m.schema, server: mine });
  const t = m.tables; const eventId = m.eventId;
  for (const [key, data] of files) await writeStable(key, data);              // files first: harmless if the database step fails

  await withTx(pool, async (tx) => {
    for (const rows of Object.values(t)) for (const r of rows) if ("created_by" in r) r.created_by = null;
    const before = (await tx.query("SELECT master_storage_key,cols,rows FROM mosaic_projects WHERE event_id=$1", [eventId])).rows[0];
    try { await upsert(tx, "events", t.events ?? [], ["id"]); }
    catch (e: any) { if (e.code === "23505") throw new PackageError("event_name_or_link_in_use", 409); throw e; }
    await upsert(tx, "event_settings", t.event_settings ?? [], ["event_id"], ["print_paused"]);   // a local operator's pause survives a refresh
    await tx.query("DELETE FROM guest_experience_pages WHERE event_id=$1", [eventId]);
    await insertAll(tx, "guest_experience_pages", t.guest_experience_pages ?? []);
    await upsert(tx, "sponsors", t.sponsors ?? [], ["id"]);
    await upsert(tx, "frames", t.frames ?? [], ["id"]);
    const frameIds = (t.frames ?? []).map((f) => f.id as string);
    await tx.query("DELETE FROM frame_layers WHERE event_id=$1 AND frame_id = ANY($2::uuid[])", [eventId, frameIds]);
    await insertAll(tx, "frame_layers", t.frame_layers ?? []);
    await upsert(tx, "qr_tracking", t.qr_tracking ?? [], ["id"], ["scans"]);                       // scans counted here stay
    await upsert(tx, "photo_wall_settings", t.photo_wall_settings ?? [], ["event_id"]);
    await upsert(tx, "mosaic_projects", t.mosaic_projects ?? [], ["event_id"], ["id"]);
    const after = (await tx.query("SELECT master_storage_key,cols,rows FROM mosaic_projects WHERE event_id=$1", [eventId])).rows[0];
    if (before && after && (before.master_storage_key !== after.master_storage_key || before.cols !== after.cols || before.rows !== after.rows)) {
      await tx.query("DELETE FROM mosaic_tiles WHERE event_id=$1", [eventId]);                     // a different master or grid places pictures again
    }
    await audit(tx, userId, "offline_package_import", { eventId, entity: "event", entityId: eventId, detail: { files: files.size, exportedAt: m.exportedAt }, ip });
  });
  const name = (t.events?.[0]?.name as string) ?? "";
  return { eventId, name, exportedAt: m.exportedAt, files: files.size, tables: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length])) };
}
