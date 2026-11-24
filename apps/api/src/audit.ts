import type { Pool, Tx } from "./db";

export function audit(
  db: Pool | Tx, userId: string | null | undefined, action: string,
  o: { eventId?: string | null; entity?: string; entityId?: string; detail?: object; ip?: string } = {},
) {
  return db.query(
    `INSERT INTO audit_logs(event_id,user_id,action,entity,entity_id,detail,ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [o.eventId ?? null, userId ?? null, action, o.entity ?? null, o.entityId ?? null, JSON.stringify(o.detail ?? {}), o.ip ?? null]);
}
