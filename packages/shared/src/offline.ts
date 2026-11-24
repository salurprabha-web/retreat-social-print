import { z } from "zod";

/**
 * Offline (local server) mode. A local event server runs the same software at the venue, is provisioned from the cloud with an
 * event package, and later pushes what happened (guests, photos, pictures, print history) back to the cloud.
 */
export const SYNC_BATCH_ROWS = 300;
export const SYNC_MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface SyncTable {
  name: string;
  pk: readonly string[];
  /** Columns that point at things that only exist on the local server (staff users, local printers, devices): cleared on the cloud. */
  nullCols: readonly string[];
  /** Columns holding a storage key whose file must travel with the row. */
  files: readonly string[];
  /** Immutable rows with a server-assigned number: never re-sent, the cloud gives them its own number (deduplicated by origin). */
  serial?: boolean;
}

/** Parents before children. Deleting goes the other way round. */
export const SYNC_TABLES: readonly SyncTable[] = [
  { name: "guest_sessions", pk: ["id"], nullCols: ["device_id"], files: [] },
  { name: "frame_selections", pk: ["id"], nullCols: [], files: [] },
  { name: "photo_uploads", pk: ["id"], nullCols: [], files: ["storage_key"] },
  { name: "final_compositions", pk: ["id"], nullCols: ["moderated_by"], files: ["storage_key"] },
  { name: "composition_photos", pk: ["composition_id", "slot"], nullCols: [], files: [] },
  { name: "print_jobs", pk: ["id"], nullCols: ["printer_id", "approved_by", "requested_by"], files: [] },
  { name: "print_job_events", pk: ["id"], nullCols: ["user_id"], files: [], serial: true },
  { name: "share_events", pk: ["id"], nullCols: [], files: [] },
  { name: "qr_scan_events", pk: ["id"], nullCols: [], files: [], serial: true },
  { name: "wall_views", pk: ["composition_id"], nullCols: [], files: [] },
];
export const SYNC_TABLE = Object.fromEntries(SYNC_TABLES.map((t) => [t.name, t])) as Record<string, SyncTable>;

/** Configuration tables that travel DOWN in an event package (cloud to local). Guest data never does. */
export const PACKAGE_TABLES = ["events", "event_settings", "guest_experience_pages", "sponsors", "frames", "frame_layers", "qr_tracking", "photo_wall_settings", "mosaic_projects"] as const;
/** Folders (directly inside events/<id>/) whose files are part of the configuration. */
export const PACKAGE_DIRS = ["branding", "builder", "frames", "sponsors"] as const;

export type Row = Record<string, unknown>;

/** JSON with sorted keys, so the same row always gives the same text (and hash) however the database orders its columns. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** The identity of a row within its table, as text ("id" or "composition_id:slot"). */
export const rowKey = (t: SyncTable, row: Row): string => t.pk.map((c) => String(row[c])).join(":");
export function parseRowKey(t: SyncTable, key: string): string[] | null {
  const parts = key.split(":");
  return parts.length === t.pk.length && parts.every((p) => p.length > 0 && /^[0-9a-zA-Z-]+$/.test(p)) ? parts : null;
}

/** Storage keys a sync may write: only the picture folders of the credential's own event, with plain file names. */
export const syncFileKeyOk = (eventId: string, key: string) => new RegExp(`^events/${eventId}/(originals|finals)/[A-Za-z0-9]{1,64}\\.[a-z0-9]{2,5}$`).test(key);

export const syncPushSchema = z.object({
  schema: z.string().min(1).max(100),                       // name of the newest migration: both sides must run the same release
  rows: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(SYNC_BATCH_ROWS)).default({}),
  deletes: z.record(z.string(), z.array(z.string().max(120)).max(SYNC_BATCH_ROWS)).default({}),
});
export type SyncPush = z.infer<typeof syncPushSchema>;

export const syncFilesCheckSchema = z.object({ files: z.array(z.object({ key: z.string().max(300), size: z.number().int().min(0).max(SYNC_MAX_FILE_BYTES) })).min(1).max(500) });

export interface SyncStatus {
  mode: "cloud" | "local";
  configured: boolean;                 // local mode with a cloud address and at least one sync credential
  cloudUrl: string | null;
  running: boolean;
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  cloudReachable: boolean | null;      // null = not tried yet
  events: { eventId: string; pending: number; lastSuccessAt: string | null; error: string | null }[];
  pendingTotal: number;
}
