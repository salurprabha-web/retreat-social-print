import { describe, it, expect } from "vitest";
import { SYNC_TABLES, SYNC_TABLE, parseRowKey, rowKey, stableStringify, syncFilesCheckSchema, syncFileKeyOk, syncPushSchema } from "../src";

describe("stable hashing text", () => {
  it("is the same whatever the key order, and different when a value differs", () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: null } })).toBe(stableStringify({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
    expect(stableStringify(null)).toBe("null"); expect(stableStringify("x")).toBe("\"x\"");
  });
});

describe("sync tables", () => {
  it("lists parents before children and every table once", () => {
    const names = SYNC_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const at = (n: string) => names.indexOf(n);
    expect(at("guest_sessions")).toBeLessThan(at("photo_uploads"));
    expect(at("photo_uploads")).toBeLessThan(at("final_compositions"));
    expect(at("final_compositions")).toBeLessThan(at("print_jobs"));
    expect(at("print_jobs")).toBeLessThan(at("print_job_events"));
    expect(at("final_compositions")).toBeLessThan(at("wall_views"));
  });
  it("clears local-only references and marks numbered rows", () => {
    expect(SYNC_TABLE.print_jobs.nullCols).toEqual(expect.arrayContaining(["printer_id", "approved_by", "requested_by"]));
    expect(SYNC_TABLE.final_compositions.nullCols).toContain("moderated_by");
    expect(SYNC_TABLE.print_job_events.serial).toBe(true); expect(SYNC_TABLE.guest_sessions.serial).toBeUndefined();
  });
  it("row keys round-trip, and odd keys are refused", () => {
    const t = SYNC_TABLE.composition_photos;
    expect(rowKey(t, { composition_id: "abc-1", slot: 2 })).toBe("abc-1:2");
    expect(parseRowKey(t, "abc-1:2")).toEqual(["abc-1", "2"]);
    expect(parseRowKey(t, "abc-1")).toBeNull(); expect(parseRowKey(SYNC_TABLE.guest_sessions, "a'; drop table x;--")).toBeNull(); expect(parseRowKey(SYNC_TABLE.guest_sessions, "")).toBeNull();
  });
});

describe("file keys and payloads", () => {
  const ev = "11111111-1111-4111-8111-111111111111";
  it("only the event's own picture folders with plain names are accepted", () => {
    expect(syncFileKeyOk(ev, `events/${ev}/finals/abcdef0123456789.jpg`)).toBe(true);
    expect(syncFileKeyOk(ev, `events/${ev}/originals/abcdef0123456789.png`)).toBe(true);
    for (const bad of [`events/${ev}/finals/../../x.jpg`, `events/22222222-2222-4222-8222-222222222222/finals/a.jpg`, `events/${ev}/branding/a.png`, `events/${ev}/finals/a/b.jpg`, `/etc/passwd`, `events/${ev}/finals/a.jpg/`, `events/${ev}/finals/.jpg`])
      expect(syncFileKeyOk(ev, bad)).toBe(false);
  });
  it("validates pushes and checks", () => {
    expect(syncPushSchema.safeParse({ schema: "012_x.sql", rows: { guest_sessions: [{ id: "a" }] } }).success).toBe(true);
    expect(syncPushSchema.safeParse({ rows: {} }).success).toBe(false);
    expect(syncPushSchema.safeParse({ schema: "x", rows: { t: Array.from({ length: 301 }, () => ({})) } }).success).toBe(false);
    expect(syncFilesCheckSchema.safeParse({ files: [] }).success).toBe(false);
    expect(syncFilesCheckSchema.safeParse({ files: [{ key: "k", size: 1 }] }).success).toBe(true);
  });
});
