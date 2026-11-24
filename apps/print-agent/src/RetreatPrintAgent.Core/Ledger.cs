using System.Text.Json;

namespace RetreatPrintAgent.Core;

public enum LedgerState { Claimed, ReportPending, Reported }

/// <summary>
/// What this computer knows about one job, kept on disk so a crash or power cut never causes a second print.
/// Written BEFORE each copy is sent to the printer, and again after, so a restart can tell "not started", "may have printed" and "done".
/// </summary>
public sealed record LedgerEntry(
    string JobId, string Printer, int Attempt, int Copies, int CopiesSpooled, bool CopyInProgress,
    LedgerState State, bool? ReportOk, string? ReportError, DateTimeOffset Updated);

public interface ILedger
{
    LedgerEntry? Get(string jobId);
    void Begin(string jobId, string printer, int attempt, int copies);
    void CopyStarting(string jobId);
    void CopySpooled(string jobId);
    void SetReport(string jobId, bool ok, string? error);
    void MarkReported(string jobId);
    IReadOnlyList<LedgerEntry> Unfinished();
}

/// <summary>Append-only JSON-lines file. Every change is flushed to disk; the newest line per job wins.</summary>
public sealed class JsonLedger : ILedger
{
    private readonly string _path; private readonly object _gate = new(); private readonly Dictionary<string, LedgerEntry> _entries = new();
    private static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web);

    public JsonLedger(string path)
    {
        _path = path; Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        if (!File.Exists(path)) return;
        int lines = 0;
        foreach (var line in File.ReadLines(path))
        {
            lines++;
            try { var e = JsonSerializer.Deserialize<LedgerEntry>(line, Opts); if (e is not null) _entries[e.JobId] = e; }
            catch (JsonException) { /* a half-written last line after a power cut: ignore it, the previous line for that job stands */ }
        }
        if (lines > 2000) Compact();
    }

    private void Compact()
    {
        // Keep unfinished jobs and the most recent finished ones; the file never grows without limit.
        var keep = _entries.Values.Where(e => e.State != LedgerState.Reported).Concat(_entries.Values.Where(e => e.State == LedgerState.Reported).OrderByDescending(e => e.Updated).Take(500)).ToList();
        _entries.Clear(); foreach (var e in keep) _entries[e.JobId] = e;
        var tmp = _path + ".tmp";
        File.WriteAllLines(tmp, keep.Select(e => JsonSerializer.Serialize(e, Opts)));
        File.Move(tmp, _path, true);
    }

    private void Write(LedgerEntry e)
    {
        _entries[e.JobId] = e with { Updated = DateTimeOffset.UtcNow };
        using var fs = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read);
        using var w = new StreamWriter(fs);
        w.WriteLine(JsonSerializer.Serialize(_entries[e.JobId], Opts)); w.Flush(); fs.Flush(true);   // reach the disk before we touch the printer
    }

    public LedgerEntry? Get(string jobId) { lock (_gate) return _entries.GetValueOrDefault(jobId); }

    public void Begin(string jobId, string printer, int attempt, int copies)
    {
        lock (_gate) Write(new LedgerEntry(jobId, printer, attempt, copies, 0, false, LedgerState.Claimed, null, null, DateTimeOffset.UtcNow));
    }
    public void CopyStarting(string jobId) { lock (_gate) Write(_entries[jobId] with { CopyInProgress = true }); }
    public void CopySpooled(string jobId) { lock (_gate) { var e = _entries[jobId]; Write(e with { CopiesSpooled = e.CopiesSpooled + 1, CopyInProgress = false }); } }
    public void SetReport(string jobId, bool ok, string? error) { lock (_gate) Write(_entries[jobId] with { State = LedgerState.ReportPending, ReportOk = ok, ReportError = error, CopyInProgress = false }); }
    public void MarkReported(string jobId) { lock (_gate) Write(_entries[jobId] with { State = LedgerState.Reported }); }
    public IReadOnlyList<LedgerEntry> Unfinished() { lock (_gate) return _entries.Values.Where(e => e.State != LedgerState.Reported).OrderBy(e => e.Updated).ToList(); }
}
