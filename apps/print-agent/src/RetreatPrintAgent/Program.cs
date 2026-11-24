using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using RetreatPrintAgent.Core;

namespace RetreatPrintAgent;

internal static class Program
{
    private static string? Arg(string[] a, string name) { var i = Array.IndexOf(a, name); return i >= 0 && i + 1 < a.Length ? a[i + 1] : null; }
    private static bool Has(string[] a, string name) => a.Contains(name);

    [STAThread]
    private static int Main(string[] args)
    {
        if (Has(args, "--help") || Has(args, "-h")) { Console_Write(Usage); return 0; }
        using var host = new AgentHost(Arg(args, "--data-dir"));

        if (Has(args, "--list-printers")) { foreach (var p in host.Printers.List()) Console_Write($"{p.Name}\t{p.State}\t{p.Detail}\t{string.Join("; ", p.PaperSizes)}"); return 0; }
        if (Has(args, "--selftest")) return SelfTest(host, args);

        // Pairing from the command line (for headless / kiosk installs): --server URL --pair CODE
        if (Arg(args, "--pair") is { } code)
        {
            var server = Arg(args, "--server") ?? host.Config?.ServerUrl;
            if (server is null) { Console_Write("--pair needs --server https://your-server"); return 2; }
            try { var cfg = host.PairAsync(server, code, CancellationToken.None).GetAwaiter().GetResult(); Console_Write($"Paired: {cfg.DeviceName} for '{cfg.EventName}'."); }
            catch (Exception e) { Console_Write("Pairing failed: " + (e is ApiException { Code: "invalid_code" } ? "that code is not valid or has expired." : e.Message)); return 3; }
        }

        if (Has(args, "--headless")) return Headless(host);

        using var mutex = new Mutex(true, @"Local\RetreatSocialPrintAgent", out var first);
        if (!first) { MessageBox.Show("The Retreat Social Print Agent is already running (look for its icon near the clock).", "Already running"); return 0; }
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext(host, Has(args, "--minimized")));
        return 0;
    }

    private static int Headless(AgentHost host)
    {
        if (!host.IsPaired) { Console_Write("Not paired. Run with --server URL --pair CODE first."); return 2; }
        using var stop = new ManualResetEventSlim();
        System.Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Set(); };
        host.Ring.LineAdded += System.Console.WriteLine;
        host.Start();
        stop.Wait();
        host.Stop();
        return 0;
    }

    /// <summary>Prints a calibration page without any server: proves the Windows printing path on this computer.</summary>
    private static int SelfTest(AgentHost host, string[] args)
    {
        var printer = Arg(args, "--printer") ?? "Microsoft Print to PDF";
        var paper = Arg(args, "--paper") ?? "A5";
        var landscape = Has(args, "--landscape");
        var (path, w, h) = TestPage.Create(Path.Combine(host.DataDir, "work"), printer, paper, landscape);
        var r = host.Printers.PrintOneCopyAsync(new PrintRequest(printer, path, paper, landscape ? "landscape" : "portrait", w, h, "Self test"), CancellationToken.None).GetAwaiter().GetResult();
        try { File.Delete(path); } catch { }
        Console_Write(r.Ok ? $"OK: test page sent to '{printer}' ({paper})." : $"FAILED: {r.Error}");
        return r.Ok ? 0 : 1;
    }

    private static void Console_Write(string text) { AttachConsole(-1); System.Console.WriteLine(text); }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool AttachConsole(int pid);

    private const string Usage = """
        Retreat Social Print Agent
          (no arguments)              open the window and tray icon
          --minimized                 start in the tray (used by "Start with Windows")
          --server URL --pair CODE    pair this computer with an event, then continue
          --headless                  run without a window (stop with Ctrl+C)
          --list-printers             list installed printers and their paper sizes
          --selftest [--printer NAME] [--paper 4x6|5x7|6x8|2x6|A5] [--landscape]
                                      print a calibration page (no server needed)
          --data-dir PATH             keep settings, logs and the ledger here
        """;
}
