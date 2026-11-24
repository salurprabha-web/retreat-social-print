import { describe, it, expect } from "vitest";
import { ACTION_FROM, PRINT_STATUSES, REPRINTABLE, TERMINAL, TRANSITIONS, canTransition, initialStatus } from "../src";

describe("print state machine", () => {
  it("only knows real statuses, and terminal ones go nowhere", () => {
    for (const s of PRINT_STATUSES) for (const t of TRANSITIONS[s]) expect(PRINT_STATUSES).toContain(t);
    for (const s of TERMINAL) expect(TRANSITIONS[s]).toEqual([]);
  });
  it("cannot skip approval or un-print", () => {
    expect(canTransition("pending", "printing")).toBe(false);
    expect(canTransition("pending", "printed")).toBe(false);
    expect(canTransition("printed", "approved")).toBe(false);
    expect(canTransition("cancelled", "approved")).toBe(false);
    expect(canTransition("printing", "cancelled")).toBe(false);
  });
  it("allows the intended paths", () => {
    expect(canTransition("pending", "approved")).toBe(true);
    expect(canTransition("approved", "printing")).toBe(true);
    expect(canTransition("printing", "printed")).toBe(true);
    expect(canTransition("printing", "failed")).toBe(true);
    expect(canTransition("failed", "approved")).toBe(true);        // retry
    expect(canTransition("printing", "approved")).toBe(true);      // agent lost: back in the queue
  });
  it("modes start jobs differently", () => {
    expect(initialStatus("auto")).toBe("approved"); expect(initialStatus("manual")).toBe("pending"); expect(initialStatus("batch")).toBe("pending");
  });
  it("every operator action targets a legal transition; reprints need a finished job", () => {
    const to = { approve: "approved", reject: "cancelled", cancel: "cancelled", hold: "pending", retry: "approved" } as const;
    for (const [a, froms] of Object.entries(ACTION_FROM)) for (const f of froms) expect(canTransition(f, to[a as keyof typeof to]), `${a} from ${f}`).toBe(true);
    expect(REPRINTABLE).toEqual(["printed", "failed", "cancelled"]);
  });
});
