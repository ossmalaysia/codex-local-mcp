using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CodexLocalMCP {
  public sealed class ManagerActivityEvent {
    public int v { get; set; }
    public string type { get; set; }
    public string id { get; set; }
    public string action { get; set; }
    public string workspace { get; set; }
    public string status { get; set; }
    public string phase { get; set; }
    public long elapsedMs { get; set; }
    public int? files { get; set; }
    public int? exitCode { get; set; }
    public bool timedOut { get; set; }
  }
  sealed partial class Manager {
    const string ActivityPrefix = "codex-local-mcp activity: ";
    readonly ListView taskActivity = new ListView { View = View.Details, FullRowSelect = true, HideSelection = false, MultiSelect = false, Height = 230, Width = 620, BorderStyle = BorderStyle.FixedSingle };
    readonly Label activitySummary = Copy("Waiting for requests", 16, true), latestRequest = Copy("No requests received in this app session.", 9), activityDetails = Copy("Select a task to see its workspace and result.", 9);
    readonly ProgressBar activityProgress = new ProgressBar { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 0, Height = 5, Width = 620 };
    readonly Button openTaskWorkspace = new Button();
    readonly Dictionary<string, ManagerActivityEvent> activityJobs = new Dictionary<string, ManagerActivityEvent>();
    readonly Dictionary<string, DateTime> activitySeen = new Dictionary<string, DateTime>();
    readonly Timer activityTimer = new Timer { Interval = 1000 };

    void BuildActivityPage(Panel host) {
      var page = Page(4, "LIVE ACTIVITY", "See what Codex is doing", "Requests and task progress appear here while this app runs.");
      page.Controls.Add(activitySummary); page.Controls.Add(activityProgress); page.Controls.Add(latestRequest);
      taskActivity.AccessibleName = "Codex task activity";
      taskActivity.Font = new Font("Segoe UI", 10);
      taskActivity.Columns.Add("Request", 140); taskActivity.Columns.Add("Status", 190); taskActivity.Columns.Add("Elapsed", 70); taskActivity.Columns.Add("Files", 50); taskActivity.Columns.Add("Workspace", 165);
      page.Controls.Add(taskActivity); page.Controls.Add(activityDetails);
      Style(openTaskWorkspace, "Open workspace"); openTaskWorkspace.Enabled = false; page.Controls.Add(Row(openTaskWorkspace));
      page.Controls.Add(Copy("Elapsed time shows how long a task has run. Image generation does not provide a percentage.", 9));
      page.Controls.Add(Copy("Activity is kept in this window for the current app session. Request prompts and image data are not shown.", 9));
      var logs = Style(new Button(), "Show connection logs");
      logs.Click += (s, e) => { log.Visible = !log.Visible; logs.Text = log.Visible ? "Hide connection logs" : "Show connection logs"; };
      page.Controls.Add(Row(logs));
      log.Width = 620; log.Height = 140; log.Dock = DockStyle.None; log.BackColor = Canvas; log.BorderStyle = BorderStyle.FixedSingle; log.Font = new Font("Consolas", 9); log.Visible = false;
      page.Controls.Add(log);
      taskActivity.SelectedIndexChanged += (s, e) => ShowActivityDetails();
      openTaskWorkspace.Click += (s, e) => {
        if (taskActivity.SelectedItems.Count == 0) return;
        var value = (ManagerActivityEvent)taskActivity.SelectedItems[0].Tag;
        try {
          if (!ActivityWorkspace(value.workspace) || !Directory.Exists(value.workspace)) throw new IOException("The workspace is not available.");
          for (var cursor = value.workspace; cursor != null && cursor.Length > 3; cursor = Path.GetDirectoryName(cursor))
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException("The workspace must not contain links.");
          Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), Quote(value.workspace)) { UseShellExecute = false });
        } catch (Exception error) { MessageBox.Show(this, error.Message, "Open workspace"); }
      };
      activityTimer.Tick += (s, e) => RefreshActivityTimes(); activityTimer.Start();
      Disposed += (s, e) => { activityTimer.Stop(); activityTimer.Dispose(); };
    }
    static string ActivityAction(string value) {
      switch (value) {
        case "codex_generate_image": return "Generate image";
        case "codex_run": return "Run Codex task";
        case "codex_job_result": return "Check task result";
        case "codex_read_artifact": return "Read saved file";
        case "initialize": return "MCP connection";
        case "tools/list": return "Load tools";
        case "resources/list": return "List resources";
        case "resources/read": return "Read resource";
        default: return null;
      }
    }
    static string ActivityStatus(ManagerActivityEvent value) {
      if (value.status == "completed") return "Completed";
      if (value.status == "failed") return value.timedOut ? "Timed out" : "Failed";
      if (value.status == "interrupted") return "Connection stopped";
      switch (value.phase) {
        case "queued": return "Queued for workspace";
        case "preparing": return "Preparing workspace";
        case "running_command": return "Running command";
        case "writing_files": return "Writing files";
        case "collecting_files": return "Collecting results";
        default: return value.action == "codex_generate_image" ? "Generating image" : "Codex is working";
      }
    }
    bool ActivityWorkspace(string value) {
      if (string.IsNullOrWhiteSpace(value) || value.Length > 2048 || !Path.IsPathRooted(value) || value.StartsWith(@"\\")) return false;
      var full = Path.GetFullPath(value); var root = Path.GetFullPath(saved.Workspace).TrimEnd('\\') + "\\";
      return full.Equals(root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) || full.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }
    bool ReadActivity(string text) {
      if (!text.StartsWith(ActivityPrefix, StringComparison.Ordinal)) return false;
      try {
        if (text.Length > 8192) return true;
        var value = new JavaScriptSerializer { MaxJsonLength = 8192 }.Deserialize<ManagerActivityEvent>(text.Substring(ActivityPrefix.Length));
        if (value == null || value.v != 1 || ActivityAction(value.action) == null) return true;
        if (value.type == "request") { latestRequest.Text = DateTime.Now.ToString("HH:mm:ss") + " · Request received: " + ActivityAction(value.action); return true; }
        Guid id;
        if (value.type != "job" || !Guid.TryParseExact(value.id, "D", out id) || (value.action != "codex_run" && value.action != "codex_generate_image") || !ActivityWorkspace(value.workspace) || value.elapsedMs < 0 || value.elapsedMs > 86400000 || (value.files.HasValue && (value.files < 0 || value.files > 10000)) || !new[] { "running", "completed", "failed" }.Contains(value.status)) return true;
        if (value.status == "running" && !new[] { "queued", "preparing", "running", "running_command", "writing_files", "collecting_files" }.Contains(value.phase)) return true;
        activityJobs[value.id] = value; activitySeen[value.id] = DateTime.UtcNow;
        var row = taskActivity.Items.Cast<ListViewItem>().FirstOrDefault(x => x.Name == value.id);
        if (row == null) {
          row = new ListViewItem(ActivityAction(value.action)) { Name = value.id };
          row.SubItems.AddRange(new[] { "", "", "", Path.GetFileName(value.workspace.TrimEnd('\\')) }); taskActivity.Items.Insert(0, row);
        }
        row.Tag = value; row.SubItems[1].Text = ActivityStatus(value); row.SubItems[3].Text = value.files?.ToString() ?? "—";
        if (taskActivity.SelectedItems.Count == 0) row.Selected = true;
        row.ForeColor = value.status == "failed" ? Color.FromArgb(170, 52, 52) : value.status == "completed" ? Color.FromArgb(25, 116, 85) : Ink;
        // Keep running rows and the latest completed history. The server allows at most four active jobs.
        while (taskActivity.Items.Count > 100) {
          var oldest = taskActivity.Items.Cast<ListViewItem>().LastOrDefault(x => ((ManagerActivityEvent)x.Tag).status != "running");
          if (oldest == null) break;
          activityJobs.Remove(oldest.Name); activitySeen.Remove(oldest.Name); taskActivity.Items.Remove(oldest);
        }
        RefreshActivityTimes(); ShowActivityDetails(); return true;
      } catch { return true; }
    }
    void RefreshActivityTimes() {
      int active = 0;
      foreach (ListViewItem row in taskActivity.Items) {
        var value = (ManagerActivityEvent)row.Tag; var elapsed = value.elapsedMs;
        if (value.status == "running") { active++; elapsed += Math.Max(0, (long)(DateTime.UtcNow - activitySeen[value.id]).TotalMilliseconds); }
        row.SubItems[2].Text = TimeSpan.FromMilliseconds(elapsed).ToString(@"hh\:mm\:ss");
        row.SubItems[1].Text = value.status == "running" && (DateTime.UtcNow - activitySeen[value.id]).TotalSeconds > 20 ? "Waiting for progress update" : ActivityStatus(value);
      }
      activitySummary.Text = active > 0 ? active + (active == 1 ? " task running" : " tasks running") : taskActivity.Items.Count > 0 ? "No tasks running" : "Waiting for requests";
      activityProgress.MarqueeAnimationSpeed = active > 0 ? 35 : 0;
    }
    void ShowActivityDetails() {
      openTaskWorkspace.Enabled = taskActivity.SelectedItems.Count > 0;
      if (!openTaskWorkspace.Enabled) return;
      var value = (ManagerActivityEvent)taskActivity.SelectedItems[0].Tag;
      activityDetails.Text = "Workspace: " + value.workspace + "\n" + ActivityStatus(value) + (value.exitCode.HasValue ? " · Exit code: " + value.exitCode : "") + (value.files.HasValue ? " · Files created or changed: " + value.files : "");
    }
    void InterruptActivity() {
      foreach (var value in activityJobs.Values) if (value.status == "running") {
        value.elapsedMs += Math.Max(0, (long)(DateTime.UtcNow - activitySeen[value.id]).TotalMilliseconds); value.status = "interrupted";
      }
      RefreshActivityTimes(); ShowActivityDetails();
    }
  }
}
