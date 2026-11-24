using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using RetreatPrintAgent.Core;

namespace RetreatPrintAgent;

/// <summary>The window a print-desk operator looks at: is it connected, which printers are ready, what is printing, what went wrong.</summary>
public sealed class MainForm : Form
{
    private readonly AgentHost _host;
    private readonly Label _dot = new() { AutoSize = true, Font = new Font("Segoe UI", 20f), Text = "●" };
    private readonly Label _state = new() { AutoSize = true, Font = new Font("Segoe UI Semibold", 13f) };
    private readonly Label _sub = new() { AutoSize = true, ForeColor = Color.DimGray };
    private readonly Label _banner = new() { Dock = DockStyle.Top, Height = 30, TextAlign = ContentAlignment.MiddleCenter, BackColor = Color.FromArgb(183, 121, 31), ForeColor = Color.White, Visible = false };
    private readonly Label _current = new() { AutoSize = true, Font = new Font("Segoe UI", 10.5f) };
    private readonly Label _counts = new() { AutoSize = true, ForeColor = Color.DimGray };
    private readonly ListView _printers = new() { View = View.Details, FullRowSelect = true, GridLines = true, MultiSelect = false, Dock = DockStyle.Fill, HideSelection = false };
    private readonly TextBox _log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Font = new Font("Consolas", 9f), BackColor = Color.White };
    private readonly Button _pair = new() { Text = "Pair this computer…", AutoSize = true, Padding = new Padding(8, 3, 8, 3) };
    private readonly Button _unpair = new() { Text = "Remove pairing", AutoSize = true, Padding = new Padding(8, 3, 8, 3) };
    private readonly Button _test = new() { Text = "Print a test page", AutoSize = true, Padding = new Padding(8, 3, 8, 3), Enabled = false };
    private readonly Button _logs = new() { Text = "Open log folder", AutoSize = true, Padding = new Padding(8, 3, 8, 3) };
    private readonly CheckBox _auto = new() { Text = "Start with Windows", AutoSize = true };
    private AgentStatus _status = new();

    public MainForm(AgentHost host)
    {
        _host = host;
        Text = "Retreat Social Print Agent"; Width = 900; Height = 680; MinimumSize = new Size(720, 520); StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9.5f); Icon = SystemIcons.Application;

        var head = new TableLayoutPanel { Dock = DockStyle.Top, Height = 78, ColumnCount = 2, Padding = new Padding(14, 10, 14, 4) };
        head.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var text = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
        text.Controls.AddRange(new Control[] { _state, _sub });
        head.Controls.Add(_dot, 0, 0); head.Controls.Add(text, 1, 0);

        var mid = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 52, FlowDirection = FlowDirection.TopDown, Padding = new Padding(14, 0, 14, 0), WrapContents = false };
        mid.Controls.AddRange(new Control[] { _current, _counts });

        _printers.Columns.Add("Printer", 250); _printers.Columns.Add("Windows says", 130); _printers.Columns.Add("Event paper", 90); _printers.Columns.Add("Orientation", 90); _printers.Columns.Add("Takes jobs?", 230);
        _printers.SelectedIndexChanged += (_, _) => _test.Enabled = _printers.SelectedItems.Count == 1;
        var printersBox = new GroupBox { Text = "Printers on this computer", Dock = DockStyle.Fill, Padding = new Padding(8) };
        printersBox.Controls.Add(_printers);
        var logBox = new GroupBox { Text = "What the agent is doing", Dock = DockStyle.Fill, Padding = new Padding(8) };
        logBox.Controls.Add(_log);
        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, SplitterDistance = 220 };
        split.Panel1.Controls.Add(printersBox); split.Panel2.Controls.Add(logBox);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, Padding = new Padding(12, 8, 12, 4) };
        buttons.Controls.AddRange(new Control[] { _pair, _unpair, _test, _logs, _auto });

        Controls.Add(split); Controls.Add(buttons); Controls.Add(mid); Controls.Add(_banner); Controls.Add(head);

        _auto.Checked = AgentHost.AutoStartEnabled();
        _auto.CheckedChanged += (_, _) => { try { AgentHost.SetAutoStart(_auto.Checked); } catch (Exception e) { MessageBox.Show(this, e.Message, "Could not change start-up setting"); } };
        _pair.Click += (_, _) => ShowPair();
        _unpair.Click += (_, _) =>
        {
            if (MessageBox.Show(this, "Remove this computer's pairing? Printing from this computer stops until you pair it again.", "Remove pairing", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            _host.Unpair(); Apply(new AgentStatus());
        };
        _logs.Click += (_, _) => Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_host.LogDir}\"") { UseShellExecute = true });
        _test.Click += async (_, _) => await TestPrintAsync();
        _host.Ring.LineAdded += line => { if (IsHandleCreated) BeginInvoke(() => AppendLog(line)); };
        _host.StatusChanged += s => { if (IsHandleCreated) BeginInvoke(() => Apply(s)); };
        Load += (_, _) => { foreach (var l in _host.Ring.Snapshot()) AppendLog(l); Apply(_status); };
        var t = new System.Windows.Forms.Timer { Interval = 5000 }; t.Tick += (_, _) => Apply(_status); t.Start();   // keeps "last contact" fresh
    }

    private void AppendLog(string line) { _log.AppendText(line + Environment.NewLine); }

    public void ShowPair()
    {
        using var f = new PairForm(_host);
        if (f.ShowDialog(this) == DialogResult.OK) { _host.Start(); Apply(new AgentStatus()); }
    }

    private void Apply(AgentStatus s)
    {
        _status = s;
        var paired = _host.IsPaired;
        var (color, state) = !paired ? (Color.Gray, "Not paired")
            : s.Connection switch
            {
                ConnectionState.Online => (Color.FromArgb(29, 122, 77), "Connected"),
                ConnectionState.Offline => (Color.FromArgb(179, 38, 30), "No connection to the server"),
                ConnectionState.Revoked => (Color.FromArgb(179, 38, 30), "Removed from the event: pair again"),
                ConnectionState.UpdateRequired => (Color.FromArgb(179, 38, 30), "Update required"),
                _ => (Color.FromArgb(183, 121, 31), "Connecting…"),
            };
        _dot.ForeColor = color; _state.Text = state;
        _sub.Text = !paired ? "Press “Pair this computer” and enter the code from the event's Printers page."
            : $"{s.EventName ?? _host.Config?.EventName}  ·  {s.DeviceName ?? _host.Config?.DeviceName}  ·  v{AgentInfo.Version}" + (s.LastHeartbeat is { } hb ? $"  ·  last contact {(int)(DateTimeOffset.UtcNow - hb).TotalSeconds}s ago" : "");
        _banner.Visible = paired && (s.QueuePaused || !string.IsNullOrEmpty(s.LastError));
        _banner.Text = s.QueuePaused ? "Printing is paused by the print desk" : s.LastError ?? "";
        _current.Text = s.Current is { } c ? $"Printing {c.GuestCode ?? "photo"}: copy {c.Copy} of {c.Copies} on {c.Printer}" : paired ? "Idle: waiting for pictures" : "";
        _counts.Text = paired ? $"Printed this session: {s.PrintedThisSession}   Failed: {s.FailedThisSession}" + (s.PendingReports > 0 ? $"   Waiting to report: {s.PendingReports}" : "") : "";
        _pair.Visible = !paired || s.Connection == ConnectionState.Revoked; _unpair.Visible = paired;

        var sel = _printers.SelectedItems.Count == 1 ? _printers.SelectedItems[0].Text : null;
        _printers.BeginUpdate(); _printers.Items.Clear();
        foreach (var p in s.PrinterList)
        {
            var takes = !p.KnownToServer ? "Not set up in the event yet" : !p.Enabled ? "Off: turn it on in the event's Printers page"
                : p.State is "offline" or "error" or "paused" or "missing" ? "No: " + (p.Detail ?? p.State) : "Yes";
            var it = new ListViewItem(new[] { p.Name, p.State + (p.Detail is { Length: > 0 } ? $" ({p.Detail})" : ""), p.PaperSize == "any" ? "-" : p.PaperSize, p.Orientation, takes });
            if (p.Enabled && takes == "Yes") it.ForeColor = Color.FromArgb(29, 122, 77);
            else if (p.Enabled) it.ForeColor = Color.FromArgb(179, 38, 30);
            it.Selected = p.Name == sel; _printers.Items.Add(it);
        }
        _printers.EndUpdate();
    }

    private async Task TestPrintAsync()
    {
        if (_printers.SelectedItems.Count != 1) return;
        var name = _printers.SelectedItems[0].Text;
        var view = _status.PrinterList.FirstOrDefault(p => p.Name == name);
        var paper = view is { PaperSize: not "any" } ? view.PaperSize : "4x6";
        var landscape = view?.Orientation == "landscape";
        if (MessageBox.Show(this, $"Print a test page on “{name}” ({paper})?\nThis uses one sheet of paper.", "Test page", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        _test.Enabled = false;
        try
        {
            var (path, w, h) = TestPage.Create(System.IO.Path.Combine(_host.DataDir, "work"), name, paper, landscape);
            var r = await _host.Printers.PrintOneCopyAsync(new PrintRequest(name, path, paper, landscape ? "landscape" : "portrait", w, h, "Test page"), CancellationToken.None);
            try { System.IO.File.Delete(path); } catch { }
            _host.Log.Info(r.Ok ? $"Test page sent to '{name}'." : $"Test page failed on '{name}': {r.Error}");
            MessageBox.Show(this, r.Ok ? "The test page was sent to the printer." : r.Error, r.Ok ? "Test page" : "Test page failed", MessageBoxButtons.OK, r.Ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        finally { _test.Enabled = _printers.SelectedItems.Count == 1; }
    }
}

public sealed class PairForm : Form
{
    private readonly TextBox _server = new() { Dock = DockStyle.Top };
    private readonly TextBox _code = new() { Dock = DockStyle.Top, CharacterCasing = CharacterCasing.Upper, Font = new Font("Consolas", 14f) };
    private readonly Label _error = new() { AutoSize = true, ForeColor = Color.FromArgb(179, 38, 30), MaximumSize = new Size(380, 0) };
    private readonly Button _ok = new() { Text = "Pair", DialogResult = DialogResult.None, AutoSize = true, Padding = new Padding(14, 4, 14, 4) };
    private readonly AgentHost _host;

    public PairForm(AgentHost host)
    {
        _host = host;
        Text = "Pair this computer"; Width = 440; Height = 330; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        _server.Text = host.Config?.ServerUrl ?? "https://";
        var p = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(16), WrapContents = false };
        _server.Width = 390; _code.Width = 390;
        p.Controls.AddRange(new Control[] { new Label { Text = "Server address", AutoSize = true }, _server, new Label { Text = "Pairing code (from the event's Printers page)", AutoSize = true, Margin = new Padding(0, 10, 0, 0) }, _code, _error, _ok });
        Controls.Add(p); AcceptButton = _ok;
        _ok.Click += async (_, _) => await DoPair();
    }

    private async Task DoPair()
    {
        _error.Text = ""; _ok.Enabled = false; _ok.Text = "Pairing…";
        try { await _host.PairAsync(_server.Text, _code.Text, CancellationToken.None); DialogResult = DialogResult.OK; Close(); }
        catch (ApiException e) when (e.Code == "invalid_code") { _error.Text = "That code is not valid. Codes work once and expire after 30 minutes: make a new one in the event's Printers page."; }
        catch (OfflineException e) { _error.Text = e.Message; }
        catch (Exception e) { _error.Text = e.Message; }
        finally { _ok.Enabled = true; _ok.Text = "Pair"; }
    }
}

/// <summary>Lives in the system tray: closing the window only hides it, so printing carries on all event long.</summary>
public sealed class TrayContext : ApplicationContext
{
    private readonly AgentHost _host; private readonly MainForm _form; private readonly NotifyIcon _tray; private bool _exiting;

    public TrayContext(AgentHost host, bool startHidden)
    {
        _host = host; _form = new MainForm(host);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => Show());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit (stops printing)", null, (_, _) => Exit());
        _tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Retreat Social Print Agent", ContextMenuStrip = menu, Visible = true };
        _tray.DoubleClick += (_, _) => Show();
        _form.FormClosing += (_, e) => { if (!_exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; _form.Hide(); } };
        host.StatusChanged += s => { _tray.Text = Trim($"Retreat Print Agent: {s.Connection}" + (s.Current is { } c ? $", printing {c.GuestCode}" : "")); };
        host.Start();
        if (!startHidden || !host.IsPaired) { _form.Show(); if (!host.IsPaired) _form.ShowPair(); }
    }

    private static string Trim(string s) => s.Length > 62 ? s[..62] : s;     // NotifyIcon text limit
    private void Show() { _form.Show(); _form.WindowState = FormWindowState.Normal; _form.Activate(); }
    private void Exit()
    {
        if (MessageBox.Show("Exit the agent? Pictures will stop printing from this computer.", "Exit", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        _exiting = true; _tray.Visible = false; _host.Dispose(); _form.Close(); ExitThread();
    }
}
