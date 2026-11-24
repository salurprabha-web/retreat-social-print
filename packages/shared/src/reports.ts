/**
 * Reports and analytics: the shapes every report returns (used by the API, the CSV and PDF exports and the web charts) and the CSV writer.
 * What each number means is defined once, here, so the screen, the CSV and the PDF can never disagree.
 */
export const REPORT_NAMES = ["summary", "daily", "frames", "operators", "printers", "submissions"] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export const MAX_DAILY_DAYS = 366;

export interface ReportRange { from: string | null; to: string | null; tz: string }   // dates are calendar days (YYYY-MM-DD) in `tz`; null = no limit

export interface Totals {
  scans: number;                 // QR code scans (staff or bots opening the link count too)
  sessions: number;              // unique guests who started
  uploads: number;               // photos received (including ones the guest later replaced)
  frameSelections: number;       // times a guest chose a frame and a picture was made from it
  completed: number;             // pictures the guest finished (tapped Finish)
  instagramAttempts: number; whatsappAttempts: number; nativeAttempts: number;
  shareAttempts: number;         // instagram + whatsapp + native: taps only, never a confirmed post
  copies: number;                // caption / hashtag copied
  downloads: number;
  uniqueSharers: number;         // guests who tapped any share or download button
  printJobs: number;             // print jobs created (first prints)
  reprints: number;              // reprint jobs created
  printed: number;               // jobs completed
  copiesPrinted: number;         // paper copies of those jobs
  failedAttempts: number;        // print attempts that failed (a retry that later worked still counts here)
  wallAppearances: number;       // times a picture was shown on the photo wall (all time)
  wallPictures: number;          // different pictures shown on the wall (all time)
}
export interface FunnelStep { key: string; label: string; count: number; pct: number }
export interface SummaryReport { range: ReportRange; totals: Totals; funnel: FunnelStep[]; qr: { code: string; label: string | null; scans: number }[]; generatedAt: string }

export interface DailyRow {
  day: string; scans: number; sessions: number; uploads: number; frameSelections: number; completed: number;
  shareAttempts: number; instagramAttempts: number; downloads: number; printJobs: number; reprints: number; printed: number; failedAttempts: number;
}
export interface DailyReport { range: ReportRange; rows: DailyRow[]; generatedAt: string }

export interface FrameRow { frameId: string; name: string; format: string; active: boolean; sponsor: string | null; selections: number; completed: number; completedPct: number; printed: number; shareAttempts: number; downloads: number; sharedOrDownloadedPct: number }
export interface FramesReport { range: ReportRange; rows: FrameRow[]; generatedAt: string }

export interface OperatorRow {
  userId: string | null; name: string; email: string | null;
  approved: number; rejected: number; hidden: number; deleted: number;              // picture moderation
  printApproved: number; held: number; cancelled: number; retried: number; reprintsRequested: number;   // print queue
  total: number; firstAt: string | null; lastAt: string | null;
}
export interface OperatorsReport { range: ReportRange; rows: OperatorRow[]; note: string; generatedAt: string }

export interface PrinterRow { printerId: string | null; name: string; computer: string | null; paper: string | null; printed: number; copiesPrinted: number; failed: number; successPct: number | null; avgSeconds: number | null; lastSeenAt: string | null }
export interface PrintersReport { range: ReportRange; rows: PrinterRow[]; generatedAt: string }

export interface SubmissionRow { guestCode: string | null; createdAt: string; finalizedAt: string | null; frame: string; moderation: string; printJobs: number; printed: number; shareAttempts: number; downloads: number; wallShown: number }

export interface EventsOverviewRow { eventId: string; name: string; status: string; sessions: number; completed: number; printed: number; failedAttempts: number; shareAttempts: number; downloads: number; scans: number }
export interface ActivityDay { day: string; completed: number; printed: number }

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

export interface CsvColumn<T> { key: keyof T & string; label: string }

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starts with = + - @ or a control character) is neutralised with a
 * leading apostrophe, so a report can never become a vehicle for formula injection. Numbers are written as numbers.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with CRLF line ends and a UTF-8 byte-order mark (so Excel reads non-English names correctly). */
export function toCsv<T extends object>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const head = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell((r as Record<string, unknown>)[c.key])).join(","));
  return `﻿${[head, ...body].join("\r\n")}\r\n`;
}

export const DAILY_COLUMNS: CsvColumn<DailyRow>[] = [
  { key: "day", label: "Day" }, { key: "scans", label: "QR scans" }, { key: "sessions", label: "Guests" }, { key: "uploads", label: "Photos uploaded" },
  { key: "frameSelections", label: "Frame selections" }, { key: "completed", label: "Completed pictures" }, { key: "shareAttempts", label: "Share attempts" },
  { key: "instagramAttempts", label: "Instagram attempts" }, { key: "downloads", label: "Downloads" }, { key: "printJobs", label: "Print jobs" },
  { key: "reprints", label: "Reprints" }, { key: "printed", label: "Printed" }, { key: "failedAttempts", label: "Failed print attempts" },
];
export const FRAME_COLUMNS: CsvColumn<FrameRow>[] = [
  { key: "name", label: "Frame" }, { key: "format", label: "Paper" }, { key: "active", label: "Available to guests" }, { key: "sponsor", label: "Sponsor" },
  { key: "selections", label: "Selections" }, { key: "completed", label: "Completed pictures" }, { key: "completedPct", label: "Share of completed pictures (%)" },
  { key: "printed", label: "Printed" }, { key: "shareAttempts", label: "Share attempts" }, { key: "downloads", label: "Downloads" }, { key: "sharedOrDownloadedPct", label: "Pictures shared or downloaded (%)" },
];
export const OPERATOR_COLUMNS: CsvColumn<OperatorRow>[] = [
  { key: "name", label: "Operator" }, { key: "email", label: "Email" }, { key: "approved", label: "Pictures approved" }, { key: "rejected", label: "Pictures rejected" },
  { key: "hidden", label: "Hidden from wall" }, { key: "deleted", label: "Pictures deleted" }, { key: "printApproved", label: "Approved for print" }, { key: "held", label: "Held" },
  { key: "cancelled", label: "Cancelled" }, { key: "retried", label: "Retried" }, { key: "reprintsRequested", label: "Reprints requested" }, { key: "total", label: "Total actions" },
  { key: "firstAt", label: "First action" }, { key: "lastAt", label: "Last action" },
];
export const PRINTER_COLUMNS: CsvColumn<PrinterRow>[] = [
  { key: "name", label: "Printer" }, { key: "computer", label: "Print computer" }, { key: "paper", label: "Paper" }, { key: "printed", label: "Jobs printed" },
  { key: "copiesPrinted", label: "Copies printed" }, { key: "failed", label: "Jobs failed" }, { key: "successPct", label: "Success (%)" }, { key: "avgSeconds", label: "Average seconds per job" }, { key: "lastSeenAt", label: "Last seen" },
];
export const SUBMISSION_COLUMNS: CsvColumn<SubmissionRow>[] = [
  { key: "guestCode", label: "Guest ID" }, { key: "createdAt", label: "Created" }, { key: "finalizedAt", label: "Finished" }, { key: "frame", label: "Frame" }, { key: "moderation", label: "Moderation" },
  { key: "printJobs", label: "Print jobs" }, { key: "printed", label: "Printed" }, { key: "shareAttempts", label: "Share attempts" }, { key: "downloads", label: "Downloads" }, { key: "wallShown", label: "Wall appearances" },
];
export const SUMMARY_COLUMNS: CsvColumn<{ metric: string; value: number }>[] = [{ key: "metric", label: "Metric" }, { key: "value", label: "Value" }];
export const TOTAL_LABELS: [keyof Totals, string][] = [
  ["scans", "QR scans"], ["sessions", "Guests (unique sessions)"], ["uploads", "Photos uploaded"], ["frameSelections", "Frame selections"], ["completed", "Completed pictures"],
  ["instagramAttempts", "Instagram share attempts"], ["whatsappAttempts", "WhatsApp share attempts"], ["nativeAttempts", "Other share attempts"], ["shareAttempts", "Share attempts (total)"],
  ["copies", "Caption / hashtag copies"], ["downloads", "Downloads"], ["uniqueSharers", "Guests who shared or downloaded"], ["printJobs", "Print jobs"], ["reprints", "Reprints"],
  ["printed", "Prints completed"], ["copiesPrinted", "Paper copies printed"], ["failedAttempts", "Failed print attempts"], ["wallAppearances", "Photo wall appearances"], ["wallPictures", "Pictures shown on the wall"],
];
