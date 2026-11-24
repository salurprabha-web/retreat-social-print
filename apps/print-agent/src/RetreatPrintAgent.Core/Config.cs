using System.Text.Json;

namespace RetreatPrintAgent.Core;

public sealed record AgentConfig(
    string ServerUrl, string DeviceToken, string DeviceId, string DeviceName, string EventId, string EventName,
    bool StartWithWindows = true);

public interface ISecretProtector
{
    string Protect(string plain);
    string Unprotect(string protectedText);
}

/// <summary>For tests only. The real agent uses Windows DPAPI (the secret can only be read by the same Windows user on the same PC).</summary>
public sealed class PlainProtector : ISecretProtector
{
    public string Protect(string plain) => "plain:" + plain;
    public string Unprotect(string text) => text.StartsWith("plain:") ? text[6..] : throw new InvalidOperationException("not a plain secret");
}

/// <summary>Settings file. The device credential is stored protected, never as readable text.</summary>
public sealed class ConfigStore(string path, ISecretProtector protector)
{
    private sealed record Stored(string ServerUrl, string DeviceTokenProtected, string DeviceId, string DeviceName, string EventId, string EventName, bool StartWithWindows);
    private static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    public string Path { get; } = path;

    public AgentConfig? Load()
    {
        if (!File.Exists(Path)) return null;
        try
        {
            var s = JsonSerializer.Deserialize<Stored>(File.ReadAllText(Path), Opts);
            return s is null ? null : new AgentConfig(s.ServerUrl, protector.Unprotect(s.DeviceTokenProtected), s.DeviceId, s.DeviceName, s.EventId, s.EventName, s.StartWithWindows);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or System.Security.Cryptography.CryptographicException) { return null; }   // unreadable (copied from another PC/user): pair again
    }

    public void Save(AgentConfig c)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(Path))!);
        var tmp = Path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(new Stored(c.ServerUrl, protector.Protect(c.DeviceToken), c.DeviceId, c.DeviceName, c.EventId, c.EventName, c.StartWithWindows), Opts));
        File.Move(tmp, Path, true);
    }

    public void Clear() { if (File.Exists(Path)) File.Delete(Path); }
}
