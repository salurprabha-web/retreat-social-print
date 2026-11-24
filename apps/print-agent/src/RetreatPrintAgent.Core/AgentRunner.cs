using System.Globalization;

namespace RetreatPrintAgent.Core;

public sealed class AgentRunnerOptions
{
    public required string WorkDir { get; init; }
    public string Version { get; init; } = AgentInfo.Version;
    public TimeSpan HeartbeatInterval { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan MaxBackoff { get; init; } = TimeSpan.FromSeconds(30);
    public int ReportAttempts { get; init; } = 3;
    public TimeSpan ReportRetryDelay { get; init; } = TimeSpan.FromSeconds(1);
    public Func<DateTimeOffset> Now { get; init; } = () => DateTimeOffset.UtcNow;
}

public enum TickResult { Idle, Printed, Offline, Revoked, UpdateRequired }

/// <summary>
/// The agent's brain. One pass (<see cref="TickAsync"/>): say hello to the server, finish anything left over from a crash, then ask for a job for each
/// enabled, healthy printer and print it. Everything that could cause a double print goes through the on-disk ledger first.
/// </summary>
public sealed class AgentRunner
{
    private readonly IAgentApi _api; private readonly IPrinterService _printers; private readonly ILedger _ledger; private readonly IAgentLog _log; private readonly AgentRunnerOptions _o;
    private HeartbeatResponse? _cfg; private IReadOnlyList<PrinterInfo> _local = Array.Empty<PrinterInfo>(); private DateTimeOffset _lastHeartbeat = DateTimeOffset.MinValue;
    private readonly HashSet<string> _warnedPrinters = new();
    private readonly HashSet<string> _reportWarned = new();       // log each distinct report problem once, not every two seconds
    private int _pollSeconds = 2;

    public AgentStatus Status { get; private set; } = new();
    public event Action<AgentStatus>? StatusChanged;

    public AgentRunner(IAgentApi api, IPrinterService printers, ILedger ledger, IAgentLog log, AgentRunnerOptions options)
    {
        _api = api; _printers = printers; _ledger = ledger; _log = log; _o = options; Directory.CreateDirectory(options.WorkDir);
    }

    private void Set(Func<AgentStatus, AgentStatus> change) { Status = change(Status); StatusChanged?.Invoke(Status); }

    public async Task RunAsync(CancellationToken ct)
    {
        int failures = 0;
        while (!ct.IsCancellationRequested)
        {
            TickResult r;
            try { r = await TickAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception e) { _log.Error("Unexpected error: " + e); Set(s => s with { LastError = e.Message }); r = TickResult.Offline; }
            if (r == TickResult.Revoked) { _log.Error("The server no longer accepts this computer. Printing has stopped; pair the agent again."); break; }
            failures = r == TickResult.Offline ? failures + 1 : 0;
            var delay = r == TickResult.Printed ? TimeSpan.Zero
                : r == TickResult.Offline ? TimeSpan.FromSeconds(Math.Min(_o.MaxBackoff.TotalSeconds, Math.Pow(2, Math.Min(failures, 5))))
                : TimeSpan.FromSeconds(_pollSeconds);
            try { await Task.Delay(delay, ct); } catch (OperationCanceledException) { break; }
        }
    }

    public async Task<TickResult> TickAsync(CancellationToken ct)
    {
        try
        {
            if (_cfg is null || _o.Now() - _lastHeartbeat >= _o.HeartbeatInterval)
            {
                var early = await HeartbeatAsync(ct);
                if (early is not null) return early.Value;
            }
            if (Version.TryParse(_cfg!.MinAgentVersion, out var min) && Version.TryParse(_o.Version, out var mine) && mine < min)
            {
                Set(s => s with { Connection = ConnectionState.UpdateRequired, LastError = $"This agent (v{_o.Version}) is too old. Install v{_cfg.MinAgentVersion} or newer." });
                return TickResult.UpdateRequired;
            }

            await FinishLeftoversAsync(ct);
            if (_ledger.Unfinished().Count > 0) return TickResult.Idle;      // server not accepting our reports yet: do not take new work on top
            if (_cfg.QueuePaused) return TickResult.Idle;

            int printed = 0;
            foreach (var sp in _cfg.Printers.Where(p => p.Enabled))
            {
                var lp = _local.FirstOrDefault(p => string.Equals(p.Name, sp.Name, StringComparison.OrdinalIgnoreCase));
                if (lp is null || lp.State is "offline" or "error" or "paused")
                {
                    if (_warnedPrinters.Add(sp.Name + (lp?.State ?? "missing"))) _log.Warn($"Printer '{sp.Name}' is {(lp?.State ?? "not found")}{(lp?.Detail is { Length: > 0 } d ? " (" + d + ")" : "")}: not taking jobs until it is ready.");
                    continue;
                }
                _warnedPrinters.RemoveWhere(w => w.StartsWith(sp.Name));
                ClaimResponse c;
                try { c = await _api.ClaimAsync(sp.Name, ct); }
                catch (ApiException e) when (e.Status == System.Net.HttpStatusCode.NotFound) { _log.Warn($"Server does not know printer '{sp.Name}' yet."); continue; }
                if (c.Job is null) continue;
                await ProcessJobAsync(c.Job, sp, ct);
                printed++;
            }
            return printed > 0 ? TickResult.Printed : TickResult.Idle;
        }
        catch (CredentialRevokedException)
        {
            Set(s => s with { Connection = ConnectionState.Revoked, LastError = "This computer was removed or re-paired in the control panel." });
            return TickResult.Revoked;
        }
        catch (OfflineException e)
        {
            if (Status.Connection != ConnectionState.Offline) _log.Warn("Lost contact with the server: " + e.Message);
            Set(s => s with { Connection = ConnectionState.Offline, LastError = e.Message });
            return TickResult.Offline;
        }
    }

    private async Task<TickResult?> HeartbeatAsync(CancellationToken ct)
    {
        try { _local = _printers.List(); } catch (Exception e) { _log.Error("Could not list printers: " + e.Message); _local = Array.Empty<PrinterInfo>(); }
        _cfg = await _api.HeartbeatAsync(_local, ct);                   // OfflineException / CredentialRevokedException handled by the caller
        _lastHeartbeat = _o.Now(); _pollSeconds = Math.Clamp(_cfg.PollSeconds, 1, 30);
        var views = _cfg.Printers.Select(sp =>
        {
            var lp = _local.FirstOrDefault(p => string.Equals(p.Name, sp.Name, StringComparison.OrdinalIgnoreCase));
            return new PrinterView(sp.Name, lp?.State ?? "missing", lp?.Detail, sp.Enabled, sp.PaperSize, sp.Orientation, true);
        }).ToList();
        foreach (var lp in _local.Where(l => !views.Any(v => string.Equals(v.Name, l.Name, StringComparison.OrdinalIgnoreCase))))
            views.Add(new PrinterView(lp.Name, lp.State, lp.Detail, false, "any", "auto", false));
        bool wasOffline = Status.Connection is ConnectionState.Offline or ConnectionState.Connecting;
        Set(s => s with
        {
            Connection = ConnectionState.Online, EventName = _cfg.Event.Name, DeviceName = _cfg.DeviceName, QueuePaused = _cfg.QueuePaused,
            Printers = views, LastHeartbeat = _lastHeartbeat, LastError = null, PendingReports = _ledger.Unfinished().Count,
        });
        if (wasOffline) _log.Info($"Connected to the server. Event: {_cfg.Event.Name}.");
        return null;
    }

    /* ---------- crash recovery and report retries ---------- */

    /// <summary>
    /// Anything still open in the ledger at the start of a pass was left by an earlier run (a crash, a power cut, a lost connection).
    /// It is reported to the server as it really ended; it is never printed again.
    /// </summary>
    private async Task FinishLeftoversAsync(CancellationToken ct)
    {
        foreach (var e in _ledger.Unfinished())
        {
            if (e.State == LedgerState.Claimed)
            {
                var msg = e.CopyInProgress
                    ? $"The agent stopped while printing ({e.CopiesSpooled} of {e.Copies} copies were finished). That copy may or may not have printed: check the printer before retrying."
                    : e.CopiesSpooled == 0 ? "The agent restarted before printing this picture. Nothing was printed; press Retry."
                    : $"The agent stopped after printing {e.CopiesSpooled} of {e.Copies} copies. Check the printer before retrying.";
                _log.Warn($"Job {Short(e.JobId)}: {msg}");
                _ledger.SetReport(e.JobId, false, msg);
                await ReportAsync(e.JobId, false, msg, e.CopiesSpooled, ct);
            }
            else if (e.State == LedgerState.ReportPending)
            {
                _log.Info($"Job {Short(e.JobId)}: sending the saved result to the server.");
                await ReportAsync(e.JobId, e.ReportOk ?? false, e.ReportError, e.CopiesSpooled, ct);
            }
        }
        Set(s => s with { PendingReports = _ledger.Unfinished().Count });
    }

    /// <summary>Tells the server how the job ended. The result is saved first, so a lost connection only delays the report.</summary>
    private async Task<bool> ReportAsync(string jobId, bool ok, string? error, int copies, CancellationToken ct)
    {
        for (int attempt = 1; attempt <= _o.ReportAttempts; attempt++)
        {
            try
            {
                var r = await _api.ReportResultAsync(jobId, ok, error, copies, ct);
                _ledger.MarkReported(jobId);
                if (r.Late == true) _log.Info($"Job {Short(jobId)}: the server had put it back in the queue; recorded as printed.");
                Set(s => s with { PendingReports = _ledger.Unfinished().Count });
                return true;
            }
            catch (ApiException e) when (e.Status is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Conflict)
            {
                // the job was deleted or has moved on without us: nothing more to tell
                _log.Warn($"Job {Short(jobId)}: server says {e.Code}; result not needed.");
                _ledger.MarkReported(jobId); Set(s => s with { PendingReports = _ledger.Unfinished().Count });
                return true;
            }
            catch (Exception e) when (e is OfflineException || e is ApiException)
            {
                // Network trouble, a server error, or an unexpected refusal: the saved result stays in the ledger and is retried on later
                // passes. It must never crash the loop or be dropped, because the job is still "printing" on the server.
                if (attempt == _o.ReportAttempts) { if (_reportWarned.Add(jobId + e.Message)) _log.Warn($"Job {Short(jobId)}: could not report yet ({e.Message}); will keep retrying."); break; }
                await Task.Delay(_o.ReportRetryDelay, ct);
            }
        }
        Set(s => s with { PendingReports = _ledger.Unfinished().Count });
        return false;
    }

    /* ---------- one job ---------- */

    private async Task ProcessJobAsync(JobInfo job, ServerPrinter sp, CancellationToken ct)
    {
        var label = $"{job.GuestCode ?? "photo"} {Short(job.Id)}";
        var existing = _ledger.Get(job.Id);
        if (existing is { Copies: > 0 } && existing.CopiesSpooled >= existing.Copies)
        {
            // The server gave us a job we already printed completely (it put it back in the queue while we were busy). Never print it twice.
            _log.Warn($"Job {Short(job.Id)} was already printed on this computer; confirming it instead of printing again.");
            _ledger.SetReport(job.Id, true, null);
            await ReportAsync(job.Id, true, null, existing.Copies, ct);
            return;
        }
        _ledger.Begin(job.Id, sp.Name, job.Attempt, job.Copies);
        _log.Info($"Job {label}: {job.Copies} copy(ies) of {job.Format} on '{sp.Name}'.");
        var path = Path.Combine(_o.WorkDir, job.Id + ".jpg");
        try
        {
            string got;
            try { got = await _api.DownloadImageAsync(job, path, ct); }
            catch (OfflineException e) { await FailAsync(job, "Could not download the picture: " + e.Message, 0, ct); return; }
            catch (ApiException e) { await FailAsync(job, $"The server refused the picture download ({e.Code}).", 0, ct); return; }
            if (!string.Equals(got, job.Sha256, StringComparison.OrdinalIgnoreCase)) { await FailAsync(job, "The picture arrived damaged (checksum mismatch). Nothing was printed.", 0, ct); return; }

            for (int copy = 1; copy <= job.Copies; copy++)
            {
                int c = copy;
                Set(s => s with { Current = new CurrentJob(job.Id, job.GuestCode, sp.Name, c, job.Copies) });
                try { await _api.ProgressAsync(job.Id, ct); } catch (Exception e) when (e is not OperationCanceledException) { /* only keeps the job from being re-queued; not essential */ }
                _ledger.CopyStarting(job.Id);                         // on disk before the printer is touched
                PrintOutcome outcome;
                try { outcome = await _printers.PrintOneCopyAsync(new PrintRequest(sp.Name, path, sp.PaperSize, sp.Orientation == "auto" ? job.Orientation : sp.Orientation, job.WidthPx, job.HeightPx, label), ct); }
                catch (OperationCanceledException) { throw; }
                catch (Exception e) { outcome = new PrintOutcome(false, e.Message); }
                if (!outcome.Ok)
                {
                    await FailAsync(job, $"{outcome.Error} ({copy - 1} of {job.Copies} copies printed.)", copy - 1, ct);
                    return;
                }
                _ledger.CopySpooled(job.Id);
            }
            _ledger.SetReport(job.Id, true, null);
            _log.Info($"Job {label}: printed.");
            Set(s => s with { PrintedThisSession = s.PrintedThisSession + 1 });
            await ReportAsync(job.Id, true, null, job.Copies, ct);
        }
        finally
        {
            try { File.Delete(path); } catch { /* temp file: removed later */ }
            Set(s => s with { Current = null });
        }
    }

    private async Task FailAsync(JobInfo job, string message, int copiesDone, CancellationToken ct)
    {
        _log.Error($"Job {Short(job.Id)}: {message}");
        _ledger.SetReport(job.Id, false, message);
        Set(s => s with { FailedThisSession = s.FailedThisSession + 1 });
        await ReportAsync(job.Id, false, message, copiesDone, ct);
    }

    private static string Short(string id) => id.Length > 8 ? id[..8] : id;
}
