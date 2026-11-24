namespace RetreatPrintAgent.Core;

public static class AgentInfo
{
    public const string Version = "1.0.0";
}

/// <summary>A printer installed on this computer, as the Windows driver reports it.</summary>
/// <param name="State">ready, busy, offline, error, paused or unknown</param>
public sealed record PrinterInfo(string Name, string State, string? Detail, IReadOnlyList<string> PaperSizes);

/// <summary>One print job handed out by the server.</summary>
public sealed record JobInfo(
    string Id, int Copies, int Attempt, int WidthPx, int HeightPx, string Format, string Orientation, string PaperSize,
    string Sha256, long Bytes, string? GuestCode, string ImageUrl);

public sealed record RegisterResponse(string DeviceToken, string DeviceId, string DeviceName, string EventId, string EventName);
public sealed record ServerEvent(string Id, string Name);
public sealed record ServerPrinter(string Name, bool Enabled, string PaperSize, string Orientation);
public sealed record HeartbeatResponse(bool Ok, ServerEvent Event, string DeviceName, bool QueuePaused, int PollSeconds, string MinAgentVersion, IReadOnlyList<ServerPrinter> Printers);
public sealed record ClaimResponse(JobInfo? Job, string? Reason);
public sealed record ResultResponse(bool Ok, bool? Duplicate, bool? Late, bool? Ignored, string? Status);

/// <summary>What the runner asks the Windows layer to print: ONE copy of one picture.</summary>
public sealed record PrintRequest(string PrinterName, string ImagePath, string PaperSize, string Orientation, int WidthPx, int HeightPx, string JobLabel);
public sealed record PrintOutcome(bool Ok, string? Error);

public interface IPrinterService
{
    IReadOnlyList<PrinterInfo> List();
    Task<PrintOutcome> PrintOneCopyAsync(PrintRequest request, CancellationToken ct);
}

public enum ConnectionState { Connecting, Online, Offline, Revoked, UpdateRequired }

public sealed record PrinterView(string Name, string State, string? Detail, bool Enabled, string PaperSize, string Orientation, bool KnownToServer);
public sealed record CurrentJob(string JobId, string? GuestCode, string Printer, int Copy, int Copies);

/// <summary>Everything the window shows. Immutable: the runner replaces it and raises an event.</summary>
public sealed record AgentStatus(
    ConnectionState Connection = ConnectionState.Connecting,
    string? EventName = null, string? DeviceName = null, bool QueuePaused = false,
    IReadOnlyList<PrinterView>? Printers = null, CurrentJob? Current = null, string? LastError = null,
    DateTimeOffset? LastHeartbeat = null, int PendingReports = 0, int PrintedThisSession = 0, int FailedThisSession = 0)
{
    public IReadOnlyList<PrinterView> PrinterList => Printers ?? Array.Empty<PrinterView>();
}
