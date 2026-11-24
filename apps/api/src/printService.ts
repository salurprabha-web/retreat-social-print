import { EventEmitter } from "node:events";
import { notifyWall } from "./wallBus";
import { MAX_COPIES, REPRINTABLE, canTransition, initialStatus, type PrintMode, type PrintStatus } from "@rsp/shared";
import type { Pool, Tx } from "./db";
import { withTx } from "./db";

/** Tells open operator screens something changed. In-process: with several API instances this becomes Postgres LISTEN/NOTIFY. */
export const printBus = new EventEmitter();
printBus.setMaxListeners(0);
export const notifyPrint = (eventId: string) => printBus.emit(eventId);

export class PrintError extends Error {
  constructor(public code: string, public statusCode = 409, public extra: Record<string, unknown> = {}) { super(code); }
}

interface JobRow { id: string; status: PrintStatus; composition_id: string; copies: number }

/** The only place a job's status changes. Locks the row, checks the move is legal, stamps times, writes the history. */
export async function transition(tx: Tx, eventId: string, jobId: string, to: PrintStatus, o: {
  userId?: string | null; note?: string | null; expectFrom?: readonly PrintStatus[]; error?: string | null; printerId?: string | null;
} = {}): Promise<{ from: PrintStatus; job: JobRow }> {
  const j = (await tx.query("SELECT id,status,composition_id,copies FROM print_jobs WHERE id=$1 AND event_id=$2 FOR UPDATE", [jobId, eventId])).rows[0] as JobRow | undefined;
  if (!j) throw new PrintError("not_found", 404);
  if (o.expectFrom && !o.expectFrom.includes(j.status)) throw new PrintError("invalid_state", 409, { status: j.status });
  if (!canTransition(j.status, to)) throw new PrintError("invalid_transition", 409, { from: j.status, to });
  const sets = ["status=$3", "updated_at=now()"]; const v: unknown[] = [jobId, eventId, to];
  const add = (col: string, val: unknown) => { v.push(val); sets.push(`${col}=$${v.length}`); };
  if (to === "approved") { sets.push("approved_at=now()"); if (j.status === "failed" || j.status === "printing") sets.push("error=NULL"); }
  if (to === "printing") { sets.push("started_at=now()", "attempt=attempt+1"); }
  if (to === "printed" || to === "failed") sets.push("finished_at=now()");
  if (to === "failed") add("error", (o.error ?? "Print failed").slice(0, 500));
  if (to === "printed") sets.push("error=NULL");
  if (o.printerId !== undefined) add("printer_id", o.printerId);
  await tx.query(`UPDATE print_jobs SET ${sets.join(",")} WHERE id=$1 AND event_id=$2`, v);
  await tx.query("INSERT INTO print_job_events(event_id,job_id,from_status,to_status,user_id,note) VALUES ($1,$2,$3,$4,$5,$6)", [eventId, jobId, j.status, to, o.userId ?? null, o.note ?? o.error ?? null]);
  return { from: j.status, job: j };
}

async function insertJob(tx: Tx, eventId: string, compositionId: string, status: PrintStatus, o: { kind: "print" | "reprint"; key: string; copies: number; userId?: string | null; note?: string | null }) {
  const r = (await tx.query(
    `INSERT INTO print_jobs(event_id,composition_id,status,copies,idempotency_key,kind,requested_by,note,approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $3='approved' THEN now() END)
     ON CONFLICT (event_id, idempotency_key) DO NOTHING RETURNING id`, [eventId, compositionId, status, o.copies, o.key, o.kind, o.userId ?? null, o.note ?? null])).rows[0];
  if (!r) return null;
  await tx.query("INSERT INTO print_job_events(event_id,job_id,from_status,to_status,user_id,note) VALUES ($1,$2,NULL,$3,$4,$5)", [eventId, r.id, status, o.userId ?? null, o.note ?? (o.kind === "reprint" ? "Reprint" : null)]);
  return r.id as string;
}

/**
 * The guest finished. Creates the print job once (safe to call again). Mode decides how it starts:
 * automatic = approved straight away (and the picture counts as approved), manual/batch = waits for an operator.
 */
export async function finalizeComposition(pool: Pool, eventId: string, sessionId: string, compositionId: string) {
  const out = await withTx(pool, async (tx) => {
    const c = (await tx.query("SELECT id,moderation,finalized_at FROM final_compositions WHERE id=$1 AND event_id=$2 AND session_id=$3 AND deleted_at IS NULL FOR UPDATE", [compositionId, eventId, sessionId])).rows[0];
    if (!c) throw new PrintError("not_found", 404);
    const existing = (await tx.query("SELECT id,status FROM print_jobs WHERE event_id=$1 AND idempotency_key=$2", [eventId, `final:${compositionId}`])).rows[0];
    if (c.finalized_at) return { job: existing ?? null, created: false };
    await tx.query("UPDATE final_compositions SET finalized_at=now() WHERE id=$1", [compositionId]);
    if (c.moderation === "rejected") return { job: null, created: false };      // staff already rejected it: never print
    const s = (await tx.query("SELECT print_mode,default_copies FROM event_settings WHERE event_id=$1", [eventId])).rows[0];
    const mode = (s?.print_mode ?? "manual") as PrintMode;
    if (mode === "auto" && c.moderation === "pending")
      await tx.query("UPDATE final_compositions SET moderation='approved', moderated_at=now(), moderation_note='Automatic printing mode' WHERE id=$1", [compositionId]);
    const id = await insertJob(tx, eventId, compositionId, initialStatus(mode), { kind: "print", key: `final:${compositionId}`, copies: s?.default_copies ?? 1 });
    return { job: id ? { id, status: initialStatus(mode) } : existing, created: !!id };
  });
  notifyPrint(eventId);
  notifyWall(eventId);                                  // a finished picture may now be eligible for the wall
  return out;
}

export type StaffAction = "approve" | "reject" | "cancel" | "hold" | "retry";

/** One operator action on one job. Approving a picture for printing also approves the picture; rejecting also rejects it. */
export async function applyAction(pool: Pool, eventId: string, jobId: string, action: StaffAction, userId: string, note?: string) {
  await withTx(pool, async (tx) => {
    const to = ({ approve: "approved", reject: "cancelled", cancel: "cancelled", hold: "pending", retry: "approved" } as const)[action];
    const from = ({ approve: ["pending", "reprint_requested", "received"], reject: ["pending", "reprint_requested", "received", "approved", "failed"], cancel: ["pending", "reprint_requested", "received", "approved", "failed"], hold: ["approved"], retry: ["failed"] } as const)[action];
    const { job } = await transition(tx, eventId, jobId, to, { userId, note: note ?? null, expectFrom: from });
    if (action === "approve") await tx.query("UPDATE final_compositions SET moderation='approved', moderated_by=$3, moderated_at=now() WHERE id=$1 AND event_id=$2 AND moderation='pending'", [job.composition_id, eventId, userId]);
    if (action === "reject") await tx.query("UPDATE final_compositions SET moderation='rejected', moderated_by=$3, moderated_at=now(), moderation_note=$4 WHERE id=$1 AND event_id=$2", [job.composition_id, eventId, userId, note ?? null]);
  });
  notifyPrint(eventId);
  notifyWall(eventId);                                  // approve/reject changes what the wall may show
}

export async function setCopies(pool: Pool, eventId: string, jobId: string, copies: number, userId: string) {
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new PrintError("bad_copies", 400);
  await withTx(pool, async (tx) => {
    const j = (await tx.query("SELECT status,copies FROM print_jobs WHERE id=$1 AND event_id=$2 FOR UPDATE", [jobId, eventId])).rows[0];
    if (!j) throw new PrintError("not_found", 404);
    if (!["received", "pending", "reprint_requested", "approved"].includes(j.status)) throw new PrintError("invalid_state", 409, { status: j.status });
    await tx.query("UPDATE print_jobs SET copies=$3, updated_at=now() WHERE id=$1 AND event_id=$2", [jobId, eventId, copies]);
    await tx.query("INSERT INTO print_job_events(event_id,job_id,from_status,to_status,user_id,note) VALUES ($1,$2,$3,$3,$4,$5)", [eventId, jobId, j.status, userId, `Copies ${j.copies} → ${copies}`]);
  });
  notifyPrint(eventId);
  notifyWall(eventId);                                  // approve/reject changes what the wall may show
}

/**
 * Print again. Needs a finished job and no other job still running for the same picture (so a double tap cannot print twice).
 * `requestId` (generated by the screen per tap) makes a repeated request return the same job. `approveNow=false` queues it as a request.
 */
export async function reprint(pool: Pool, eventId: string, compositionId: string, userId: string, o: { requestId: string; copies?: number; approveNow: boolean }) {
  const res = await withTx(pool, async (tx) => {
    const c = (await tx.query("SELECT id,moderation FROM final_compositions WHERE id=$1 AND event_id=$2 AND deleted_at IS NULL FOR UPDATE", [compositionId, eventId])).rows[0];
    if (!c) throw new PrintError("not_found", 404);
    const key = `reprint:${compositionId}:${o.requestId}`;
    const dup = (await tx.query("SELECT id,status FROM print_jobs WHERE event_id=$1 AND idempotency_key=$2", [eventId, key])).rows[0];
    if (dup) return { job: dup, created: false };
    const jobs = (await tx.query("SELECT status FROM print_jobs WHERE composition_id=$1 AND event_id=$2", [compositionId, eventId])).rows.map((r) => r.status as PrintStatus);
    if (!jobs.length) throw new PrintError("nothing_printed_yet", 409);
    if (jobs.some((s) => !REPRINTABLE.includes(s))) throw new PrintError("job_in_progress", 409);
    if (c.moderation === "rejected") throw new PrintError("picture_rejected", 409);
    const s = (await tx.query("SELECT default_copies FROM event_settings WHERE event_id=$1", [eventId])).rows[0];
    const status: PrintStatus = o.approveNow ? "approved" : "reprint_requested";
    const id = await insertJob(tx, eventId, compositionId, status, { kind: "reprint", key, copies: o.copies ?? s?.default_copies ?? 1, userId });
    return { job: { id, status }, created: true };
  });
  notifyPrint(eventId);
  return res;
}

export async function setPaused(pool: Pool, eventId: string, paused: boolean, userId: string) {
  await pool.query("UPDATE event_settings SET print_paused=$2, updated_at=now() WHERE event_id=$1", [eventId, paused]);
  await pool.query("INSERT INTO audit_logs(event_id,user_id,action) VALUES ($1,$2,$3)", [eventId, userId, paused ? "print_pause" : "print_resume"]);
  notifyPrint(eventId);
  notifyWall(eventId);                                  // approve/reject changes what the wall may show
}

/* ---------- Used by the Windows print agent (Phase 11) and by tests that simulate it ---------- */

/** Next approved job, oldest first, unless the queue is paused. SKIP LOCKED: two agents never get the same job. */
export async function claimNext(pool: Pool, eventId: string, printerId: string | null = null, paperSize: string | null = null) {
  const job = await withTx(pool, async (tx) => {
    const paused = (await tx.query("SELECT print_paused FROM event_settings WHERE event_id=$1", [eventId])).rows[0]?.print_paused;
    if (paused) return null;
    // A printer loaded with 2x6 strips only takes jobs made on a 2x6 frame ("any" takes everything).
    const j = (await tx.query(
      `SELECT j.id FROM print_jobs j JOIN final_compositions c ON c.id=j.composition_id AND c.event_id=j.event_id
         JOIN frames f ON f.id=c.frame_id AND f.event_id=c.event_id
        WHERE j.event_id=$1 AND j.status='approved' AND c.deleted_at IS NULL AND c.moderation<>'rejected'
          AND ($2::text IS NULL OR $2='any' OR f.output_format=$2)
        ORDER BY j.approved_at, j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [eventId, paperSize])).rows[0];
    if (!j) return null;
    await transition(tx, eventId, j.id, "printing", { printerId, note: "Sent to printer" });
    return (await tx.query("SELECT id,composition_id,copies,attempt FROM print_jobs WHERE id=$1", [j.id])).rows[0];
  });
  if (job) notifyPrint(eventId);
  return job as { id: string; composition_id: string; copies: number; attempt: number } | null;
}

export async function reportResult(pool: Pool, eventId: string, jobId: string, ok: boolean, error?: string) {
  await withTx(pool, (tx) => transition(tx, eventId, jobId, ok ? "printed" : "failed", { expectFrom: ["printing"], error: ok ? null : error ?? "Print failed", note: ok ? "Printed" : error ?? "Print failed" }));
  notifyPrint(eventId);
  notifyWall(eventId);                                  // approve/reject changes what the wall may show
}

/** Jobs stuck in "printing" (agent crashed or lost connection) go back to the queue instead of hanging forever. */
export async function requeueStale(pool: Pool, eventId: string, olderThanSeconds: number): Promise<number> {
  const stale = (await pool.query("SELECT id FROM print_jobs WHERE event_id=$1 AND status='printing' AND started_at < now() - make_interval(secs => $2)", [eventId, olderThanSeconds])).rows;
  for (const s of stale) await withTx(pool, (tx) => transition(tx, eventId, s.id, "approved", { expectFrom: ["printing"], note: "Printer did not answer: back in the queue" }));
  if (stale.length) notifyPrint(eventId);
  return stale.length;
}

/** A rejected picture must never print: cancel whatever is still waiting or retryable for it. */
export async function cancelJobsForCompositions(pool: Pool, eventId: string, compositionIds: string[], userId: string, note: string) {
  const jobs = (await pool.query(
    "SELECT id FROM print_jobs WHERE event_id=$1 AND composition_id = ANY($2) AND status IN ('received','pending','reprint_requested','approved','failed')", [eventId, compositionIds])).rows;
  for (const j of jobs) {
    try { await withTx(pool, (tx) => transition(tx, eventId, j.id, "cancelled", { userId, note })); } catch (e) { if (!(e instanceof PrintError)) throw e; }
  }
  if (jobs.length) notifyPrint(eventId);
}

/** Every event's stuck jobs go back to the queue (run on a timer by the server). Returns how many were requeued. */
export async function requeueAllStale(pool: Pool, olderThanSeconds: number): Promise<number> {
  const evs = (await pool.query("SELECT DISTINCT event_id FROM print_jobs WHERE status='printing' AND started_at < now() - make_interval(secs => $1)", [olderThanSeconds])).rows;
  let n = 0;
  for (const e of evs) n += await requeueStale(pool, e.event_id, olderThanSeconds);
  return n;
}
