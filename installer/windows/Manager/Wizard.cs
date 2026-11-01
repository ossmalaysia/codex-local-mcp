using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexLocalMCP {
  sealed partial class Manager {
    static readonly Color Ink = Color.FromArgb(27, 35, 49);
    static readonly Color Muted = Color.FromArgb(92, 105, 124);
    static readonly Color Accent = Color.FromArgb(77, 70, 215);
    static readonly Color Canvas = Color.FromArgb(246, 247, 251);
    readonly Button login = new Button(), check = new Button();
    readonly Button back = new Button(), next = new Button(), copyUrl = new Button();
    readonly Button[] navigation = new Button[4];
    readonly Panel[] pages = new Panel[4];
    readonly Label state = new Label(), accountState = new Label(), progress = new Label(), passwordState = new Label(), tunnelHint = Copy(" ", 9);
    readonly TextBox endpoint = new TextBox { ReadOnly = true };
    readonly Label endpointHint = Copy("Start the connection in step 3 to get your URL.", 9);
    bool endpointConnected;
    readonly FlowLayoutPanel namedFields = new FlowLayoutPanel();
    readonly ToolTip tips = new ToolTip();
    FlowLayoutPanel sidebarFooter;
    int currentStep;

    static Label Copy(string text, float size = 10, bool bold = false) => new Label {
      Text = text, AutoSize = true, MaximumSize = new Size(650, 0), ForeColor = bold ? Ink : Muted,
      Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular), Margin = new Padding(0, 0, 0, 12)
    };
    static Button Style(Button button, string text, bool primary = false) {
      button.Text = text; button.AutoSize = true; button.MinimumSize = new Size(104, 40);
      button.Padding = new Padding(12, 5, 12, 5); button.FlatStyle = FlatStyle.Flat;
      button.FlatAppearance.BorderSize = primary ? 0 : 1;
      button.FlatAppearance.BorderColor = Color.FromArgb(216, 220, 232);
      button.BackColor = primary ? Accent : Color.White; button.ForeColor = primary ? Color.White : Ink;
      button.EnabledChanged += (s, e) => { button.BackColor = button.Enabled ? (primary ? Accent : Color.White) : Canvas; button.ForeColor = button.Enabled ? (primary ? Color.White : Ink) : Muted; };
      button.Cursor = Cursors.Hand; button.Margin = new Padding(0, 0, 10, 8); return button;
    }
    static FlowLayoutPanel Stack() => new FlowLayoutPanel {
      Dock = DockStyle.Top, FlowDirection = FlowDirection.TopDown, WrapContents = false,
      AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty
    };
    static FlowLayoutPanel Row(params Control[] controls) {
      var row = new FlowLayoutPanel { AutoSize = true, WrapContents = true, Margin = new Padding(0, 0, 0, 10), MaximumSize = new Size(670, 0) };
      row.Controls.AddRange(controls); return row;
    }
    static void Field(FlowLayoutPanel panel, string title, Control input, string hint = null) {
      var label = Copy(title, 10, true); label.Margin = new Padding(0, 8, 0, 6); panel.Controls.Add(label);
      input.Width = 620; input.Font = new Font("Segoe UI", 11); input.Margin = new Padding(0, 0, 0, 8);
      input.AccessibleName = title; input.AccessibleDescription = hint;
      panel.Controls.Add(input);
      if (hint != null) panel.Controls.Add(Copy(hint, 9));
    }
    FlowLayoutPanel Page(int index, string kicker, string title, string description) {
      var page = new Panel { Dock = DockStyle.Fill, AutoScroll = true, BackColor = Color.White, Padding = new Padding(30, 24, 24, 16) };
      var stack = Stack(); page.Controls.Add(stack);
      page.SizeChanged += (s, e) => FitPage(page, stack);
      var tag = Copy(kicker, 9, true); tag.ForeColor = Accent; stack.Controls.Add(tag);
      stack.Controls.Add(Copy(title, 24, true)); stack.Controls.Add(Copy(description));
      pages[index] = page; return stack;
    }
    void BuildInterface(string version) {
      Text = "Codex Local MCP " + version; ClientSize = new Size(1050, 740); MinimumSize = new Size(880, 620);
      StartPosition = FormStartPosition.CenterScreen; BackColor = Canvas; ForeColor = Ink;
      Font = new Font("Segoe UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
      AutoScaleDimensions = new SizeF(96, 96);
      Icon = Icon.ExtractAssociatedIcon(typeof(Manager).Assembly.Location);
      var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Canvas };
      shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 245)); shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
      Controls.Add(shell);
      var sidebar = new Panel { Dock = DockStyle.Fill, Padding = new Padding(22, 30, 18, 24), BackColor = Canvas };
      shell.Controls.Add(sidebar, 0, 0);
      var rail = Stack(); sidebar.Controls.Add(rail);
      using (var asset = typeof(Manager).Assembly.GetManifestResourceStream("CodexLocalMCP.logo.png"))
      using (var original = Image.FromStream(asset))
        rail.Controls.Add(new PictureBox { Image = new Bitmap(original), Size = new Size(52, 52), SizeMode = PictureBoxSizeMode.Zoom, Margin = new Padding(0, 0, 0, 16) });
      rail.Controls.Add(Copy("Codex Local MCP", 16, true));
      rail.Controls.Add(Copy("Your PC. Connected to Claude.", 9));
      var divider = Copy("SETUP", 9, true); divider.Margin = new Padding(0, 26, 0, 14); rail.Controls.Add(divider);
      var names = new[] { "1   Workspace", "2   Accounts", "3   Connection", "4   Use in Claude" };
      for (int i = 0; i < names.Length; i++) {
        int step = i; var button = Style(new Button(), names[i]); button.Width = 200;
        button.TextAlign = ContentAlignment.MiddleLeft; button.FlatAppearance.BorderSize = 0;
        button.Click += (s, e) => ShowStep(step); navigation[i] = button; rail.Controls.Add(button);
      }
      var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
      sidebarFooter = bottom;
      state.Text = "Not connected"; state.AutoSize = true; state.ForeColor = Muted; state.MaximumSize = new Size(200, 0);
      var activity = new LinkLabel { Text = "View activity", AutoSize = true, LinkColor = Accent, Margin = new Padding(0, 10, 0, 12) };
      activity.LinkClicked += (s, e) => { ShowStep(3); log.Visible = true; };
      bottom.Controls.Add(state); bottom.Controls.Add(activity); bottom.Controls.Add(Copy("v" + version + "  /  Windows x64", 9)); sidebar.Controls.Add(bottom);
      var main = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, Margin = new Padding(0), BackColor = Color.White };
      main.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); main.RowStyles.Add(new RowStyle(SizeType.Absolute, 78)); shell.Controls.Add(main, 1, 0);
      var host = new Panel { Dock = DockStyle.Fill }; main.Controls.Add(host, 0, 0);

      var work = Page(0, "STEP 1 OF 4", "Choose a place to work", "Codex will read and edit files inside this folder.");
      Field(work, "Workspace folder", workspace, "Use a dedicated local folder. Keep credentials outside this folder.");
      var browse = Style(new Button(), "Choose folder…");
      browse.Click += (s, e) => { using (var picker = new FolderBrowserDialog { Description = "Choose the workspace Codex can use", SelectedPath = workspace.Text, ShowNewFolderButton = true }) if (picker.ShowDialog(this) == DialogResult.OK) workspace.Text = picker.SelectedPath; };
      work.Controls.Add(Row(browse));
      work.Controls.Add(Copy("Isolation is checked before every start", 13, true));
      work.Controls.Add(Copy("The app tests workspace access and blocks access to private application files before it opens a remote connection."));
      work.Controls.Add(Copy("Recommended defaults: MXC isolation, with network access disabled for Codex commands.", 9));

      var accounts = Page(1, "STEP 2 OF 4", "Set up your accounts", "Use one login for the MCP connection and another for OpenAI.");
      Field(accounts, "MCP username", username);
      Field(accounts, "MCP password", password, "Use at least 24 characters. Leave blank to keep a saved password.");
      passwordState.AutoSize = true; passwordState.Margin = new Padding(0, 0, 0, 12);
      password.TextChanged += (s, e) => UpdatePasswordHint(); UpdatePasswordHint(); accounts.Controls.Add(passwordState);
      var generate = Style(new Button(), "Generate password");
      generate.Click += (s, e) => Guard(() => { var bytes = new byte[24]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); password.Text = Convert.ToBase64String(bytes); Write("New password generated. Copy it before continuing."); });
      var copyPassword = Style(new Button(), "Copy password");
      generate.AccessibleDescription = "Creates a random 32-character MCP password. Copy it before continuing.";
      copyPassword.Click += (s, e) => { try { var value = password.Text.Length > 0 ? password.Text : Store.Unprotect(saved.Password); if (value.Length == 0) throw new Exception("Enter or generate a password first."); Clipboard.SetText(value); passwordState.Text = "Password copied. Store it in your password manager."; } catch (Exception error) { passwordState.Text = error.Message; } };
      var show = new CheckBox { Text = "Show password", AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
      show.CheckedChanged += (s, e) => password.UseSystemPasswordChar = !show.Checked;
      accounts.Controls.Add(Row(generate, copyPassword, show));
      accounts.Controls.Add(Copy("OpenAI account", 13, true));
      accounts.Controls.Add(Copy("The app checks its saved OpenAI sign-in. You can keep the current account.", 9));
      accounts.Controls.Add(Row(Style(login, "Sign in to OpenAI", true), Style(refreshAccount, "Refresh status")));
      refreshAccount.Click += async (s, e) => { if (!busy) await RefreshAccount(); };
      accountState.AutoSize = true; accountState.MaximumSize = new Size(620, 0); accountState.ForeColor = Muted;
      accountState.Text = "Checking OpenAI sign-in…"; accounts.Controls.Add(accountState);

      var connection = Page(2, "STEP 3 OF 4", "Bring your workspace online", "Cloudflare provides an HTTPS connection from Claude to this PC.");
      tunnel.Items.AddRange(new object[] { "Quick Tunnel · no Cloudflare account needed", "Named Tunnel · permanent hostname" });
      Field(connection, "Connection type", tunnel); connection.Controls.Add(tunnelHint);
      namedFields.FlowDirection = FlowDirection.TopDown; namedFields.WrapContents = false; namedFields.AutoSize = true; namedFields.Margin = Padding.Empty;
      BuildCloudflareFields(namedFields);
      var manualToggle = Style(new Button(), "Use an existing tunnel");
      var manual = Stack(); manual.Visible = false;
      Field(manual, "Named HTTPS origin", publicUrl, "Example: https://codex.example.com");
      Field(manual, "Named tunnel token", token, "For an existing tunnel only. Leave blank to keep the saved token.");
      manual.Controls.Add(Copy("For manual setup, route this hostname to http://127.0.0.1:<listener port> in Cloudflare.", 9));
      manualToggle.Click += (s, e) => { manual.Visible = !manual.Visible; manualToggle.Text = manual.Visible ? "Hide existing tunnel settings" : "Use an existing tunnel"; };
      namedFields.Controls.Add(Row(manualToggle)); namedFields.Controls.Add(manual); connection.Controls.Add(namedFields);
      var advancedToggle = Style(new Button(), "Advanced settings");
      var advanced = Stack(); advanced.Visible = false;
      backend.Items.AddRange(new object[] { "MXC (recommended)", "Elevated (legacy; administrator setup may be needed)" });
      Field(advanced, "Windows sandbox", backend);
      advanced.Controls.Add(network); network.Margin = new Padding(0, 8, 0, 12);
      Field(advanced, "Local listener port", port);
      advancedToggle.Click += (s, e) => { advanced.Visible = !advanced.Visible; advancedToggle.Text = advanced.Visible ? "Hide advanced settings" : "Advanced settings"; };
      connection.Controls.Add(Row(advancedToggle)); connection.Controls.Add(advanced);
      connection.Controls.Add(Row(Style(start, "Start connection", true), Style(stop, "Stop"), Style(check, "Check sandbox")));
      connection.Controls.Add(Copy("Start saves your settings, tests isolation, and opens the tunnel.", 9));

      var use = Page(3, "STEP 4 OF 4", "Connect Claude", "Use this remote connection alongside your existing Claude plugins.");
      Field(use, "Your MCP server URL", endpoint); use.Controls.Add(endpointHint);
      Style(copyUrl, "Copy URL", true); copyUrl.Enabled = false;
      copyUrl.Click += (s, e) => { if (endpoint.Text.Length > 0) { try { Clipboard.SetText(endpoint.Text); Write("MCP URL copied."); } catch { Write("Clipboard is unavailable. Select the URL and copy it manually."); } } };
      use.Controls.Add(Row(copyUrl));
      use.Controls.Add(Copy("1. Open Claude Settings → Connectors.", 11, true));
      use.Controls.Add(Copy("2. Add a custom connector and paste this URL.", 11, true));
      use.Controls.Add(Copy("3. Connect, then enter your MCP username and password.", 11, true));
      use.Controls.Add(Copy("Keep this app open and this PC awake while Claude uses the connection.", 9));
      var showLogs = Style(new Button(), "Show activity");
      log.Width = 620; log.Height = 140; log.Dock = DockStyle.None; log.BorderStyle = BorderStyle.FixedSingle; log.BackColor = Canvas;
      log.Font = new Font("Consolas", 9); log.Visible = false;
      showLogs.Click += (s, e) => { log.Visible = !log.Visible; showLogs.Text = log.Visible ? "Hide activity" : "Show activity"; };
      use.Controls.Add(Row(showLogs)); use.Controls.Add(log);
      foreach (var page in pages) host.Controls.Add(page);

      var footer = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26, 12, 24, 8), ColumnCount = 3 };
      footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
      Style(back, "Back"); Style(next, "Continue", true); progress.AutoSize = true; progress.ForeColor = Muted; progress.Margin = new Padding(12, 12, 0, 0);
      footer.Controls.Add(back, 0, 0); footer.Controls.Add(progress, 1, 0); footer.Controls.Add(next, 2, 0); main.Controls.Add(footer, 0, 1);
      back.Click += (s, e) => ShowStep(currentStep - 1);
      next.Click += (s, e) => {
        if (currentStep == 2) { ShowStep(3); return; }
        Guard(() => { if (currentStep == 0) Store.ValidateWorkspace(workspace.Text.Trim(), installRoot); else Save(); ShowStep(currentStep + 1); });
      };
      tips.SetToolTip(copyPassword, "The password stays on your clipboard until you replace or clear it.");
      ShowStep(0);
    }
    void ShowStep(int index) {
      currentStep = Math.Max(0, Math.Min(3, index));
      for (int i = 0; i < pages.Length; i++) { pages[i].Visible = i == currentStep; navigation[i].BackColor = i == currentStep ? Color.FromArgb(231, 230, 253) : Canvas; navigation[i].ForeColor = i == currentStep ? Accent : Muted; navigation[i].AccessibleDescription = i == currentStep ? "Current setup step" : "Open setup step " + (i + 1); }
      pages[currentStep].BringToFront(); back.Enabled = currentStep > 0; next.Visible = currentStep < 3;
      next.Text = currentStep == 2 ? "Open Claude guide" : "Continue"; progress.Text = "Step " + (currentStep + 1) + " of 4";
      AcceptButton = currentStep == 3 ? copyUrl : currentStep == 2 ? start : next;
    }
    internal void PreviewStep(int index) { ShowStep(index); }
    static void FitPage(Panel page, FlowLayoutPanel stack) {
      int width = Math.Max(280, Math.Min(650, page.ClientSize.Width - page.Padding.Horizontal - SystemInformation.VerticalScrollBarWidth - 4));
      FitControls(stack, width);
    }
    static void FitControls(Control container, int width) {
      foreach (Control control in container.Controls) {
        if (control is TextBox || control is RichTextBox || control is ComboBox || control is NumericUpDown) control.Width = width;
        if (control is Label || control is FlowLayoutPanel) control.MaximumSize = new Size(width, 0);
        if (control is Panel) FitControls(control, width);
      }
    }
    void UpdatePasswordHint() {
      bool stored = password.Text.Length == 0 && saved.Password.Length > 0;
      bool valid = stored || password.Text.Length >= 24;
      passwordState.Text = stored ? "Password saved. You do not need to enter it again." : password.Text.Length == 0 ? "Enter a password or generate one below." : valid ? "New password ready. Select Continue to save it." : "Add " + (24 - password.Text.Length) + " more characters.";
      passwordState.ForeColor = valid ? Color.FromArgb(25, 116, 85) : Muted;
    }
    void UpdateTunnelFields() { namedFields.Visible = tunnel.SelectedIndex == 1; tunnelHint.Text = tunnel.SelectedIndex == 1 ? "Use a stable hostname from your Cloudflare account." : "Quick Tunnel creates a new URL each time you start it."; UpdateEndpointPreview(); }
    void UpdateEndpointPreview() {
      if (endpointConnected) return;
      Uri origin;
      if (tunnel.SelectedIndex == 1 && Uri.TryCreate(publicUrl.Text.Trim(), UriKind.Absolute, out origin) && origin.Scheme == "https" && origin.AbsolutePath == "/" && origin.UserInfo == "" && origin.Query == "" && origin.Fragment == "") {
        endpoint.Text = new Uri(origin, "/mcp").AbsoluteUri;
        endpointHint.Text = "Configured address. Start the connection in step 3 before using it in Claude.";
        copyUrl.Enabled = true;
      } else {
        endpoint.Clear(); copyUrl.Enabled = false;
        endpointHint.Text = tunnel.SelectedIndex == 1 ? "Configure your hostname in step 3 to see its MCP URL." : "Start the connection in step 3 to get your URL.";
      }
    }
    async Task SignIn() {
      if (server != null && !server.HasExited) throw new Exception("Stop the connection before changing the OpenAI account.");
      accountState.Text = "Complete sign-in in the opened terminal or browser.";
      Store.EnsurePrivateRoot();
      var info = AccountStatus.Info(Path.Combine(installRoot, "runtime", "codex", "codex.exe"), Path.Combine(Store.Root, "codex-home"), false);
      using (var process = Process.Start(info)) {
        await Task.Run(() => process.WaitForExit());
        if (process.ExitCode != 0) throw new Exception("Codex sign-in did not finish. Select Sign in to Codex to try again.");
      }
      await RefreshAccount();
      Write("Codex sign-in completed.");
    }
    void ConnectionStatus(string message, bool connected = false) {
      endpointConnected = connected;
      state.Text = message; state.ForeColor = connected ? Color.FromArgb(25, 116, 85) : Muted;
      state.AccessibleName = "Connection status: " + message;
      if (trayStatus != null) trayStatus.Text = message;
      if (!connected) UpdateEndpointPreview();
      else endpointHint.Text = "Connection running. Copy this URL into Claude.";
    }
    void DetectEndpoint(string text) {
      if (!text.StartsWith("codex-local-mcp ready: ", StringComparison.Ordinal)) return;
      var match = Regex.Match(text, @"https://[^\s]+/mcp(?=\s|$)");
      if (!match.Success) return;
      endpoint.Text = match.Value; copyUrl.Enabled = true; ConnectionStatus("Connected · keep app open", true); ShowStep(3);
    }
  }
}
