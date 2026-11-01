using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CodexLocalMCP {
  sealed class ReleaseInfo {
    public string Version { get; internal set; }
    public string Name { get; internal set; }
    public string Sha256 { get; internal set; }
    public string Url { get; internal set; }
    public long Size { get; internal set; }
  }

  // Trust boundary: one HTTPS GitHub repository, an exact asset name, and GitHub's asset digest.
  // No remote configuration, bearer tokens, shell commands, or client-selected download paths.
  sealed class UpdateClient : IDisposable {
    internal const string Repository = "ossmalaysia/codex-local-mcp";
    internal const long MaxBytes = 1024L * 1024 * 1024;
    internal const string Feed = "https://api.github.com/repos/" + Repository + "/releases/latest";
    readonly HttpClient http;
    internal UpdateClient() : this(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false }) { }
    internal UpdateClient(HttpMessageHandler handler) {
      http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
      http.DefaultRequestHeaders.UserAgent.ParseAdd("CodexLocalMCP-Updater");
    }
    internal static Version StableVersion(string text) {
      if (text == null || !Regex.IsMatch(text, @"^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$"))
        throw new InvalidDataException("The update version is invalid.");
      return Version.Parse(text);
    }
    static string String(IDictionary<string, object> item, string key) => item.ContainsKey(key) ? item[key] as string : null;
    internal static ReleaseInfo Parse(string json, string current) {
      var serializer = new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024, RecursionLimit = 40 };
      var item = serializer.DeserializeObject(json) as IDictionary<string, object>;
      if (item == null || !item.ContainsKey("draft") || !Equals(item["draft"], false) || !item.ContainsKey("prerelease") || !Equals(item["prerelease"], false))
        throw new InvalidDataException("Only published stable releases can update this app.");
      var tag = String(item, "tag_name");
      if (tag == null || !tag.StartsWith("v", StringComparison.Ordinal)) throw new InvalidDataException("The release tag is invalid.");
      var version = tag.Substring(1); var parsed = StableVersion(version);
      if (String(item, "html_url") != "https://github.com/" + Repository + "/releases/tag/" + tag)
        throw new InvalidDataException("The release is not from the expected repository.");
      if (parsed <= StableVersion(current)) return null;
      var assets = item.ContainsKey("assets") ? item["assets"] as IEnumerable : null;
      foreach (var extension in new[] { "zip", "msi" }) {
      var name = "CodexLocalMCP-" + version + "-windows-x64." + extension;
      var url = "https://github.com/" + Repository + "/releases/download/" + tag + "/" + name;
      if (assets != null) foreach (var raw in assets) {
        var asset = raw as IDictionary<string, object>;
        if (asset == null || String(asset, "name") != name) continue;
        var digest = String(asset, "digest");
        if (String(asset, "state") != "uploaded" || String(asset, "browser_download_url") != url ||
            digest == null || !Regex.IsMatch(digest, @"^sha256:[a-fA-F0-9]{64}$"))
          throw new InvalidDataException("The release installer has no valid GitHub SHA256 digest or download address.");
        // Reject floating point, strings, and fractional sizes from untrusted JSON.
        if (!asset.ContainsKey("size") || !(asset["size"] is int || asset["size"] is long)) throw new InvalidDataException("The installer size is invalid.");
        var size = Convert.ToInt64(asset["size"]);
        if (size <= 0 || size > MaxBytes) throw new InvalidDataException("The installer exceeds the supported size.");
        return new ReleaseInfo { Version = version, Name = name, Sha256 = digest.Substring(7).ToLowerInvariant(), Url = url, Size = size };
      }
      }
      throw new InvalidDataException("The Windows installer is not available yet. Check again after the release build finishes.");
    }
    internal async Task<ReleaseInfo> CheckAsync(string current, CancellationToken cancellation) {
      using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation)) {
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        using (var request = new HttpRequestMessage(HttpMethod.Get, Feed)) {
          request.Headers.Accept.ParseAdd("application/vnd.github+json"); request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
          using (var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)) {
            if (response.StatusCode == HttpStatusCode.NotFound) return null;
            if (response.StatusCode == HttpStatusCode.Forbidden || (int)response.StatusCode == 429) throw new IOException("GitHub has limited update checks. Try again later.");
            if (response.StatusCode != HttpStatusCode.OK) throw new IOException("GitHub could not return the latest release.");
            return Parse(Encoding.UTF8.GetString(await ReadBounded(response, 2 * 1024 * 1024, timeout.Token)), current);
          }
        }
      }
    }
    static async Task<byte[]> ReadBounded(HttpResponseMessage response, int limit, CancellationToken cancellation) {
      if (response.Content.Headers.ContentLength > limit) throw new InvalidDataException("The update response is too large.");
      using (var stream = await response.Content.ReadAsStreamAsync())
      using (var output = new MemoryStream()) {
        var buffer = new byte[16384]; int count;
        while ((count = await stream.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0) {
          if (output.Length + count > limit) throw new InvalidDataException("The update response is too large.");
          output.Write(buffer, 0, count);
        }
        return output.ToArray();
      }
    }
    internal static bool PermittedAddress(Uri address, ReleaseInfo release) {
      if (!address.IsAbsoluteUri || address.Scheme != "https" || !address.IsDefaultPort || address.UserInfo != "" || address.Fragment != "") return false;
      if (address.Host == "github.com") return address.AbsoluteUri == release.Url;
      return (address.Host == "release-assets.githubusercontent.com" || address.Host == "objects.githubusercontent.com") &&
        Regex.IsMatch(address.AbsolutePath, @"^/github-production-release-asset(?:-[a-zA-Z0-9]+)?/");
    }
    internal async Task<string> DownloadAsync(ReleaseInfo release, IProgress<int> progress, CancellationToken cancellation) {
      cancellation.ThrowIfCancellationRequested();
      Store.EnsurePrivateRoot();
      var updates = Path.Combine(Store.Root, "updates");
      if (Directory.Exists(updates) && (File.GetAttributes(updates) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("The update folder must not be a link.");
      var directory = Path.Combine(updates, Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(directory); UpdateInstaller.RequirePrivatePath(directory);
      var destination = Path.Combine(directory, release.Name); var partial = destination + ".part";
      using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation)) {
        timeout.CancelAfter(TimeSpan.FromMinutes(10)); var ct = timeout.Token;
        HttpResponseMessage response = null;
        try {
          var address = new Uri(release.Url);
          for (int redirects = 0; redirects <= 5; redirects++) {
            if (!PermittedAddress(address, release)) throw new InvalidDataException("The update redirected to an untrusted address.");
            using (var request = new HttpRequestMessage(HttpMethod.Get, address))
              response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            int status = (int)response.StatusCode;
            if (status != 301 && status != 302 && status != 303 && status != 307 && status != 308) break;
            if (redirects == 5 || response.Headers.Location == null) throw new InvalidDataException("The update returned too many redirects.");
            address = new Uri(address, response.Headers.Location); response.Dispose(); response = null;
          }
          if (response == null || response.StatusCode != HttpStatusCode.OK) throw new IOException("The update download failed. Try again.");
          if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != release.Size)
            throw new InvalidDataException("The installer size does not match the release.");
          using (var stream = await response.Content.ReadAsStreamAsync())
          using (var file = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
          using (var hash = SHA256.Create()) {
            long received = 0; var buffer = new byte[65536]; int count; int previous = -1;
            while ((count = await stream.ReadAsync(buffer, 0, buffer.Length, ct)) > 0) {
              received += count;
              if (received > release.Size) throw new InvalidDataException("The update exceeds its expected size.");
              hash.TransformBlock(buffer, 0, count, null, 0); await file.WriteAsync(buffer, 0, count, ct);
              int percent = (int)(received * 100 / release.Size);
              if (percent != previous) { progress?.Report(percent); previous = percent; }
            }
            hash.TransformFinalBlock(new byte[0], 0, 0);
            if (received != release.Size || Hex(hash.Hash) != release.Sha256) throw new InvalidDataException("The update failed SHA256 or size verification. It will not be installed.");
            await file.FlushAsync(ct); file.Flush(true); ct.ThrowIfCancellationRequested();
          }
          File.Move(partial, destination);
          await Task.Run(() => UpdateInstaller.VerifyPackage(destination, release), ct);
          return destination;
        } catch { if (File.Exists(destination)) File.Delete(destination); throw; }
        finally { response?.Dispose(); if (File.Exists(partial)) File.Delete(partial); if (Directory.Exists(directory) && Directory.GetFileSystemEntries(directory).Length == 0) Directory.Delete(directory); }
      }
    }
    internal static string Hex(byte[] bytes) => BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    public void Dispose() => http.Dispose();
  }

  static partial class UpdateInstaller {
    internal const string UpgradeCode = "{2A3FA1B7-14D8-4DC8-978B-A0404A81D823}";
    internal static string InstalledExecutable() {
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\OSS Malaysia\CodexLocalMCP")) {
        var location = key?.GetValue("InstallLocation") as string;
        if (string.IsNullOrEmpty(location) || !Path.IsPathRooted(location)) return null;
        return Path.GetFullPath(Path.Combine(location, "CodexMCP.exe"));
      }
    }
    internal static void RequirePrivatePath(string path) {
      string full = Path.GetFullPath(path); string root = Path.GetFullPath(Store.Root);
      string boundary = Path.Combine(root, "updates") + Path.DirectorySeparatorChar;
      if (!full.StartsWith(boundary, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The update must stay in the private update folder.");
      string cursor = full;
      while (cursor != null && (cursor.Equals(root, StringComparison.OrdinalIgnoreCase) || cursor.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))) {
        if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Update files and folders must not be links.");
        cursor = Path.GetDirectoryName(cursor);
      }
    }
    internal static void VerifyPackage(string path, ReleaseInfo release) {
      RequirePrivatePath(path);
      var file = new FileInfo(path);
      if (file.Length != release.Size || Path.GetFileName(path) != release.Name) throw new InvalidDataException("The update file does not match the release.");
      using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
      using (var hash = SHA256.Create()) if (UpdateClient.Hex(hash.ComputeHash(input)) != release.Sha256) throw new InvalidDataException("The update checksum changed. Download it again.");
      if (release.Name.EndsWith(".zip", StringComparison.Ordinal)) { VerifyArchive(path, release); return; }
      uint database;
      if (MsiOpenDatabase(path, IntPtr.Zero, out database) != 0) throw new InvalidDataException("The update is not a readable MSI package.");
      try {
        if (!string.Equals(Property(database, "UpgradeCode"), UpgradeCode, StringComparison.OrdinalIgnoreCase) ||
            Property(database, "ProductName") != "Codex Local MCP" || Property(database, "ProductVersion") != release.Version)
          throw new InvalidDataException("The MSI product or version does not match this app.");
      } finally { MsiCloseHandle(database); }
    }
    static string Property(uint database, string name) {
      uint view = 0, record = 0;
      try {
        if (MsiDatabaseOpenView(database, "SELECT `Value` FROM `Property` WHERE `Property`='" + name + "'", out view) != 0 ||
            MsiViewExecute(view, 0) != 0 || MsiViewFetch(view, out record) != 0) throw new InvalidDataException("The MSI metadata is invalid.");
        uint capacity = 512; var text = new StringBuilder(513);
        if (MsiRecordGetString(record, 1, text, ref capacity) != 0) throw new InvalidDataException("The MSI metadata is too large.");
        return text.ToString();
      } finally { if (record != 0) MsiCloseHandle(record); if (view != 0) MsiCloseHandle(view); }
    }
    internal static ProcessStartInfo CleanProcess(string executable, string arguments) {
      var info = new ProcessStartInfo(executable, arguments) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(executable) };
      var inherited = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (string name in info.EnvironmentVariables.Keys) inherited[name] = info.EnvironmentVariables[name];
      info.EnvironmentVariables.Clear();
      foreach (var name in new[] { "SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)" })
        if (inherited.ContainsKey(name)) info.EnvironmentVariables[name] = inherited[name];
      info.EnvironmentVariables["PATH"] = Environment.GetFolderPath(Environment.SpecialFolder.System);
      return info;
    }
    internal static string Argument(string value) {
      if (value.IndexOfAny(new[] { '"', '\r', '\n', '\0' }) >= 0) throw new InvalidDataException("The update path is invalid.");
      return "\"" + value + "\"";
    }
    internal static void Launch(string path, ReleaseInfo release) {
      var current = typeof(Manager).Assembly.Location;
      RequireTarget(current, release.Name.EndsWith(".zip", StringComparison.Ordinal));
      VerifyPackage(path, release);
      var helper = Path.Combine(Path.GetDirectoryName(path), "CodexMCP-Update.exe");
      File.Copy(current, helper, false);
      var arguments = "--install-update " + Process.GetCurrentProcess().Id + " " + release.Version + " " + Argument(path) + " " + release.Sha256 + " " + release.Size + " " + Argument(current);
      var info = CleanProcess(helper, arguments); info.CreateNoWindow = true;
      Process.Start(info);
    }
    internal static int Run(string[] args) {
      string restart = null;
      try {
        if (args.Length != 7) throw new InvalidDataException("The update handoff is invalid.");
        int parent; long size;
        if (!int.TryParse(args[1], out parent) || parent <= 0 || !long.TryParse(args[5], out size) || size <= 0 || size > UpdateClient.MaxBytes ||
            !Regex.IsMatch(args[4], "^[a-f0-9]{64}$")) throw new InvalidDataException("The update handoff is invalid.");
        UpdateClient.StableVersion(args[2]);
        bool portable = args[3].EndsWith(".zip", StringComparison.Ordinal);
        var release = new ReleaseInfo { Version = args[2], Name = "CodexLocalMCP-" + args[2] + "-windows-x64." + (portable ? "zip" : "msi"), Sha256 = args[4], Size = size };
        RequirePrivatePath(typeof(UpdateInstaller).Assembly.Location);
        restart = Path.GetFullPath(args[6]); RequireTarget(restart, portable);
        if (UpdateClient.StableVersion(FileVersionInfo.GetVersionInfo(restart).ProductVersion.Split('+')[0]) >= UpdateClient.StableVersion(release.Version))
          throw new InvalidOperationException("Updates must be newer than the installed version.");
        try { using (var previous = Process.GetProcessById(parent)) if (!previous.WaitForExit(30000)) throw new IOException("The app did not close. The update was cancelled."); }
        catch (ArgumentException) { }
        VerifyPackage(args[3], release);
        if (portable) InstallArchive(args[3], release, restart);
        else {
        var log = Path.Combine(Path.GetDirectoryName(args[3]), "install.log");
        var installer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "msiexec.exe");
        using (var process = Process.Start(CleanProcess(installer, "/i " + Argument(args[3]) + " /passive /norestart /l*v " + Argument(log)))) {
          process.WaitForExit();
          if (process.ExitCode != 0 && process.ExitCode != 3010) throw new IOException("The installer returned " + process.ExitCode + ". See " + log);
        }
        }
        if (FileVersionInfo.GetVersionInfo(restart).ProductVersion.Split('+')[0] != release.Version) throw new IOException("The installed version could not be confirmed.");
        if (portable) SetupRegistration.Refresh(Path.GetDirectoryName(restart),release,args[3]);
        File.WriteAllText(Path.Combine(Store.Root, "updates", "last-result.txt"), "Updated to " + release.Version + " at " + DateTime.UtcNow.ToString("u"));
        Process.Start(CleanProcess(restart, "")); return 0;
      } catch (Exception error) {
        MessageBox.Show("The update did not finish. " + error.Message, "Codex Local MCP update", MessageBoxButtons.OK, MessageBoxIcon.Error);
        if (restart != null && File.Exists(restart)) try { Process.Start(CleanProcess(restart, "")); } catch { }
        return 1;
      }
    }
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiOpenDatabaseW")] static extern uint MsiOpenDatabase(string path, IntPtr persist, out uint database);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiDatabaseOpenViewW")] static extern uint MsiDatabaseOpenView(uint database, string query, out uint view);
    [DllImport("msi.dll")] static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")] static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiRecordGetStringW")] static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint capacity);
    [DllImport("msi.dll")] static extern uint MsiCloseHandle(uint handle);
  }
}
