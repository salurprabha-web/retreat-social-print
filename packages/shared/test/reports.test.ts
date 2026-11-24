import { describe, it, expect } from "vitest";
import { DAILY_COLUMNS, csvCell, daysBetween, isDay, pct, toCsv, type DailyRow } from "../src";

describe("csv", () => {
  it("quotes what must be quoted and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe("\"a,b\""); expect(csvCell("say \"hi\"")).toBe("\"say \"\"hi\"\"\""); expect(csvCell("two\nlines")).toBe("\"two\nlines\"");
  });
  it("neutralises spreadsheet formulas in text but leaves numbers alone", () => {
    for (const s of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) expect(csvCell(s).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell(-5)).toBe("-5"); expect(csvCell(0)).toBe("0"); expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
  });
  it("handles empty values and booleans", () => {
    expect(csvCell(null)).toBe(""); expect(csvCell(undefined)).toBe(""); expect(csvCell(true)).toBe("yes"); expect(csvCell(NaN)).toBe("");
  });
  it("writes a BOM, a header and CRLF rows", () => {
    const rows: DailyRow[] = [{ day: "2026-01-02", scans: 1, sessions: 2, uploads: 3, frameSelections: 4, completed: 5, shareAttempts: 6, instagramAttempts: 7, downloads: 8, printJobs: 9, reprints: 0, printed: 1, failedAttempts: 2 }];
    const out = toCsv(DAILY_COLUMNS, rows);
    expect(out.startsWith("﻿Day,QR scans,")).toBe(true);
    expect(out.split("\r\n")).toEqual([out.split("\r\n")[0], "2026-01-02,1,2,3,4,5,6,7,8,9,0,1,2", ""]);
  });
});

describe("dates and percentages", () => {
  it("accepts only real calendar days", () => {
    expect(isDay("2026-02-28")).toBe(true); expect(isDay("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "", null, 20260101, "2026-01-01T00:00"]) expect(isDay(bad)).toBe(false);
  });
  it("counts days inclusively", () => {
    expect(daysBetween("2026-01-01", "2026-01-01")).toBe(1); expect(daysBetween("2026-01-01", "2026-01-31")).toBe(31); expect(daysBetween("2026-02-27", "2026-03-02")).toBe(4);
  });
  it("percent is one decimal and safe for zero", () => {
    expect(pct(1, 3)).toBe(33.3); expect(pct(1, 0)).toBe(0); expect(pct(5, 5)).toBe(100);
  });
});
