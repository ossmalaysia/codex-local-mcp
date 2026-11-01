using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CodexLocalMCP {
  public sealed class Settings {
    public string Workspace { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexMCPWorkspaces");
    public string Username { get; set; } = "admin";
    public string Password { get; set; } = "";
    public string Tunnel { get; set; } = "quick";
    public string TunnelToken { get; set; } = "";
    public string PublicUrl { get; set; } = "";
    public string Backend { get; set; } = "mxc";
    public bool Network { get; set; } = false;
    public int Port { get; set; } = 3000;
  }

  static class Store {
    public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexLocalMCPData");
    static readonly string FileName = Path.Combine(Root, "settings.json");
    public static string Protect(string text) => Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(text), null, DataProtectionScope.CurrentUser));
    public static string Unprotect(string text) => string.IsNullOrEmpty(text) ? "" : Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(text), null, DataProtectionScope.CurrentUser));
    public static Settings Load() => File.Exists(FileName) ? new JavaScriptSerializer().Deserialize<Settings>(File.ReadAllText(FileName)) : new Settings();
    public static void Save(Settings settings) {
      Directory.CreateDirectory(Root);
      var identity = WindowsIdentity.GetCurrent().User;
      var acl = new DirectorySecurity();
      acl.SetAccessRuleProtection(true, false);
      acl.SetOwner(identity);
      acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      new DirectoryInfo(Root).SetAccessControl(acl);
      var temporary = FileName + ".new";
      File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(settings), new UTF8Encoding(false));
      if (File.Exists(FileName)) File.Replace(temporary, FileName, null); else File.Move(temporary, FileName);
      Directory.CreateDirectory(Path.Combine(Root, "codex-home"));
    }
    static bool Within(string path, string root) => path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    public static void Validate(Settings value, string installRoot) {
      if (!Path.IsPathRooted(value.Workspace) || value.Workspace.StartsWith(@"\\")) throw new Exception("Choose an absolute local workspace path.");
      var workspace = Path.GetFullPath(value.Workspace).TrimEnd('\\');
      if (workspace == Path.GetPathRoot(workspace).TrimEnd('\\') || Within(Root, workspace) || Within(workspace, Root) || Within(installRoot, workspace) || Within(workspace, installRoot))
        throw new Exception("The workspace must be separate from installation files, credentials, and drive roots.");
      if (string.IsNullOrWhiteSpace(value.Username)) throw new Exception("Enter an administrator username.");
      var password = Unprotect(value.Password);
      if (password.Length < 24 || Encoding.UTF8.GetByteCount(password) > 1024) throw new Exception("Use a password with at least 24 characters and at most 1024 UTF-8 bytes.");
      if (value.Backend != "mxc" && value.Backend != "elevated") throw new Exception("Select MXC or the elevated Windows sandbox.");
      if (value.Tunnel != "quick" && value.Tunnel != "named") throw new Exception("Select a tunnel mode.");
      if (value.Port < 1024 || value.Port > 65535) throw new Exception("Use a listener port between 1024 and 65535.");
      if (value.Tunnel == "named") {
        Uri url;
        if (!Uri.TryCreate(value.PublicUrl, UriKind.Absolute, out url) || url.Scheme != "https" || url.AbsolutePath != "/" || url.Query != "" || url.Fragment != "" || url.UserInfo != "")
          throw new Exception("Enter the named tunnel HTTPS origin without a path.");
        if (string.IsNullOrWhiteSpace(Unprotect(value.TunnelToken))) throw new Exception("Enter the Cloudflare tunnel token.");
      }
      value.Workspace = workspace;
    }
  }

  static class Program {
    [STAThread] static int Main(string[] args) {
      if (args.Contains("--self-test")) {
        try {
          const string secret = "self-test-only-secret";
          if (Store.Unprotect(Store.Protect(secret)) != secret) return 1;
          var version = FileVersionInfo.GetVersionInfo(Application.ExecutablePath).ProductVersion;
          if (string.IsNullOrEmpty(version) || version.StartsWith("0.0.0")) return 2;
          Console.WriteLine("Manager self-test passed: DPAPI encryption and release version."); return 0;
        } catch { return 3; }
      }
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      if (args.Length == 2 && args[0] == "--render-preview") {
        using (var window = new Manager()) {
          window.ShowInTaskbar = false; window.StartPosition = FormStartPosition.Manual; window.Location = new Point(-32000, -32000);
          window.Show(); Application.DoEvents(); window.PerformLayout();
          using (var bitmap = new Bitmap(window.Width, window.Height)) {
            window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, window.Size)); bitmap.Save(args[1], System.Drawing.Imaging.ImageFormat.Png);
          }
          window.Close();
        }
        return 0;
      }
      try { Application.Run(new Manager()); return 0; }
      catch (Exception error) { MessageBox.Show(error.Message, "Codex Local MCP", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
  }

  sealed class Manager : Form {
    readonly string installRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    Settings saved = Store.Load();
    readonly TextBox workspace = new TextBox(), username = new TextBox(), password = new TextBox { UseSystemPasswordChar = true }, token = new TextBox { UseSystemPasswordChar = true }, publicUrl = new TextBox();
    readonly ComboBox backend = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList }, tunnel = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly CheckBox network = new CheckBox { Text = "Allow network access from Codex commands", AutoSize = true };
    readonly NumericUpDown port = new NumericUpDown { Minimum = 1024, Maximum = 65535 };
    readonly RichTextBox log = new RichTextBox { ReadOnly = true, Dock = DockStyle.Fill, WordWrap = true, DetectUrls = true };
    readonly Button start = new Button { Text = "Start tunnel", AutoSize = true }, stop = new Button { Text = "Stop", AutoSize = true, Enabled = false };
    Process server;
    bool busy;

    public Manager() {
      var version = FileVersionInfo.GetVersionInfo(Application.ExecutablePath).ProductVersion.Split('+')[0];
      Text = "Codex Local MCP " + version; Size = new Size(900, 780); MinimumSize = new Size(760, 700); StartPosition = FormStartPosition.CenterScreen;
      Font = new Font("Segoe UI", 9F); AutoScaleMode = AutoScaleMode.Dpi;
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 2, RowCount = 15 };
      layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
      Controls.Add(layout);
      Add(layout, "Version", new Label { Text = version + " / Windows x64 / isolated execution", AutoSize = true });
      Add(layout, "Workspace folder", workspace);
      Add(layout, "MCP username", username);
      Add(layout, "MCP password", password);
      Add(layout, "Windows sandbox", backend); backend.Items.AddRange(new object[] { "MXC (recommended)", "Elevated (legacy, setup may require administrator access)" });
      Add(layout, "Command networking", network);
      Add(layout, "Cloudflare Tunnel", tunnel); tunnel.Items.AddRange(new object[] { "Quick Tunnel (temporary URL)", "Named Tunnel (stable hostname and token)" });
      Add(layout, "Named HTTPS origin", publicUrl);
      Add(layout, "Named tunnel token", token);
      Add(layout, "Local listener port", port);
      var note = new Label { AutoSize = true, MaximumSize = new Size(630, 0), Text = "Codex commands can write in the selected workspace. Other files are denied except required runtime files. Start checks this policy first. MXC requires a compatible Windows device. Passwords and tokens use Windows DPAPI. Leave password fields blank to keep saved values." };
      Add(layout, "Isolation and login", note);
      var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
      var save = new Button { Text = "Save settings", AutoSize = true };
      var login = new Button { Text = "Sign in to Codex", AutoSize = true };
      var check = new Button { Text = "Check sandbox", AutoSize = true };
      actions.Controls.AddRange(new Control[] { save, login, check, start, stop });
      Add(layout, "Actions", actions);
      Add(layout, "Status", log);
      workspace.Text = saved.Workspace; username.Text = saved.Username; network.Checked = saved.Network;
      backend.SelectedIndex = saved.Backend == "elevated" ? 1 : 0; tunnel.SelectedIndex = saved.Tunnel == "named" ? 1 : 0;
      publicUrl.Text = saved.PublicUrl; port.Value = Math.Max(1024, Math.Min(65535, saved.Port));
      tunnel.SelectedIndexChanged += (s, e) => { publicUrl.Enabled = token.Enabled = tunnel.SelectedIndex == 1; };
      publicUrl.Enabled = token.Enabled = tunnel.SelectedIndex == 1;
      save.Click += (s, e) => Guard(() => { Save(); Write("Settings saved for this Windows user."); });
      login.Click += (s, e) => Guard(() => {
        Save(); var info = Info(Path.Combine(installRoot, "runtime", "codex", "codex.exe"), "login", false);
        info.EnvironmentVariables.Remove("CODEX_MCP_PASSWORD"); info.EnvironmentVariables.Remove("CODEX_MCP_TUNNEL_TOKEN");
        info.CreateNoWindow = false; Process.Start(info); Write("Complete Codex login in the opened terminal or browser.");
      });
      check.Click += async (s, e) => await Operation(async () => { Save(); await CheckSandbox(); });
      start.Click += async (s, e) => await Operation(StartServer);
      stop.Click += async (s, e) => await StopServer();
      FormClosing += async (s, e) => {
        if (busy) { e.Cancel = true; Write("Wait for the current check to finish before closing."); return; }
        if (server != null && !server.HasExited) { e.Cancel = true; await StopServer(); Close(); }
      };
      Write("1. Save your settings. 2. Sign in to Codex. 3. Start the tunnel. Copy the printed MCP URL into Claude.");
      Write("A named tunnel must route its hostname to http://127.0.0.1:" + saved.Port + " in Cloudflare.");
    }
    static void Add(TableLayoutPanel panel, string text, Control control) {
      int row = panel.Controls.Count / 2;
      panel.Controls.Add(new Label { Text = text, AutoSize = true, Padding = new Padding(0, 5, 0, 5) }, 0, row);
      control.Dock = DockStyle.Fill; control.Margin = new Padding(3, 4, 3, 4); panel.Controls.Add(control, 1, row);
      panel.RowStyles.Add(new RowStyle(row == 12 ? SizeType.Percent : SizeType.AutoSize, row == 12 ? 100 : 0));
    }
    void Save() {
      if (server != null && !server.HasExited) throw new Exception("Stop the server before changing settings.");
      var next = new Settings { Workspace = workspace.Text.Trim(), Username = username.Text.Trim(), Backend = backend.SelectedIndex == 1 ? "elevated" : "mxc",
        Tunnel = tunnel.SelectedIndex == 1 ? "named" : "quick", PublicUrl = publicUrl.Text.Trim(), Network = network.Checked, Port = (int)port.Value,
        Password = password.Text.Length > 0 ? Store.Protect(password.Text) : saved.Password,
        TunnelToken = token.Text.Length > 0 ? Store.Protect(token.Text) : saved.TunnelToken };
      Store.Validate(next, installRoot); Store.Save(next); saved = next; password.Clear(); token.Clear();
    }
    void Guard(Action action) { try { if (busy) throw new Exception("Wait for the current check to finish."); if (server != null && !server.HasExited) throw new Exception("Stop the server before changing settings."); action(); } catch (Exception error) { MessageBox.Show(this, error.Message, "Codex Local MCP", MessageBoxButtons.OK, MessageBoxIcon.Error); } }
    async Task Operation(Func<Task> action) {
      if (busy) return; busy = true; start.Enabled = false;
      try { await action(); } catch (Exception error) { Write(error.Message); MessageBox.Show(this, error.Message, "Codex Local MCP", MessageBoxButtons.OK, MessageBoxIcon.Error); }
      finally { busy = false; start.Enabled = server == null || server.HasExited; }
    }
    ProcessStartInfo Info(string executable, string arguments, bool capture) {
      var info = new ProcessStartInfo(executable, arguments) { WorkingDirectory = installRoot, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = capture, RedirectStandardError = capture, RedirectStandardInput = capture };
      var inherited = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (string key in info.EnvironmentVariables.Keys) inherited[key] = info.EnvironmentVariables[key];
      info.EnvironmentVariables.Clear();
      foreach (var key in new[] { "SystemRoot", "WINDIR", "ComSpec", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData" })
        if (inherited.ContainsKey(key)) info.EnvironmentVariables[key] = inherited[key];
      info.EnvironmentVariables["PATH"] = Path.Combine(installRoot, "runtime", "node") + ";" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32");
      info.EnvironmentVariables["NODE_OPTIONS"] = "--preserve-symlinks --preserve-symlinks-main";
      info.EnvironmentVariables["CODEX_BIN"] = Path.Combine(installRoot, "runtime", "codex", "codex.exe");
      info.EnvironmentVariables["CODEX_HOME"] = Path.Combine(Store.Root, "codex-home");
      info.EnvironmentVariables["CODEX_MCP_ROOT"] = saved.Workspace;
      info.EnvironmentVariables["CODEX_SANDBOX_MODE"] = "isolated";
      info.EnvironmentVariables["CODEX_WINDOWS_SANDBOX"] = saved.Backend;
      info.EnvironmentVariables["CODEX_NETWORK_ACCESS"] = saved.Network ? "true" : "false";
      info.EnvironmentVariables["CODEX_RUNTIME_ROOT"] = installRoot;
      info.EnvironmentVariables["CODEX_PRIVATE_ROOT"] = Store.Root;
      info.EnvironmentVariables["CODEX_MCP_TRANSPORT"] = "http";
      info.EnvironmentVariables["CODEX_MCP_HOST"] = "127.0.0.1";
      info.EnvironmentVariables["CODEX_MCP_PORT"] = saved.Port.ToString();
      info.EnvironmentVariables["CODEX_MCP_USERNAME"] = saved.Username;
      info.EnvironmentVariables["CODEX_MCP_PASSWORD"] = Store.Unprotect(saved.Password);
      info.EnvironmentVariables["CODEX_MCP_TUNNEL"] = saved.Tunnel;
      info.EnvironmentVariables["CODEX_MCP_PUBLIC_URL"] = saved.Tunnel == "named" ? saved.PublicUrl : "http://127.0.0.1:" + saved.Port;
      info.EnvironmentVariables["CODEX_MCP_TUNNEL_TOKEN"] = Store.Unprotect(saved.TunnelToken);
      info.EnvironmentVariables["CLOUDFLARED_BIN"] = Path.Combine(installRoot, "runtime", "cloudflared.exe");
      return info;
    }
    static string Quote(string path) => "\"" + path.Replace("\"", "") + "\"";
    string Node => Path.Combine(installRoot, "runtime", "node", "node.exe");
    string Script(string name) => Quote(Path.Combine(installRoot, "app", "dist", name));
    async Task CheckSandbox() {
      Write("Checking real Windows sandbox isolation. This does not call an AI model.");
      var info = Info(Node, Script("sandbox-probe.js"), true);
      info.EnvironmentVariables.Remove("CODEX_MCP_PASSWORD"); info.EnvironmentVariables.Remove("CODEX_MCP_TUNNEL_TOKEN");
      using (var process = Process.Start(info)) {
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        if (!await Task.Run(() => process.WaitForExit(45000))) { KillTree(process); throw new Exception("Sandbox check timed out. Startup is blocked."); }
        var result = await stdout; var errors = await stderr; Write(result); Write(errors);
        if (process.ExitCode != 0 || !result.Contains("\"passed\":true")) throw new Exception("Sandbox check failed. Startup is blocked. Select a supported Windows backend and check the status output.");
      }
      Write("Sandbox passed: workspace writes, denied private reads and writes, and configured networking.");
    }
    async Task StartServer() {
      if (server != null && !server.HasExited) return;
      Save(); await CheckSandbox();
      var info = Info(Node, Script("index.js") + " --tunnel --managed", true);
      server = new Process { StartInfo = info, EnableRaisingEvents = true };
      server.OutputDataReceived += (s, e) => { if (e.Data != null) Write(e.Data); };
      server.ErrorDataReceived += (s, e) => { if (e.Data != null) Write(e.Data); };
      server.Exited += (s, e) => { if (!IsDisposed) BeginInvoke(new Action(() => { start.Enabled = true; stop.Enabled = false; Write("Server stopped."); })); };
      server.Start(); server.BeginOutputReadLine(); server.BeginErrorReadLine(); stop.Enabled = true;
    }
    async Task StopServer() {
      var process = server;
      if (process == null) return;
      if (!process.HasExited) {
        try { process.StandardInput.WriteLine("stop"); process.StandardInput.Flush(); } catch { }
        if (!await Task.Run(() => process.WaitForExit(5000))) KillTree(process);
      }
      process.Dispose(); server = null; start.Enabled = true; stop.Enabled = false;
    }
    static void KillTree(Process process) {
      using (var killer = Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "taskkill.exe"), "/PID " + process.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true })) killer.WaitForExit(10000);
    }
    void Write(string text) {
      if (string.IsNullOrEmpty(text) || IsDisposed) return;
      if (InvokeRequired) { BeginInvoke(new Action<string>(Write), text); return; }
      foreach (var secret in new[] { saved.Password, saved.TunnelToken }) if (!string.IsNullOrEmpty(secret)) {
        var plaintext = Store.Unprotect(secret); if (plaintext.Length > 0) text = text.Replace(plaintext, "[redacted]");
      }
      log.AppendText(text.TrimEnd() + Environment.NewLine); if (log.TextLength > 50000) log.Text = log.Text.Substring(log.TextLength - 40000);
      log.SelectionStart = log.TextLength; log.ScrollToCaret();
    }
  }
}
