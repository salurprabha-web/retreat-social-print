using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using RetreatPrintAgent.Core;

namespace RetreatPrintAgent;

/// <summary>The device credential can only be read by the same Windows user on the same computer (DPAPI).</summary>
public sealed class DpapiProtector : ISecretProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("RetreatSocialPrint.Agent.v1");
    public string Protect(string plain) => Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), Entropy, DataProtectionScope.CurrentUser));
    public string Unprotect(string text) => Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(text), Entropy, DataProtectionScope.CurrentUser));
}

/// <summary>Owns the agent's files, the running loop and the pairing. Used by the window, the tray icon and the headless mode alike.</summary>
public sealed class AgentHost : IDisposable
{
    public string DataDir { get; }
    public ConfigStore Store { get; }
    public FileAgentLog FileLog { get; }
    public RingLog Ring { get; } = new();
    public IAgentLog Log { get; }
    public WindowsPrinterService Printers { get; }
    public AgentRunner? Runner { get; private set; }
    public AgentConfig? Config { get; private set; }
    public event Action<AgentStatus>? StatusChanged;
    private CancellationTokenSource? _cts; private Task? _loop;

    public AgentHost(string? dataDir = null)
    {
        DataDir = dataDir ?? Environment.GetEnvironmentVariable("RSP_AGENT_DATA") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RetreatSocialPrint", "Agent");
        Directory.CreateDirectory(DataDir);
        Store = new ConfigStore(Path.Combine(DataDir, "config.json"), new DpapiProtector());
        FileLog = new FileAgentLog(Path.Combine(DataDir, "logs"));
        Log = new CompositeLog(FileLog, Ring);
        Printers = new WindowsPrinterService(Log);
        Config = Store.Load();
    }

    public bool IsPaired => Config is not null;
    public string LogDir => Path.Combine(DataDir, "logs");

    /// <summary>Starts (or restarts) the print loop with the saved credential. Safe to call again after pairing.</summary>
    public void Start()
    {
        Stop();
        Config = Store.Load();
        if (Config is null) { Log.Info("Not paired yet."); return; }
        var http = HttpAgentApi.CreateClient(Config.ServerUrl, Config.DeviceToken);
        var runner = new AgentRunner(new HttpAgentApi(http), Printers, new JsonLedger(Path.Combine(DataDir, "ledger.jsonl")), Log,
            new AgentRunnerOptions { WorkDir = Path.Combine(DataDir, "work") });
        runner.StatusChanged += s => StatusChanged?.Invoke(s);
        Runner = runner; _cts = new CancellationTokenSource();
        Log.Info($"Agent {AgentInfo.Version} started for '{Config.EventName}' ({Config.ServerUrl}).");
        _loop = Task.Run(() => runner.RunAsync(_cts.Token));
    }

    public void Stop()
    {
        try { _cts?.Cancel(); _loop?.Wait(TimeSpan.FromSeconds(3)); } catch { /* shutting down */ }
        _cts?.Dispose(); _cts = null; _loop = null; Runner = null;
    }

    public async Task<AgentConfig> PairAsync(string serverUrl, string code, CancellationToken ct)
    {
        serverUrl = serverUrl.Trim().TrimEnd('/');
        if (!Uri.TryCreate(serverUrl, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp))
            throw new ArgumentException("Enter the server address, for example https://photos.yourcompany.com");
        var r = await HttpAgentApi.RegisterAsync(serverUrl, code, ct);
        var cfg = new AgentConfig(serverUrl, r.DeviceToken, r.DeviceId, r.DeviceName, r.EventId, r.EventName, Config?.StartWithWindows ?? true);
        Store.Save(cfg); Config = cfg;
        Log.Info($"Paired as '{r.DeviceName}' for event '{r.EventName}'.");
        SetAutoStart(cfg.StartWithWindows);
        return cfg;
    }

    public void Unpair() { Stop(); Store.Clear(); Config = null; Log.Info("Unpaired."); }

    public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public static bool AutoStartEnabled() { using var k = Registry.CurrentUser.OpenSubKey(RunKey); return k?.GetValue("RetreatPrintAgent") is string; }
    public static void SetAutoStart(bool on)
    {
        using var k = Registry.CurrentUser.OpenSubKey(RunKey, true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) k.SetValue("RetreatPrintAgent", $"\"{Environment.ProcessPath}\" --minimized"); else k.DeleteValue("RetreatPrintAgent", false);
    }

    public void Dispose() => Stop();
}
