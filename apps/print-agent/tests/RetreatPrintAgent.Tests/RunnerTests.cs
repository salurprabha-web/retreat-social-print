using RetreatPrintAgent.Core;

namespace RetreatPrintAgent.Tests;

public sealed class RunnerTests : IDisposable
{
    private readonly string _dir = T.TempDir();
    private readonly FakeApi _api = new(); private readonly FakePrinters _prn = new();
    private readonly NullLog _log = new();
    private JsonLedger Ledger => _ledger ??= new JsonLedger(Path.Combine(_dir, "ledger.jsonl"));
    private JsonLedger? _ledger;

    private AgentRunner Runner(Action<AgentRunnerOptions>? _ = null) =>
        new(_api, _prn, Ledger, _log, new AgentRunnerOptions { WorkDir = Path.Combine(_dir, "work"), HeartbeatInterval = TimeSpan.Zero, ReportRetryDelay = TimeSpan.Zero });

    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact]
    public async Task Prints_every_copy_reports_once_and_cleans_up()
    {
        _api.Jobs.Enqueue(T.Job(copies: 3)); var r = Runner();
        Assert.Equal(TickResult.Printed, await r.TickAsync(default));
        Assert.Equal(3, _prn.Printed.Count);
        Assert.All(_prn.Printed, p => Assert.Equal("DNP DS620", p.PrinterName));
        var rep = Assert.Single(_api.Reports); Assert.True(rep.Ok); Assert.Equal(3, rep.Copies);
        Assert.Equal(LedgerState.Reported, Ledger.Get(T.Job().Id)!.State);
        Assert.Empty(Directory.GetFiles(Path.Combine(_dir, "work")));
        Assert.Equal(1, r.Status.PrintedThisSession); Assert.Equal(ConnectionState.Online, r.Status.Connection); Assert.Equal("Test Wedding", r.Status.EventName);
    }

    [Fact]
    public async Task Passes_the_servers_paper_and_orientation_to_the_printer()
    {
        _api.ServerPrinters = [new("DNP DS620", true, "5x7", "landscape")]; _api.Jobs.Enqueue(T.Job()); await Runner().TickAsync(default);
        var p = Assert.Single(_prn.Printed); Assert.Equal("5x7", p.PaperSize); Assert.Equal("landscape", p.Orientation); Assert.Equal(1200, p.WidthPx);
    }

    [Fact]
    public async Task Refuses_a_damaged_picture_and_prints_nothing()
    {
        _api.ImageBytes = new byte[] { 1, 2, 3 }; _api.Jobs.Enqueue(T.Job());
        await Runner().TickAsync(default);
        Assert.Empty(_prn.Printed);
        var rep = Assert.Single(_api.Reports); Assert.False(rep.Ok); Assert.Contains("checksum", rep.Error);
    }

    [Fact]
    public async Task Reports_how_many_copies_printed_when_the_printer_fails_midway()
    {
        _prn.FailOnCopy = 2; _api.Jobs.Enqueue(T.Job(copies: 3));
        await Runner().TickAsync(default);
        Assert.Single(_prn.Printed);
        var rep = Assert.Single(_api.Reports); Assert.False(rep.Ok); Assert.Contains("Paper out", rep.Error); Assert.Contains("1 of 3", rep.Error); Assert.Equal(1, rep.Copies);
    }

    [Fact]
    public async Task A_driver_exception_becomes_a_failed_job_not_a_crash()
    {
        _prn.Throw = true; _api.Jobs.Enqueue(T.Job());
        await Runner().TickAsync(default);
        var rep = Assert.Single(_api.Reports); Assert.False(rep.Ok); Assert.Contains("driver crashed", rep.Error);
    }

    [Fact]
    public async Task A_lost_connection_after_printing_delays_the_report_but_never_reprints()
    {
        _api.OfflineReports = 99; _api.Jobs.Enqueue(T.Job()); _api.Jobs.Enqueue(T.Job("22222222-aaaa-bbbb-cccc-000000000002"));
        var r = Runner(); await r.TickAsync(default);
        Assert.Single(_prn.Printed); Assert.Empty(_api.Reports);
        Assert.Equal(LedgerState.ReportPending, Ledger.Get(T.Job().Id)!.State); Assert.Equal(1, r.Status.PendingReports);
        await r.TickAsync(default);                                            // still offline: no new work is taken on top
        Assert.Single(_prn.Printed); Assert.Single(_api.Jobs);
        _api.OfflineReports = 0; await r.TickAsync(default);                   // back online: the saved result is delivered FIRST, then work resumes
        Assert.Equal("11111111-aaaa-bbbb-cccc-000000000001", _api.Reports[0].JobId); Assert.True(_api.Reports[0].Ok); Assert.Equal(0, r.Status.PendingReports);
        Assert.Equal(1, _prn.Printed.Count(p => p.JobLabel.Contains("11111111")));   // the first picture was printed exactly once
        Assert.Equal(1, _prn.Printed.Count(p => p.JobLabel.Contains("22222222")));   // and the next one only after that
    }

    [Fact]
    public async Task After_a_crash_the_result_is_delivered_by_the_next_run_without_printing_again()
    {
        { _api.OfflineReports = 99; _api.Jobs.Enqueue(T.Job()); await Runner().TickAsync(default); _ledger = null; }   // run 1: printed, could not report, "crashes"
        Assert.Single(_prn.Printed);
        _api.OfflineReports = 0;
        var again = Runner(); await again.TickAsync(default);                                                          // run 2 (new process, same ledger file)
        Assert.Single(_prn.Printed); var rep = Assert.Single(_api.Reports); Assert.True(rep.Ok);
    }

    [Fact]
    public async Task A_crash_before_printing_is_reported_as_nothing_printed()
    {
        Ledger.Begin("job-a", "DNP DS620", 1, 2);
        var r = Runner(); await r.TickAsync(default);
        Assert.Empty(_prn.Printed); var rep = Assert.Single(_api.Reports); Assert.False(rep.Ok); Assert.Contains("Nothing was printed", rep.Error);
    }

    [Fact]
    public async Task A_crash_during_a_copy_is_reported_as_unknown_never_as_success()
    {
        Ledger.Begin("job-b", "DNP DS620", 1, 2); Ledger.CopyStarting("job-b");
        await Runner().TickAsync(default);
        var rep = Assert.Single(_api.Reports); Assert.False(rep.Ok); Assert.Contains("may or may not have printed", rep.Error);
    }

    [Fact]
    public async Task A_crash_between_copies_reports_the_partial_result()
    {
        Ledger.Begin("job-c", "DNP DS620", 1, 3); Ledger.CopyStarting("job-c"); Ledger.CopySpooled("job-c");
        await Runner().TickAsync(default);
        var rep = Assert.Single(_api.Reports); Assert.False(rep.Ok); Assert.Contains("1 of 3", rep.Error); Assert.Equal(1, rep.Copies);
    }

    [Fact]
    public async Task Never_prints_a_job_it_already_finished_even_if_the_server_hands_it_out_again()
    {
        var job = T.Job(copies: 2); _api.Jobs.Enqueue(job); var r = Runner(); await r.TickAsync(default);
        Assert.Equal(2, _prn.Printed.Count);
        _api.Reports.Clear(); _api.Jobs.Enqueue(job with { Attempt = 2 });     // server requeued it while we were busy, then gave it to us again
        await r.TickAsync(default);
        Assert.Equal(2, _prn.Printed.Count);                                   // no new paper
        var rep = Assert.Single(_api.Reports); Assert.True(rep.Ok);
    }

    [Fact]
    public async Task An_operator_retry_after_a_failure_prints_the_whole_job_again()
    {
        _prn.FailOnCopy = 1; var job = T.Job(copies: 2); _api.Jobs.Enqueue(job); var r = Runner(); await r.TickAsync(default);
        Assert.Empty(_prn.Printed); Assert.False(_api.Reports[0].Ok);
        _api.Reports.Clear(); _api.Jobs.Enqueue(job with { Attempt = 2 });
        await r.TickAsync(default);
        Assert.Equal(2, _prn.Printed.Count); Assert.True(Assert.Single(_api.Reports).Ok);
    }

    [Fact]
    public async Task Skips_printers_that_are_disabled_offline_missing_or_while_the_queue_is_paused()
    {
        _api.ServerPrinters = [new("DNP DS620", false, "4x6", "auto")]; _api.Jobs.Enqueue(T.Job()); var r = Runner(); await r.TickAsync(default);
        Assert.DoesNotContain(_api.Calls, c => c.StartsWith("claim"));
        _api.ServerPrinters = [new("DNP DS620", true, "4x6", "auto")]; _prn.Installed = [new("DNP DS620", "offline", "Paper out", [])]; await r.TickAsync(default);
        Assert.DoesNotContain(_api.Calls, c => c.StartsWith("claim"));
        _prn.Installed = []; await r.TickAsync(default);
        Assert.DoesNotContain(_api.Calls, c => c.StartsWith("claim"));
        _prn.Installed = [new("DNP DS620", "ready", null, [])]; _api.QueuePaused = true; await r.TickAsync(default);
        Assert.DoesNotContain(_api.Calls, c => c.StartsWith("claim")); Assert.True(r.Status.QueuePaused);
        _api.QueuePaused = false; await r.TickAsync(default);
        Assert.Single(_prn.Printed);                                            // and prints as soon as it is allowed
    }

    [Fact]
    public async Task A_busy_printer_still_takes_jobs_and_each_enabled_printer_is_asked()
    {
        _api.ServerPrinters = [new("DNP DS620", true, "4x6", "auto"), new("Strip printer", true, "2x6", "auto")];
        _prn.Installed = [new("DNP DS620", "busy", null, []), new("Strip printer", "ready", null, [])];
        await Runner().TickAsync(default);
        Assert.Contains("claim:DNP DS620", _api.Calls); Assert.Contains("claim:Strip printer", _api.Calls);
    }

    [Fact]
    public async Task Sends_the_printers_it_finds_and_shows_them_with_the_servers_settings()
    {
        _prn.Installed = [new("DNP DS620", "ready", null, ["4x6 (4x6 in)"]), new("Office laser", "ready", null, [])];
        var r = Runner(); await r.TickAsync(default);
        Assert.Equal(2, _api.HeartbeatPrinters[0].Count);
        var dnp = r.Status.PrinterList.Single(p => p.Name == "DNP DS620"); Assert.True(dnp.Enabled); Assert.Equal("4x6", dnp.PaperSize);
        var office = r.Status.PrinterList.Single(p => p.Name == "Office laser"); Assert.False(office.Enabled); Assert.False(office.KnownToServer);
    }

    [Fact]
    public async Task Goes_offline_without_losing_anything_and_comes_back()
    {
        _api.OfflineHeartbeats = 2; var r = Runner();
        Assert.Equal(TickResult.Offline, await r.TickAsync(default)); Assert.Equal(ConnectionState.Offline, r.Status.Connection);
        Assert.Equal(TickResult.Offline, await r.TickAsync(default));
        _api.Jobs.Enqueue(T.Job()); Assert.Equal(TickResult.Printed, await r.TickAsync(default));
        Assert.Equal(ConnectionState.Online, r.Status.Connection); Assert.Null(r.Status.LastError);
    }

    [Fact]
    public async Task Stops_when_the_server_revokes_the_computer()
    {
        _api.Revoked = true; var r = Runner();
        Assert.Equal(TickResult.Revoked, await r.TickAsync(default)); Assert.Equal(ConnectionState.Revoked, r.Status.Connection);
        Assert.Empty(_prn.Printed);
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await r.RunAsync(cts.Token);          // RunAsync returns by itself, not by timeout
        Assert.False(cts.IsCancellationRequested);
    }

    [Fact]
    public async Task Does_not_print_when_the_agent_is_too_old_for_the_server()
    {
        _api.MinAgentVersion = "9.0.0"; _api.Jobs.Enqueue(T.Job()); var r = Runner();
        Assert.Equal(TickResult.UpdateRequired, await r.TickAsync(default)); Assert.Equal(ConnectionState.UpdateRequired, r.Status.Connection);
        Assert.Empty(_prn.Printed); Assert.Single(_api.Jobs);
    }

    [Fact]
    public async Task A_report_the_server_no_longer_wants_is_dropped_instead_of_retried_forever()
    {
        _api.ReportStatus = System.Net.HttpStatusCode.NotFound; _api.Jobs.Enqueue(T.Job()); var r = Runner(); await r.TickAsync(default);
        Assert.Equal(0, r.Status.PendingReports); Assert.Empty(Ledger.Unfinished());
    }

    [Fact]
    public async Task An_unexpected_refusal_of_the_report_neither_crashes_the_loop_nor_loses_the_result()
    {
        _api.ReportStatus = System.Net.HttpStatusCode.BadRequest; _api.Jobs.Enqueue(T.Job()); _api.Jobs.Enqueue(T.Job("22222222-aaaa-bbbb-cccc-000000000002"));
        var r = Runner(); await r.TickAsync(default);                      // must not throw
        Assert.Equal(1, r.Status.PendingReports); Assert.Equal(LedgerState.ReportPending, Ledger.Get(T.Job().Id)!.State);
        await r.TickAsync(default); await r.TickAsync(default);
        Assert.Single(_prn.Printed);                                       // nothing new is printed on top of an unreported job
        _api.ReportStatus = null; await r.TickAsync(default);              // once the server accepts it, the saved result is delivered
        Assert.True(_api.Reports[0].Ok); Assert.Equal("11111111-aaaa-bbbb-cccc-000000000001", _api.Reports[0].JobId);
    }

    [Fact]
    public async Task Unknown_printer_on_the_server_is_tolerated()
    {
        _api.ClaimNotFound = true; var r = Runner(); Assert.Equal(TickResult.Idle, await r.TickAsync(default));
    }

    [Fact]
    public async Task Status_changes_are_announced_for_the_window()
    {
        var seen = new List<ConnectionState>(); _api.Jobs.Enqueue(T.Job()); var r = Runner(); r.StatusChanged += s => seen.Add(s.Connection);
        await r.TickAsync(default); Assert.Contains(ConnectionState.Online, seen);
    }
}
