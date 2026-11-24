namespace RetreatPrintAgent.Core;

public interface IAgentLog
{
    void Info(string message);
    void Warn(string message);
    void Error(string message);
}

public sealed class NullLog : IAgentLog
{
    public void Info(string message) { }
    public void Warn(string message) { }
    public void Error(string message) { }
}

/// <summary>Daily log files kept on the print computer (14 days), so a problem can be looked at after the event.</summary>
public sealed class FileAgentLog : IAgentLog
{
    private readonly string _dir; private readonly object _gate = new(); private readonly int _keepDays;
    public FileAgentLog(string dir, int keepDays = 14) { _dir = dir; _keepDays = keepDays; Directory.CreateDirectory(dir); Prune(); }
    public string Directory_ => _dir;

    private void Prune()
    {
        try { foreach (var f in Directory.GetFiles(_dir, "agent-*.log")) if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-_keepDays)) File.Delete(f); }
        catch { /* cleanup is best effort */ }
    }
    private void Write(string level, string message)
    {
        var line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff} {level,-5} {message}";
        lock (_gate) { try { File.AppendAllText(Path.Combine(_dir, $"agent-{DateTime.Now:yyyyMMdd}.log"), line + Environment.NewLine); } catch { /* never let logging stop printing */ } }
    }
    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);
}

/// <summary>Keeps the latest lines in memory for the status window.</summary>
public sealed class RingLog(int capacity = 300) : IAgentLog
{
    private readonly Queue<string> _lines = new(); private readonly object _gate = new();
    public event Action<string>? LineAdded;
    private void Add(string level, string message)
    {
        var line = $"{DateTime.Now:HH:mm:ss} {level} {message}";
        lock (_gate) { _lines.Enqueue(line); while (_lines.Count > capacity) _lines.Dequeue(); }
        LineAdded?.Invoke(line);
    }
    public IReadOnlyList<string> Snapshot() { lock (_gate) return _lines.ToList(); }
    public void Info(string message) => Add("", message);
    public void Warn(string message) => Add("WARN", message);
    public void Error(string message) => Add("ERROR", message);
}

public sealed class CompositeLog(params IAgentLog[] logs) : IAgentLog
{
    public void Info(string message) { foreach (var l in logs) l.Info(message); }
    public void Warn(string message) { foreach (var l in logs) l.Warn(message); }
    public void Error(string message) { foreach (var l in logs) l.Error(message); }
}
