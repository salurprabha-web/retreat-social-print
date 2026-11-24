using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

namespace RetreatPrintAgent.Core;

/// <summary>The server answered with an error. Expected refusals (a job that moved on, for example) carry a code.</summary>
public sealed class ApiException(HttpStatusCode status, string code, string? detail = null) : Exception($"{(int)status} {code}" + (string.IsNullOrEmpty(detail) ? "" : ": " + detail))
{
    public HttpStatusCode Status { get; } = status;
    public string Code { get; } = code;
}

/// <summary>The server no longer accepts this computer's credential (revoked, disabled or re-paired).</summary>
public sealed class CredentialRevokedException() : Exception("The server no longer accepts this computer. Pair it again.");

/// <summary>No usable connection to the server (network down, timeout, server restarting).</summary>
public sealed class OfflineException(string message, Exception? inner = null) : Exception(message, inner);

public interface IAgentApi
{
    Task<HeartbeatResponse> HeartbeatAsync(IReadOnlyList<PrinterInfo> printers, CancellationToken ct);
    Task<ClaimResponse> ClaimAsync(string printer, CancellationToken ct);
    /// <summary>Downloads the picture to <paramref name="destPath"/> and returns the SHA-256 of what was received.</summary>
    Task<string> DownloadImageAsync(JobInfo job, string destPath, CancellationToken ct);
    Task ProgressAsync(string jobId, CancellationToken ct);
    Task<ResultResponse> ReportResultAsync(string jobId, bool ok, string? error, int? copiesPrinted, CancellationToken ct);
}

public sealed class HttpAgentApi : IAgentApi
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http; private readonly string _version; private readonly string _host;

    public HttpAgentApi(HttpClient http, string version = AgentInfo.Version, string? hostName = null)
    {
        _http = http; _version = version; _host = hostName ?? Environment.MachineName;
    }

    public static HttpClient CreateClient(string serverUrl, string? token)
    {
        var http = new HttpClient { BaseAddress = new Uri(serverUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"RetreatPrintAgent/{AgentInfo.Version}");
        if (token is not null) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return http;
    }

    /// <summary>Exchanges the one-time pairing code for this computer's credential.</summary>
    public static async Task<RegisterResponse> RegisterAsync(string serverUrl, string code, CancellationToken ct, string? hostName = null)
    {
        using var http = CreateClient(serverUrl, null);
        try
        {
            using var res = await http.PostAsJsonAsync("api/v1/agent/register", new { code, hostName = hostName ?? Environment.MachineName, version = AgentInfo.Version }, Json, ct);
            if (res.StatusCode == HttpStatusCode.Unauthorized) throw new ApiException(res.StatusCode, "invalid_code");
            await EnsureOk(res, ct);
            return (await res.Content.ReadFromJsonAsync<RegisterResponse>(Json, ct))!;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new OfflineException("Could not reach the server. Check the address and your internet connection.", e);
        }
    }

    private static async Task EnsureOk(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        string code = "error"; string? detail = null;
        try
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("error", out var e)) code = e.GetString() ?? code;
            if (doc.RootElement.TryGetProperty("issues", out var issues)) detail = issues.ToString();     // validation problems: say which field
            if (detail is { Length: > 400 }) detail = detail[..400];
        }
        catch { /* not JSON */ }
        throw new ApiException(res.StatusCode, code, detail);
    }

    private async Task<T> Send<T>(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(method, path);
            if (body is not null) req.Content = JsonContent.Create(body, options: Json);
            using var res = await _http.SendAsync(req, ct);
            if (res.StatusCode == HttpStatusCode.Unauthorized) throw new CredentialRevokedException();
            await EnsureOk(res, ct);
            return (await res.Content.ReadFromJsonAsync<T>(Json, ct))!;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new OfflineException("Could not reach the server.", e);
        }
    }

    public Task<HeartbeatResponse> HeartbeatAsync(IReadOnlyList<PrinterInfo> printers, CancellationToken ct) =>
        Send<HeartbeatResponse>(HttpMethod.Post, "api/v1/agent/heartbeat", new
        {
            version = _version, hostName = _host,
            printers = printers.Select(p => new { name = p.Name, state = p.State, detail = p.Detail, paperSizes = p.PaperSizes.Take(80) }),
        }, ct);

    public Task<ClaimResponse> ClaimAsync(string printer, CancellationToken ct) =>
        Send<ClaimResponse>(HttpMethod.Post, "api/v1/agent/claim", new { printer }, ct);

    public async Task<string> DownloadImageAsync(JobInfo job, string destPath, CancellationToken ct)
    {
        try
        {
            using var res = await _http.GetAsync(job.ImageUrl.TrimStart('/'), HttpCompletionOption.ResponseHeadersRead, ct);
            if (res.StatusCode == HttpStatusCode.Unauthorized) throw new CredentialRevokedException();
            await EnsureOk(res, ct);
            using var sha = SHA256.Create();
            await using var src = await res.Content.ReadAsStreamAsync(ct);
            await using var dst = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None);
            var buf = new byte[81920]; int n;
            while ((n = await src.ReadAsync(buf, ct)) > 0) { sha.TransformBlock(buf, 0, n, null, 0); await dst.WriteAsync(buf.AsMemory(0, n), ct); }
            sha.TransformFinalBlock([], 0, 0);
            return Convert.ToHexString(sha.Hash!).ToLowerInvariant();
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new OfflineException("Could not download the picture.", e);
        }
    }

    public async Task ProgressAsync(string jobId, CancellationToken ct) => await Send<object>(HttpMethod.Post, $"api/v1/agent/jobs/{jobId}/progress", new { }, ct);

    public Task<ResultResponse> ReportResultAsync(string jobId, bool ok, string? error, int? copiesPrinted, CancellationToken ct) =>
        Send<ResultResponse>(HttpMethod.Post, $"api/v1/agent/jobs/{jobId}/result", new { ok, error, copiesPrinted }, ct);
}
