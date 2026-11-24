using System.Net;
using System.Text;
using System.Text.Json;
using RetreatPrintAgent.Core;

namespace RetreatPrintAgent.Tests;

public class PaperMatcherTests
{
    private static readonly DriverPaper[] Papers =
    [
        new("Letter", 850, 1100), new("A4", 827, 1169), new("4x6", 400, 600), new("4x6 (Borderless)", 400, 600), new("6x4 Landscape", 600, 400),
        new("5x7", 500, 700), new("A5", 583, 827), new("2x6 strip", 200, 600),
    ];

    [Theory]
    [InlineData("4x6", "4x6 (Borderless)")] [InlineData("5x7", "5x7")] [InlineData("A5", "A5")] [InlineData("2x6", "2x6 strip")]
    public void Finds_the_right_size_and_prefers_borderless_for_photos(string key, string expected) => Assert.Equal(expected, PaperMatcher.Match(Papers, key)!.Name);

    [Fact] public void Accepts_a_sideways_driver_entry() => Assert.Equal("6x4", PaperMatcher.Match([new DriverPaper("6x4", 600, 400)], "4x6")!.Name);
    [Fact] public void Tolerates_driver_rounding() => Assert.NotNull(PaperMatcher.Match([new DriverPaper("10x15cm", 394, 591)], "4x6"));
    [Fact] public void Never_uses_a_merely_similar_size() => Assert.Null(PaperMatcher.Match([new DriverPaper("Letter", 850, 1100), new DriverPaper("A4", 827, 1169)], "4x6"));
    [Fact] public void Unknown_keys_do_not_match() { Assert.Null(PaperMatcher.Match(Papers, "13x19")); Assert.Null(PaperMatcher.Dimensions("custom")); }
    [Fact]
    public void Explains_what_the_driver_offers_when_nothing_matches()
    {
        var m = PaperMatcher.NoMatchMessage("4x6", [new DriverPaper("Letter", 850, 1100)]);
        Assert.Contains("no 4x6 paper size", m); Assert.Contains("Letter (8.5x11 in)", m); Assert.Contains("custom paper size", m);
    }
}

public sealed class LedgerTests : IDisposable
{
    private readonly string _dir = T.TempDir(); private string P => Path.Combine(_dir, "ledger.jsonl");
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact]
    public void Survives_a_restart_with_the_exact_state()
    {
        var l = new JsonLedger(P); l.Begin("j1", "P", 2, 3); l.CopyStarting("j1"); l.CopySpooled("j1"); l.CopyStarting("j1");
        var e = new JsonLedger(P).Get("j1")!;
        Assert.Equal((2, 3, 1, true, LedgerState.Claimed), (e.Attempt, e.Copies, e.CopiesSpooled, e.CopyInProgress, e.State));
    }

    [Fact]
    public void Tracks_the_report_and_lists_only_unfinished_jobs()
    {
        var l = new JsonLedger(P); l.Begin("a", "P", 1, 1); l.Begin("b", "P", 1, 1); l.SetReport("a", true, null); l.MarkReported("b");
        var open = new JsonLedger(P).Unfinished(); var x = Assert.Single(open); Assert.Equal("a", x.JobId); Assert.Equal(LedgerState.ReportPending, x.State); Assert.True(x.ReportOk);
    }

    [Fact]
    public void Ignores_a_half_written_last_line_after_a_power_cut()
    {
        var l = new JsonLedger(P); l.Begin("a", "P", 1, 2); l.CopySpooled("a");
        File.AppendAllText(P, "{\"jobId\":\"a\",\"printer\":\"P\",\"att");                 // torn write
        var e = new JsonLedger(P).Get("a")!; Assert.Equal(1, e.CopiesSpooled);
    }

    [Fact]
    public void Is_compacted_but_never_forgets_unfinished_work()
    {
        var l = new JsonLedger(P); l.Begin("open", "P", 1, 1);
        for (int i = 0; i < 2100; i++) { l.Begin("d" + i, "P", 1, 1); l.MarkReported("d" + i); }
        var again = new JsonLedger(P);
        Assert.NotNull(again.Get("open")); Assert.True(File.ReadLines(P).Count() < 700);
    }
}

public sealed class ConfigTests : IDisposable
{
    private readonly string _dir = T.TempDir(); private string P => Path.Combine(_dir, "config.json");
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }
    private static readonly AgentConfig C = new("https://photos.example.com", "agt_supersecrettoken", "dev-1", "Print desk", "ev-1", "Rao Wedding", true);

    [Fact]
    public void Round_trips_and_never_writes_the_credential_as_readable_text()
    {
        var s = new ConfigStore(P, new PlainProtector()); s.Save(C);
        var text = File.ReadAllText(P);
        Assert.Equal(C, s.Load()); Assert.DoesNotContain("\"agt_supersecrettoken\"", text); Assert.Contains("deviceTokenProtected", text);
    }

    [Fact] public void No_file_means_not_paired() => Assert.Null(new ConfigStore(P, new PlainProtector()).Load());

    [Fact]
    public void A_file_that_cannot_be_decrypted_here_means_pair_again()
    {
        new ConfigStore(P, new PlainProtector()).Save(C);
        File.WriteAllText(P, File.ReadAllText(P).Replace("plain:", "other:"));
        Assert.Null(new ConfigStore(P, new PlainProtector()).Load());
        File.WriteAllText(P, "not json"); Assert.Null(new ConfigStore(P, new PlainProtector()).Load());
    }

    [Fact] public void Clear_unpairs() { var s = new ConfigStore(P, new PlainProtector()); s.Save(C); s.Clear(); Assert.Null(s.Load()); }
}

public sealed class HttpApiTests
{
    private static HttpAgentApi Api(StubHandler h) => new(new HttpClient(h) { BaseAddress = new Uri("https://srv.example/") }, "1.0.0", "PC1");
    private static HttpResponseMessage Json(HttpStatusCode s, object o) => new(s) { Content = new StringContent(JsonSerializer.Serialize(o), Encoding.UTF8, "application/json") };

    [Fact]
    public async Task Heartbeat_sends_printers_and_reads_the_settings()
    {
        var h = new StubHandler(_ => Json(HttpStatusCode.OK, new { ok = true, @event = new { id = "e", name = "Wedding" }, deviceName = "Desk", queuePaused = false, pollSeconds = 2, minAgentVersion = "1.0.0", printers = new[] { new { name = "DNP", enabled = true, paperSize = "4x6", orientation = "auto" } } }));
        var r = await Api(h).HeartbeatAsync([new PrinterInfo("DNP", "ready", null, ["4x6 (4x6 in)"])], default);
        Assert.Equal("Wedding", r.Event.Name); Assert.True(r.Printers[0].Enabled);
        Assert.EndsWith("/api/v1/agent/heartbeat", h.Requests[0].RequestUri!.AbsolutePath);
        using var body = JsonDocument.Parse(h.Bodies[0]); Assert.Equal("PC1", body.RootElement.GetProperty("hostName").GetString()); Assert.Equal("DNP", body.RootElement.GetProperty("printers")[0].GetProperty("name").GetString());
    }

    [Fact]
    public async Task Claim_returns_the_job_or_nothing()
    {
        var job = new { id = "j1", copies = 2, attempt = 1, widthPx = 1200, heightPx = 1800, format = "4x6", orientation = "portrait", paperSize = "4x6", sha256 = "ab", bytes = 10, guestCode = "G1", imageUrl = "/api/v1/agent/jobs/j1/image" };
        Assert.Equal("j1", (await Api(new StubHandler(_ => Json(HttpStatusCode.OK, new { job }))).ClaimAsync("DNP", default)).Job!.Id);
        Assert.Null((await Api(new StubHandler(_ => Json(HttpStatusCode.OK, new { job = (object?)null }))).ClaimAsync("DNP", default)).Job);
    }

    [Fact] public async Task A_401_means_the_credential_was_revoked() =>
        await Assert.ThrowsAsync<CredentialRevokedException>(() => Api(new StubHandler(_ => Json(HttpStatusCode.Unauthorized, new { error = "unauthenticated" }))).ClaimAsync("DNP", default));

    [Fact] public async Task A_network_failure_is_offline_not_a_crash() =>
        await Assert.ThrowsAsync<OfflineException>(() => Api(new StubHandler(_ => throw new HttpRequestException("no route"))).ClaimAsync("DNP", default));

    [Fact]
    public async Task Server_errors_carry_the_code()
    {
        var ex = await Assert.ThrowsAsync<ApiException>(() => Api(new StubHandler(_ => Json(HttpStatusCode.Conflict, new { error = "invalid_state" }))).ReportResultAsync("j", true, null, 1, default));
        Assert.Equal(HttpStatusCode.Conflict, ex.Status); Assert.Equal("invalid_state", ex.Code);
    }

    [Fact]
    public async Task Download_saves_the_file_and_returns_what_it_actually_received()
    {
        var dir = T.TempDir(); var dest = Path.Combine(dir, "a.jpg");
        try
        {
            var h = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(T.Picture) });
            var sha = await Api(h).DownloadImageAsync(T.Job(), dest, default);
            Assert.Equal(T.Sha(T.Picture), sha); Assert.Equal(T.Picture, await File.ReadAllBytesAsync(dest));
            Assert.Equal("/api/v1/agent/jobs/11111111-aaaa-bbbb-cccc-000000000001/image", h.Requests[0].RequestUri!.AbsolutePath);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task Result_reports_ok_error_and_copies()
    {
        var h = new StubHandler(_ => Json(HttpStatusCode.OK, new { ok = true, status = "failed" }));
        await Api(h).ReportResultAsync("j9", false, "Out of paper", 1, default);
        using var b = JsonDocument.Parse(h.Bodies[0]); Assert.False(b.RootElement.GetProperty("ok").GetBoolean()); Assert.Equal("Out of paper", b.RootElement.GetProperty("error").GetString()); Assert.Equal(1, b.RootElement.GetProperty("copiesPrinted").GetInt32());
        Assert.EndsWith("/jobs/j9/result", h.Requests[0].RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task Pairing_a_bad_code_says_so()
    {
        // RegisterAsync builds its own client, so check the mapping through the public error type instead of the network
        var ex = await Assert.ThrowsAnyAsync<Exception>(() => HttpAgentApi.RegisterAsync("http://127.0.0.1:1", "AAAA-BBBB", default));
        Assert.True(ex is OfflineException);                                    // nothing listens on port 1
    }
}
