import PDFDocument from "pdfkit";
import { TOTAL_LABELS, type DailyReport, type FramesReport, type OperatorsReport, type PrintersReport, type SummaryReport } from "@rsp/shared";

/**
 * The event report as a PDF: summary, guest funnel, daily activity chart and the frame, printer and operator tables.
 * PDF's built-in fonts only cover Western European characters, so other scripts print as "?" here (the CSV exports keep them exactly).
 */
const INK = "#1a1a1a", MUTED = "#666666", LINE = "#d9d6cf", BRAND = "#b8862b", BAR = "#2a6f97", BAR2 = "#e09f3e";
const clean = (s: unknown) => String(s ?? "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
const fmtDate = (iso: string) => iso.slice(0, 10);

interface Col { label: string; width: number; align?: "left" | "right" }

export interface EventReportData { eventName: string; hashtag: string | null; summary: SummaryReport; daily: DailyReport; frames: FramesReport; operators: OperatorsReport; printers: PrintersReport }

export function eventReportPdf(d: EventReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: `Event report: ${clean(d.eventName)}`, Author: "Retreat Social Print", Subject: "Event analytics report" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);

    const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right, bottom = () => doc.page.height - doc.page.margins.bottom - 20;
    const need = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
    const h2 = (t: string) => { need(60); doc.moveDown(0.8); doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(clean(t), left, doc.y); doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor(BRAND).lineWidth(1.2).stroke(); doc.moveDown(0.6); };
    const note = (t: string) => { doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED).text(clean(t), left, doc.y, { width }); doc.moveDown(0.3); };

    function table(cols: Col[], rows: (string | number)[][]) {
      const rowH = 15;
      const head = () => {
        need(rowH * 2); let x = left; const y = doc.y;
        doc.rect(left, y - 2, width, rowH).fill("#f1ede4");
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(INK);
        for (const c of cols) { doc.text(clean(c.label), x + 2, y + 1, { width: c.width - 4, align: c.align ?? "left", lineBreak: false, ellipsis: true }); x += c.width; }
        doc.y = y + rowH;
      };
      head();
      if (!rows.length) { doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED).text("No data in this period.", left + 2, doc.y + 2); doc.moveDown(1); return; }
      rows.forEach((r, i) => {
        if (doc.y + rowH > bottom()) { doc.addPage(); head(); }
        const y = doc.y; let x = left;
        if (i % 2) doc.rect(left, y - 2, width, rowH).fill("#faf8f3");
        doc.font("Helvetica").fontSize(8).fillColor(INK);
        cols.forEach((c, k) => { doc.text(clean(r[k]), x + 2, y + 1, { width: c.width - 4, align: c.align ?? "left", lineBreak: false, ellipsis: true }); x += c.width; });
        doc.y = y + rowH;
      });
      doc.moveDown(0.5);
    }

    // ----- Title -----
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND).text("RETREAT SOCIAL PRINT", left, 40, { characterSpacing: 1.2 });
    doc.font("Helvetica-Bold").fontSize(22).fillColor(INK).text(clean(d.eventName), left, doc.y + 4, { width });
    const r = d.summary.range;
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`Event report  |  ${r.from ?? "start"} to ${r.to ?? "today"}  |  time zone ${r.tz}${d.hashtag ? `  |  #${clean(d.hashtag)}` : ""}`, left, doc.y + 2, { width });
    doc.text(`Generated ${d.summary.generatedAt.replace("T", " ").slice(0, 16)} UTC`, left, doc.y);

    // ----- Summary numbers -----
    h2("Summary");
    const t = d.summary.totals; const half = width / 2;
    const startY = doc.y; let col = 0, y = startY;
    for (const [key, label] of TOTAL_LABELS) {
      const x = left + col * half;
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(clean(label), x, y, { width: half - 70, lineBreak: false, ellipsis: true });
      doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(String(t[key]), x + half - 70, y, { width: 60, align: "right", lineBreak: false });
      if (col === 1) { col = 0; y += 15; } else col = 1;
    }
    doc.y = col === 1 ? y + 15 : y;
    note("Share attempts are taps on a share button; the platform cannot see whether a post was published. Photo wall appearances are all-time. Counts of QR scans include any visit to the QR link.");

    // ----- Funnel -----
    h2("Guest journey");
    for (const s of d.summary.funnel) {
      need(20); const yy = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(INK).text(clean(s.label), left, yy + 2, { width: 120, lineBreak: false });
      doc.rect(left + 125, yy, width - 215, 12).fill("#eee9de");
      if (s.pct > 0) doc.rect(left + 125, yy, Math.max(2, ((width - 215) * s.pct) / 100), 12).fill(BAR);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(`${s.count}  (${s.pct}%)`, left + width - 85, yy + 2, { width: 85, align: "right", lineBreak: false });
      doc.y = yy + 18;
    }
    note("Follows the guests who started in this period and how far they got.");

    // ----- Daily chart -----
    h2("Daily activity");
    const rows = d.daily.rows;
    if (rows.length) {
      need(150); const cx = left + 28, cy = doc.y + 6, cw = width - 28, ch = 110;
      const max = Math.max(1, ...rows.map((x) => Math.max(x.completed, x.printed)));
      doc.strokeColor(LINE).lineWidth(0.5).moveTo(cx, cy).lineTo(cx, cy + ch).lineTo(cx + cw, cy + ch).stroke();
      doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(String(max), left, cy - 3, { width: 24, align: "right", lineBreak: false }).text("0", left, cy + ch - 6, { width: 24, align: "right", lineBreak: false });
      const slot = cw / rows.length, bw = Math.max(0.8, Math.min(14, slot * 0.38));
      rows.forEach((x, i) => {
        const bx = cx + i * slot + slot / 2;
        doc.rect(bx - bw, cy + ch - (x.completed / max) * ch, bw, (x.completed / max) * ch).fill(BAR);
        doc.rect(bx, cy + ch - (x.printed / max) * ch, bw, (x.printed / max) * ch).fill(BAR2);
      });
      doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(rows[0].day, cx, cy + ch + 3, { lineBreak: false }).text(rows[rows.length - 1].day, cx + cw - 60, cy + ch + 3, { width: 60, align: "right", lineBreak: false });
      doc.rect(cx + cw / 2 - 70, cy + ch + 14, 8, 8).fill(BAR).font("Helvetica").fontSize(8).fillColor(INK).text("Completed pictures", cx + cw / 2 - 58, cy + ch + 14, { lineBreak: false });
      doc.rect(cx + cw / 2 + 40, cy + ch + 14, 8, 8).fill(BAR2).font("Helvetica").fontSize(8).fillColor(INK).text("Prints completed", cx + cw / 2 + 52, cy + ch + 14, { lineBreak: false });
      doc.y = cy + ch + 30;
      table([{ label: "Day", width: 62 }, { label: "Scans", width: 40, align: "right" }, { label: "Guests", width: 42, align: "right" }, { label: "Photos", width: 42, align: "right" }, { label: "Frames", width: 42, align: "right" },
        { label: "Done", width: 40, align: "right" }, { label: "Shares", width: 42, align: "right" }, { label: "Downloads", width: 52, align: "right" }, { label: "Jobs", width: 36, align: "right" }, { label: "Printed", width: 44, align: "right" }, { label: "Failed", width: 40, align: "right" }, { label: "Reprints", width: 33, align: "right" }],
        rows.map((x) => [x.day, x.scans, x.sessions, x.uploads, x.frameSelections, x.completed, x.shareAttempts, x.downloads, x.printJobs, x.printed, x.failedAttempts, x.reprints]));
    } else table([{ label: "Day", width: 100 }], []);

    // ----- Frames -----
    h2("Frame popularity");
    table([{ label: "Frame", width: 140 }, { label: "Paper", width: 40 }, { label: "Chosen", width: 48, align: "right" }, { label: "Completed", width: 56, align: "right" }, { label: "% of all", width: 44, align: "right" },
      { label: "Printed", width: 44, align: "right" }, { label: "Shares", width: 44, align: "right" }, { label: "Downloads", width: 52, align: "right" }, { label: "Shared %", width: 47, align: "right" }],
      d.frames.rows.map((f) => [f.name + (f.sponsor ? ` (${f.sponsor})` : "") + (f.active ? "" : " [off]"), f.format, f.selections, f.completed, `${f.completedPct}%`, f.printed, f.shareAttempts, f.downloads, `${f.sharedOrDownloadedPct}%`]));

    // ----- Printers -----
    h2("Printers");
    table([{ label: "Printer", width: 150 }, { label: "Computer", width: 100 }, { label: "Paper", width: 34 }, { label: "Printed", width: 44, align: "right" }, { label: "Copies", width: 40, align: "right" }, { label: "Failed", width: 38, align: "right" }, { label: "Success", width: 40, align: "right" }, { label: "Avg s", width: 39, align: "right" }],
      d.printers.rows.map((p) => [p.name, p.computer ?? "", p.paper ?? "", p.printed, p.copiesPrinted, p.failed, p.successPct === null ? "" : `${p.successPct}%`, p.avgSeconds ?? ""]));
    note("Jobs are counted when they finish. A job that failed and was printed on a retry counts as printed.");

    // ----- Operators -----
    h2("Operators");
    table([{ label: "Operator", width: 120 }, { label: "Approved", width: 46, align: "right" }, { label: "Rejected", width: 46, align: "right" }, { label: "Hidden", width: 38, align: "right" }, { label: "Deleted", width: 40, align: "right" }, { label: "Print OK", width: 44, align: "right" },
      { label: "Held", width: 32, align: "right" }, { label: "Cancel", width: 38, align: "right" }, { label: "Retried", width: 40, align: "right" }, { label: "Reprints", width: 40, align: "right" }, { label: "Total", width: 31, align: "right" }],
      d.operators.rows.map((o) => [o.name, o.approved, o.rejected, o.hidden, o.deleted, o.printApproved, o.held, o.cancelled, o.retried, o.reprintsRequested, o.total]));
    note(d.operators.note);

    // ----- Page numbers -----
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const m = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(`${clean(d.eventName)}  |  Page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width, align: "center", lineBreak: false });
      doc.page.margins.bottom = m;
    }
    doc.end();
  });
}
void fmtDate;
