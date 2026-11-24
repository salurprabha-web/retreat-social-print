using System.Net;
using System.Security.Cryptography;
using RetreatPrintAgent.Core;

namespace RetreatPrintAgent.Tests;

public static class T
{
    public static string Sha(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();
    public static readonly byte[] Picture = Enumerable.Range(0, 5000).Select(i => (byte)(i * 7)).ToArray();

    public static JobInfo Job(string id = "11111111-aaaa-bbbb-cccc-000000000001", int copies = 1, int attempt = 1, byte[]? bytes = null, string? sha = null) =>
        new(id, copies, attempt, 1200, 1800, "4x6", "portrait", "4x6", sha ?? Sha(bytes ?? Picture), (bytes ?? Picture).Length, "GABC12", $"/api/v1/agent/jobs/{id}/image");

    public static string TempDir() { var d = Path.Combine(Path.GetTempPath(), "rpa-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(d); return d; }
}

/// <summary>A scriptable stand-in for the server.</summary>
public sealed class FakeApi : IAgentApi
{
    public Queue<JobInfo> Jobs { get; } = new();
    public List<string> Calls { get; } = new();
    public List<(string JobId, bool Ok, string? Error, int? Copies)> Reports { get; } = new();
    public List<IReadOnlyList<PrinterInfo>> HeartbeatPrinters { get; } = new();
    public List<ServerPrinter> ServerPrinters { get; set; } = [new("DNP DS620", true, "4x6", "auto")];
    public bool QueuePaused { get; set; }
    public string MinAgentVersion { get; set; } = "1.0.0";
    public int OfflineHeartbeats { get; set; }
    public int OfflineReports { get; set; }
    public bool Revoked { get; set; }
    public byte[] ImageBytes { get; set; } = T.Picture;
    public HttpStatusCode? ReportStatus { get; set; }
    public bool ClaimNotFound { get; set; }

    public Task<HeartbeatResponse> HeartbeatAsync(IReadOnlyList<PrinterInfo> printers, CancellationToken ct)
    {
        Calls.Add("heartbeat");
        if (Revoked) throw new CredentialRevokedException();
        if (OfflineHeartbeats > 0) { OfflineHeartbeats--; throw new OfflineException("network down"); }
        HeartbeatPrinters.Add(printers);
        return Task.FromResult(new HeartbeatResponse(true, new ServerEvent("e1", "Test Wedding"), "Print desk", QueuePaused, 2, MinAgentVersion, ServerPrinters));
    }

    public Task<ClaimResponse> ClaimAsync(string printer, CancellationToken ct)
    {
        Calls.Add("claim:" + printer);
        if (Revoked) throw new CredentialRevokedException();
        if (ClaimNotFound) throw new ApiException(HttpStatusCode.NotFound, "unknown_printer");
        return Task.FromResult(Jobs.TryDequeue(out var j) ? new ClaimResponse(j, null) : new ClaimResponse(null, null));
    }

    public async Task<string> DownloadImageAsync(JobInfo job, string destPath, CancellationToken ct)
    {
        Calls.Add("download:" + job.Id);
        await File.WriteAllBytesAsync(destPath, ImageBytes, ct);
        return T.Sha(ImageBytes);
    }

    public Task ProgressAsync(string jobId, CancellationToken ct) { Calls.Add("progress"); return Task.CompletedTask; }

    public Task<ResultResponse> ReportResultAsync(string jobId, bool ok, string? error, int? copiesPrinted, CancellationToken ct)
    {
        Calls.Add("report:" + (ok ? "ok" : "failed"));
        if (OfflineReports > 0) { OfflineReports--; throw new OfflineException("network down"); }
        if (ReportStatus is { } s) throw new ApiException(s, "gone");
        Reports.Add((jobId, ok, error, copiesPrinted));
        return Task.FromResult(new ResultResponse(true, null, null, null, ok ? "printed" : "failed"));
    }
}

public sealed class FakePrinters : IPrinterService
{
    public List<PrinterInfo> Installed { get; set; } = [new("DNP DS620", "ready", null, ["4x6 (4x6 in)"])];
    public List<PrintRequest> Printed { get; } = new();
    public int FailOnCopy { get; set; }                // 1-based copy number across the run; 0 = never
    public string FailMessage { get; set; } = "Paper out";
    public bool Throw { get; set; }
    private int _n;

    public IReadOnlyList<PrinterInfo> List() => Installed;

    public Task<PrintOutcome> PrintOneCopyAsync(PrintRequest request, CancellationToken ct)
    {
        _n++;
        if (Throw) throw new InvalidOperationException("driver crashed");
        if (FailOnCopy == _n) return Task.FromResult(new PrintOutcome(false, FailMessage));
        Printed.Add(request);
        Assert.True(File.Exists(request.ImagePath));       // the file is really there while printing
        return Task.FromResult(new PrintOutcome(true, null));
    }
}

public sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
{
    public List<HttpRequestMessage> Requests { get; } = new();
    public List<string> Bodies { get; } = new();
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request); Bodies.Add(request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken));
        return respond(request);
    }
}
