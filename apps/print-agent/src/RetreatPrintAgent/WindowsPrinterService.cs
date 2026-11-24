using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Printing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using RetreatPrintAgent.Core;
using Sp = System.Printing;

namespace RetreatPrintAgent;

/// <summary>
/// Prints through the normal Windows printer driver, so DNP, Mitsubishi, Epson, Canon and any other installed printer work the same way.
/// One copy per call: the ledger can then record each copy before it is sent, and a driver that ignores "copies" cannot print too few or too many.
/// </summary>
public sealed class WindowsPrinterService : IPrinterService
{
    private readonly string _virtualOutputDir; private readonly IAgentLog _log;
    private readonly Dictionary<string, (DateTime At, List<(DriverPaper Info, PaperSize Native)> Papers)> _paperCache = new(StringComparer.OrdinalIgnoreCase);

    public WindowsPrinterService(IAgentLog log, string? virtualOutputDir = null)
    {
        _log = log;
        _virtualOutputDir = virtualOutputDir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Retreat Print Agent", "Virtual Prints");
    }

    /// <summary>"Print to PDF/XPS" printers ask for a file name. We give them one, so they never open a dialog nobody is there to answer.</summary>
    public static bool IsVirtual(string printerName) =>
        printerName.Equals("Microsoft Print to PDF", StringComparison.OrdinalIgnoreCase) || printerName.Equals("Microsoft XPS Document Writer", StringComparison.OrdinalIgnoreCase);

    private List<(DriverPaper Info, PaperSize Native)> Papers(PrinterSettings ps)
    {
        if (_paperCache.TryGetValue(ps.PrinterName, out var c) && DateTime.UtcNow - c.At < TimeSpan.FromMinutes(10)) return c.Papers;
        var list = new List<(DriverPaper, PaperSize)>();
        try { foreach (PaperSize p in ps.PaperSizes) list.Add((new DriverPaper(p.PaperName, p.Width, p.Height), p)); }
        catch (Exception e) { _log.Warn($"Could not read paper sizes of '{ps.PrinterName}': {e.Message}"); }
        _paperCache[ps.PrinterName] = (DateTime.UtcNow, list);
        return list;
    }

    public IReadOnlyList<PrinterInfo> List()
    {
        var result = new List<PrinterInfo>();
        foreach (string name in PrinterSettings.InstalledPrinters)
        {
            try
            {
                var ps = new PrinterSettings { PrinterName = name };
                if (!ps.IsValid) { result.Add(new PrinterInfo(name, "offline", "Printer not available", Array.Empty<string>())); continue; }
                var (state, detail) = QueueState(name);
                result.Add(new PrinterInfo(name, state, detail, Papers(ps).Select(p => p.Info.Describe()).ToList()));
            }
            catch (Exception e) { result.Add(new PrinterInfo(name, "unknown", e.Message, Array.Empty<string>())); }
        }
        return result;
    }

    /// <summary>What the Windows print queue says about the printer: offline, paper out, jam, door open and so on.</summary>
    private static (string State, string? Detail) QueueState(string name)
    {
        try
        {
            using var server = new Sp.LocalPrintServer();
            using var q = server.GetPrintQueue(name);
            q.Refresh();
            if (q.IsOffline) return ("offline", "Offline");
            if (q.IsOutOfPaper) return ("error", "Paper out");
            if (q.IsPaperJammed) return ("error", "Paper jam");
            if (q.IsDoorOpened) return ("error", "Door open");
            if (q.IsOutOfMemory) return ("error", "Out of memory");
            if (q.IsNotAvailable) return ("offline", "Not available");
            if (q.IsInError) return ("error", "Printer error");
            if (q.NeedUserIntervention) return ("error", "Needs attention");
            if (q.IsPaused) return ("paused", "Paused in Windows");
            if (q.IsBusy || q.IsPrinting || q.IsProcessing) return ("busy", null);
            return ("ready", null);
        }
        catch { return ("ready", null); }          // network or special queues Windows will not describe: assume ready; a real fault shows up when printing
    }

    public Task<PrintOutcome> PrintOneCopyAsync(PrintRequest r, CancellationToken ct) => Task.Run(() => PrintSync(r, ct), ct);

    private PrintOutcome PrintSync(PrintRequest r, CancellationToken ct)
    {
        try
        {
            var ps = new PrinterSettings { PrinterName = r.PrinterName };
            if (!ps.IsValid) return new PrintOutcome(false, $"Printer '{r.PrinterName}' is not available on this computer.");
            var papers = Papers(ps);
            var match = PaperMatcher.Match(papers.Select(p => p.Info), r.PaperSize);
            if (match is null) return new PrintOutcome(false, PaperMatcher.NoMatchMessage(r.PaperSize, papers.Select(p => p.Info)));
            var native = papers.First(p => p.Info == match).Native;

            bool landscape = r.Orientation == "landscape";
            var (pw, ph) = PaperMatcher.Dimensions(r.PaperSize)!.Value;
            double paperAspect = landscape ? (double)Math.Max(pw, ph) / Math.Min(pw, ph) : (double)Math.Min(pw, ph) / Math.Max(pw, ph);
            double imageAspect = (double)r.WidthPx / r.HeightPx;
            if (Math.Abs(imageAspect - paperAspect) / paperAspect > 0.02)
                return new PrintOutcome(false, $"The picture ({r.WidthPx}x{r.HeightPx} px) does not match {r.PaperSize} paper in {(landscape ? "landscape" : "portrait")}: it would be stretched, so it was not printed. Check the frame size and the printer's paper and orientation in the event.");

            using var img = Image.FromFile(r.ImagePath);
            using var doc = new PrintDocument { DocumentName = r.JobLabel, PrintController = new StandardPrintController(), OriginAtMargins = false };
            doc.PrinterSettings = ps; doc.PrinterSettings.Copies = 1; doc.PrinterSettings.Collate = false;
            doc.DefaultPageSettings.PaperSize = native; doc.DefaultPageSettings.Landscape = landscape; doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
            string? outFile = null;
            if (IsVirtual(r.PrinterName))
            {
                Directory.CreateDirectory(_virtualOutputDir);
                var safe = string.Concat(r.JobLabel.Select(ch => char.IsLetterOrDigit(ch) ? ch : '_'));
                outFile = Path.Combine(_virtualOutputDir, $"{DateTime.Now:yyyyMMdd-HHmmss}-{safe}" + (r.PrinterName.Contains("XPS", StringComparison.OrdinalIgnoreCase) ? ".xps" : ".pdf"));
                doc.PrinterSettings.PrintToFile = true; doc.PrinterSettings.PrintFileName = outFile;
            }
            Exception? drawError = null;
            doc.PrintPage += (_, e) =>
            {
                try
                {
                    var g = e.Graphics!;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.CompositingQuality = CompositingQuality.HighQuality; g.SmoothingMode = SmoothingMode.HighQuality;
                    g.TranslateTransform(-e.PageSettings.HardMarginX, -e.PageSettings.HardMarginY);        // edge to edge, not inside the printable area
                    using var ia = new System.Drawing.Imaging.ImageAttributes(); ia.SetWrapMode(WrapMode.TileFlipXY);   // no light line on the edges
                    g.DrawImage(img, Rectangle.Round(e.PageBounds), 0, 0, img.Width, img.Height, GraphicsUnit.Pixel, ia);
                    e.HasMorePages = false;
                }
                catch (Exception ex) { drawError = ex; e.Cancel = true; }
            };
            _log.Info($"Sending to '{r.PrinterName}': {match.Describe()}, {(landscape ? "landscape" : "portrait")}.");
            doc.Print();
            if (drawError is not null) return new PrintOutcome(false, "Could not draw the picture: " + drawError.Message);
            if (outFile is not null) { _log.Info("Saved virtual print: " + outFile); return new PrintOutcome(true, null); }
            return WaitForSpooler(r.PrinterName, r.JobLabel, TimeSpan.FromSeconds(120), ct);
        }
        catch (InvalidPrinterException e) { return new PrintOutcome(false, "Windows reports this printer is not valid: " + e.Message); }
        catch (OperationCanceledException) { throw; }
        catch (Exception e) { return new PrintOutcome(false, "Printing failed: " + e.Message); }
    }

    /// <summary>
    /// "Printed" means Windows finished handing the job to the printer, not just that the spooler accepted it. A job stuck on an error
    /// (offline, paper out, blocked) is a failure. One that is simply still going when the wait ends counts as sent.
    /// </summary>
    private PrintOutcome WaitForSpooler(string printerName, string docName, TimeSpan timeout, CancellationToken ct)
    {
        try
        {
            using var server = new Sp.LocalPrintServer();
            using var q = server.GetPrintQueue(printerName);
            var end = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < end)
            {
                ct.ThrowIfCancellationRequested();
                q.Refresh();
                var job = q.GetPrintJobInfoCollection().Cast<Sp.PrintSystemJobInfo>().FirstOrDefault(j => j.Name == docName);
                if (job is null) return new PrintOutcome(true, null);                       // left the queue: done
                if (job.IsInError || job.IsOffline || job.IsPaperOut || job.IsBlocked || job.IsUserInterventionRequired)
                {
                    var why = job.IsPaperOut ? "paper out" : job.IsOffline ? "printer offline" : job.IsBlocked ? "job blocked" : job.IsUserInterventionRequired ? "needs attention" : "error";
                    try { job.Cancel(); } catch { /* best effort: do not leave a stuck job to print later and duplicate */ }
                    return new PrintOutcome(false, $"The printer could not print it ({why}). The job was cancelled in Windows.");
                }
                Thread.Sleep(1000);
            }
            return new PrintOutcome(true, null);
        }
        catch (OperationCanceledException) { throw; }
        catch { return new PrintOutcome(true, null); }                                      // queue not observable: the spooler accepted it
    }
}
