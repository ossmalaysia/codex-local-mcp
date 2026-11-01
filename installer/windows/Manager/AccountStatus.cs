using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CodexLocalMCP {
  public sealed class OpenAiAccount {
    public bool SignedIn { get; set; }
    public string Email { get; set; }
    public string Method { get; set; }
  }
  static class AccountStatus {
    public static ProcessStartInfo Info(string executable, string home, bool capture) {
      var info = new ProcessStartInfo(executable, capture ? "app-server --stdio" : "login") {
        WorkingDirectory = Path.GetDirectoryName(executable), UseShellExecute = false, CreateNoWindow = capture,
        RedirectStandardInput = capture, RedirectStandardOutput = capture, RedirectStandardError = capture
      };
      info.EnvironmentVariables.Clear();
      foreach (var key in new[] { "SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)" }) {
        var value = Environment.GetEnvironmentVariable(key); if (value != null) info.EnvironmentVariables[key] = value;
      }
      info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(executable) + ";" + Environment.GetFolderPath(Environment.SpecialFolder.System);
      info.EnvironmentVariables["CODEX_HOME"] = home;
      return info;
    }
    public static OpenAiAccount Parse(string response) {
      var json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
      var envelope = json.DeserializeObject(response) as Dictionary<string, object>;
      object raw;
      if (envelope == null || envelope.ContainsKey("error") || !envelope.TryGetValue("result", out raw)) throw new IOException("Invalid account response.");
      var result = raw as Dictionary<string, object>;
      if (result == null || !result.TryGetValue("account", out raw)) throw new IOException("Invalid account response.");
      if (raw == null) return new OpenAiAccount();
      var account = raw as Dictionary<string, object>;
      if (account == null || !account.TryGetValue("type", out raw) || !(raw is string)) throw new IOException("Invalid account response.");
      var method = (string)raw;
      if (method != "chatgpt" && method != "apiKey") throw new IOException("Unsupported account type.");
      string email = null;
      if (method == "chatgpt" && account.TryGetValue("email", out raw) && raw != null) {
        email = raw as string;
        if (string.IsNullOrWhiteSpace(email) || email.Length > 320) throw new IOException("Invalid account email.");
        foreach (char c in email) if (char.IsControl(c)) throw new IOException("Invalid account email.");
      }
      return new OpenAiAccount { SignedIn = true, Method = method, Email = email };
    }
    public static async Task<OpenAiAccount> Read(ProcessStartInfo info, CancellationToken cancellation) {
      using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
      using (var process = new Process { StartInfo = info }) {
        deadline.CancelAfter(TimeSpan.FromSeconds(12));
        process.Start();
        Action kill = () => { try { if (!process.HasExited) process.Kill(); } catch { } };
        using (deadline.Token.Register(kill)) {
          // Never log protocol or stderr output. Account responses contain personal information.
          var errors = Task.Run(async () => {
            var buffer = new char[2048]; int count, total = 0;
            while ((count = await process.StandardError.ReadAsync(buffer, 0, buffer.Length)) > 0) {
              total += count; if (total > 262144) { kill(); return; }
            }
          });
          try {
            process.StandardInput.WriteLine("{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"codex_local_mcp\",\"version\":\"1\"}}}");
            process.StandardInput.Flush();
            var buffer = new char[2048]; var pending = new StringBuilder(); int count, total = 0;
            var json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
            while ((count = await process.StandardOutput.ReadAsync(buffer, 0, buffer.Length)) > 0) {
              total += count; if (total > 1048576) throw new IOException("Account response exceeded the limit.");
              for (int i = 0; i < count; i++) {
                if (buffer[i] != '\n') { pending.Append(buffer[i]); continue; }
                var line = pending.ToString(); pending.Clear();
                var message = json.DeserializeObject(line) as Dictionary<string, object>;
                object id;
                if (message == null || !message.TryGetValue("id", out id)) continue;
                if (id is int && (int)id == 1) {
                  if (message.ContainsKey("error")) throw new IOException("Account initialization failed.");
                  process.StandardInput.WriteLine("{\"method\":\"initialized\",\"params\":{}}");
                  process.StandardInput.WriteLine("{\"id\":2,\"method\":\"account/read\",\"params\":{\"refreshToken\":false}}");
                  process.StandardInput.Flush();
                } else if (id is int && (int)id == 2) return Parse(line);
              }
            }
            throw new IOException("Account check did not complete.");
          } finally {
            kill(); await Task.Run(() => process.WaitForExit(3000)); await errors;
          }
        }
      }
    }
  }
  sealed partial class Manager {
    readonly System.Threading.CancellationTokenSource accountLifetime = new System.Threading.CancellationTokenSource();
    readonly System.Windows.Forms.Button refreshAccount = new System.Windows.Forms.Button();
    bool checkingAccount;
    void DisplayAccount(OpenAiAccount value) {
      accountState.Text = value.SignedIn
        ? value.Method == "apiKey" ? "Already signed in with an API key. No email is available."
          : value.Email == null ? "Already signed in to OpenAI. No email is available." : "Already signed in to OpenAI as " + value.Email
        : "Not signed in to OpenAI. Sign in to enable Codex.";
      accountState.ForeColor = value.SignedIn ? System.Drawing.Color.FromArgb(25, 116, 85) : Muted;
      login.Text = value.SignedIn ? "Sign in with another account" : "Sign in to OpenAI";
    }
    async Task RefreshAccount() {
      if (checkingAccount || IsDisposed || accountLifetime.IsCancellationRequested) return;
      checkingAccount = true; refreshAccount.Enabled = false;
      accountState.Text = "Checking OpenAI sign-in…"; accountState.ForeColor = Muted;
      try {
        var info = AccountStatus.Info(Path.Combine(installRoot, "runtime", "codex", "codex.exe"), Path.Combine(Store.Root, "codex-home"), true);
        var account = await AccountStatus.Read(info, accountLifetime.Token);
        if (!IsDisposed) DisplayAccount(account);
      } catch {
        if (!IsDisposed && !accountLifetime.IsCancellationRequested) {
          accountState.Text = "Could not check OpenAI sign-in. Select Refresh status to try again.";
          accountState.ForeColor = Muted;
        }
      } finally { checkingAccount = false; if (!IsDisposed) refreshAccount.Enabled = true; }
    }
  }
}
