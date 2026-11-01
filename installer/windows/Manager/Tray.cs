using System;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexLocalMCP {
  sealed partial class Manager {
    NotifyIcon tray;
    System.Windows.Forms.Timer updateTimer;
    readonly CancellationTokenSource updateLifetime = new CancellationTokenSource();
    ToolStripMenuItem updateAction, trayStatus;
    ReleaseInfo availableUpdate;
    bool exitRequested, checkingUpdates, downloadingUpdate, trayTipShown;
    DateTime nextUpdateCheck = DateTime.MinValue;
    string notifiedVersion;

    void InitializeTray(string version) {
      var menu = new ContextMenuStrip();
      menu.Items.Add("Codex Local MCP " + version).Enabled = false;
      trayStatus = new ToolStripMenuItem("Not connected") { Enabled = false }; menu.Items.Add(trayStatus);
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Open", null, (s, e) => RestoreWindow());
      menu.Items.Add("Start connection", null, async (s, e) => { RestoreWindow(); await Operation(StartServer); });
      menu.Items.Add("Stop connection", null, async (s, e) => { if (!busy) await StopServer(); });
      menu.Items.Add("Copy MCP URL", null, (s, e) => { if (copyUrl.Enabled) copyUrl.PerformClick(); else { RestoreWindow(); ShowStep(2); } });
      updateAction = new ToolStripMenuItem("Check for updates", null, async (s, e) => { if (availableUpdate != null) await OfferUpdate(); else await CheckForUpdates(true); });
      menu.Items.Add(new ToolStripSeparator()); menu.Items.Add(updateAction);
      menu.Items.Add("Exit", null, (s, e) => { if (busy) { RestoreWindow(); Write("Finish or cancel the current operation before exiting."); return; } exitRequested = true; Close(); });
      tray = new NotifyIcon { Icon = Icon, Text = "Codex Local MCP", Visible = true, ContextMenuStrip = menu };
      tray.DoubleClick += (s, e) => RestoreWindow();
      tray.BalloonTipClicked += async (s, e) => { if (availableUpdate != null) await OfferUpdate(); else RestoreWindow(); };
      Resize += (s, e) => { if (WindowState == FormWindowState.Minimized) HideToTray(); };
      FormClosed += (s, e) => { updateLifetime.Cancel(); updateTimer.Stop(); updateTimer.Dispose(); tray.Visible = false; tray.Dispose(); menu.Dispose(); updateLifetime.Dispose(); };
      updateTimer = new System.Windows.Forms.Timer { Interval = 15000 };
      updateTimer.Tick += async (s, e) => { updateTimer.Interval = 12 * 60 * 60 * 1000; await CheckForUpdates(false); };
      updateTimer.Start();
      var link = new LinkLabel { Text = "Check for updates", LinkColor = Accent, AutoSize = true, Margin = new Padding(0, 0, 0, 12) };
      link.LinkClicked += async (s, e) => { if (availableUpdate != null) await OfferUpdate(); else await CheckForUpdates(true); };
      // The sidebar footer is already part of the setup layout.
      sidebarFooter.Controls.Add(link); sidebarFooter.Controls.SetChildIndex(link, 1);
      Write("Closing or minimizing the window keeps the app in the system tray. Use Exit to stop it.");
    }
    void RestoreWindow() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    void HideToTray() {
      Hide();
      if (!trayTipShown) { trayTipShown = true; tray.ShowBalloonTip(5000, "Codex Local MCP is still running", "Open the tray icon to manage the connection. Select Exit to stop the app.", ToolTipIcon.Info); }
    }
    async Task CheckForUpdates(bool manual) {
      if (checkingUpdates || downloadingUpdate || IsDisposed) return;
      if (DateTime.UtcNow < nextUpdateCheck) { if (manual) Write("Next update check: " + nextUpdateCheck.ToLocalTime().ToString("HH:mm") + "."); return; }
      checkingUpdates = true; nextUpdateCheck = DateTime.UtcNow.AddMinutes(1);
      try {
        using (var client = new UpdateClient()) {
          var current = System.Diagnostics.FileVersionInfo.GetVersionInfo(typeof(Manager).Assembly.Location).ProductVersion.Split('+')[0];
          var release = await client.CheckAsync(current, updateLifetime.Token);
          if (IsDisposed) return;
          availableUpdate = release; updateAction.Text = release == null ? "Check for updates" : "Update available: v" + release.Version;
          if (release == null) { if (manual) MessageBox.Show(this, "No newer published Windows release is available.", "Codex Local MCP updates", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
          Write("Update available: v" + release.Version + ". Open the tray menu to download it.");
          if (manual) await OfferUpdate();
          else if (notifiedVersion != release.Version) {
            notifiedVersion = release.Version;
            tray.ShowBalloonTip(10000, "Codex Local MCP update available", "Version " + release.Version + " is ready. Click to review and download it.", ToolTipIcon.Info);
          }
        }
      } catch (OperationCanceledException) { if (!IsDisposed && !updateLifetime.IsCancellationRequested) Write("The update check timed out. Try again later."); }
      catch (Exception error) {
        nextUpdateCheck = DateTime.UtcNow.AddMinutes(15);
        Write("Update check: " + error.Message);
        if (manual && !IsDisposed) MessageBox.Show(this, error.Message, "Update check", MessageBoxButtons.OK, MessageBoxIcon.Information);
      } finally { checkingUpdates = false; }
    }
    async Task OfferUpdate() {
      if (availableUpdate == null || downloadingUpdate || IsDisposed) return;
      RestoreWindow();
      if (busy) { Write("Finish the current operation before updating."); return; }
      var release = availableUpdate; // Pin this exact release through download and installation.
      try { UpdateInstaller.RequireTarget(typeof(Manager).Assembly.Location, release.Name.EndsWith(".zip", StringComparison.Ordinal)); }
      catch (Exception error) { MessageBox.Show(this, error.Message, "Codex Local MCP updates"); return; }
      string message = "Download version " + release.Version + " (" + Math.Ceiling(release.Size / 1048576.0) + " MB) from GitHub?\n\nThe app checks SHA256 and package metadata before installation. Your settings and workspace files stay separate.";
      if (MessageBox.Show(this, message, "Codex Local MCP update", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return;
      downloadingUpdate = true; busy = true;
      try {
        string path;
        using (var cancellation = CancellationTokenSource.CreateLinkedTokenSource(updateLifetime.Token))
        using (var progressWindow = new Form { Text = "Download update", ClientSize = new Size(420, 165), StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, Icon = Icon, Font = Font, BackColor = Color.White })
        using (var client = new UpdateClient()) {
          var label = new Label { Text = "Downloading v" + release.Version + "…", AutoSize = true, Location = new Point(24, 24) };
          var bar = new ProgressBar { Location = new Point(24, 60), Size = new Size(370, 20), Maximum = 100 };
          var cancel = Style(new Button(), "Cancel"); cancel.Location = new Point(290, 100);
          cancel.Click += (s, e) => cancellation.Cancel();
          progressWindow.FormClosing += (s, e) => cancellation.Cancel();
          progressWindow.Controls.AddRange(new Control[] { label, bar, cancel });
          progressWindow.Show(this); Enabled = false;
          try {
            path = await client.DownloadAsync(release, new Progress<int>(percent => { if (!bar.IsDisposed) { bar.Value = percent; label.Text = percent < 100 ? "Downloading v" + release.Version + " · " + percent + "%" : "Verifying update…"; } }), cancellation.Token);
          } finally { Enabled = true; progressWindow.Close(); }
        }
        if (MessageBox.Show(this, "Version " + release.Version + " passed verification.\n\nInstall now? The connection will stop. The app will restart after installation. This release has no publisher signature.", "Install update", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) {
          Write("Verified installer saved: " + path); return;
        }
        await StopServer();
        UpdateInstaller.Launch(path, release);
        exitRequested = true; busy = false; Close();
      } catch (OperationCanceledException) { Write("Update download cancelled. The current app is unchanged."); }
      catch (Exception error) { Write("Update failed: " + error.Message); if (!IsDisposed) MessageBox.Show(this, error.Message, "Codex Local MCP update", MessageBoxButtons.OK, MessageBoxIcon.Error); }
      finally { downloadingUpdate = false; busy = false; if (!IsDisposed) Enabled = true; }
    }
  }
}
