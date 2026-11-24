/** Print job life cycle. The API enforces these transitions; the operator UI only offers what is allowed. */
export const PRINT_STATUSES = ["received", "pending", "reprint_requested", "approved", "printing", "printed", "failed", "cancelled"] as const;
export type PrintStatus = (typeof PRINT_STATUSES)[number];
export const PRINT_MODES = ["auto", "manual", "batch"] as const;
export type PrintMode = (typeof PRINT_MODES)[number];

export const TRANSITIONS: Record<PrintStatus, readonly PrintStatus[]> = {
  received: ["pending", "approved", "cancelled"],
  pending: ["approved", "cancelled"],
  reprint_requested: ["approved", "cancelled"],
  approved: ["printing", "pending", "failed", "cancelled"],   // pending again = "hold"
  printing: ["printed", "failed", "approved"],                // approved again = the agent vanished, put it back in the queue
  failed: ["approved", "cancelled"],                          // approved again = retry
  printed: [],
  cancelled: [],
};
export const TERMINAL: readonly PrintStatus[] = ["printed", "cancelled"];
export const canTransition = (from: PrintStatus, to: PrintStatus) => TRANSITIONS[from].includes(to);
export const isActive = (s: PrintStatus) => !TERMINAL.includes(s) && s !== "failed";   // would still print by itself or waits for a decision

export const STATUS_LABEL: Record<PrintStatus, string> = {
  received: "Received", pending: "Needs approval", reprint_requested: "Reprint requested", approved: "Approved, waiting for printer",
  printing: "Printing", printed: "Printed", failed: "Failed", cancelled: "Cancelled",
};
export const MODE_LABEL: Record<PrintMode, string> = { auto: "Automatic", manual: "Manual approval", batch: "Batch" };

/** What a newly finished picture becomes in each print mode. */
export const initialStatus = (mode: PrintMode): PrintStatus => (mode === "auto" ? "approved" : "pending");

/** Operator actions on a single job, and the status each one needs. */
export const JOB_ACTIONS = ["approve", "reject", "cancel", "hold", "retry", "reprint"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];
export const ACTION_FROM: Record<Exclude<JobAction, "reprint">, readonly PrintStatus[]> = {
  approve: ["pending", "reprint_requested", "received"],
  reject: ["pending", "reprint_requested", "received", "approved", "failed"],
  cancel: ["pending", "reprint_requested", "received", "approved", "failed"],
  hold: ["approved"],
  retry: ["failed"],
};
export const REPRINTABLE: readonly PrintStatus[] = ["printed", "failed", "cancelled"];
export const MAX_COPIES = 50;
