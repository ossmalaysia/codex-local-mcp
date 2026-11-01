using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace CodexLocalMCP {
  static class SetupEngine {
    internal const string AppKey = @"Software\OSS Malaysia\CodexLocalMCPSetup";
    internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLocalMCP-App";
    static JavaScriptSerializer Json => new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024, RecursionLimit = 30 };
    internal static string DataDirectory => Path.Combine(Store.Root, "installer");
    internal static string DefaultDirectory {
      get { using (var key = Registry.CurrentUser.OpenSubKey(AppKey)) return key?.GetValue("InstallLocation") as string ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Codex Local MCP App"); }
    }
    internal static ReleaseInfo Payload() => ReadMetadata();
    static ReleaseInfo ReadMetadata() {
      using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("Setup.json"))
      using (var reader = new StreamReader(input)) {
        var data = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        var version = (string)data["version"]; UpdateClient.StableVersion(version);
        var hash = (string)data["sha256"]; var size = Convert.ToInt64(data["size"]);
        if (!System.Text.RegularExpressions.Regex.IsMatch(hash, "^[a-f0-9]{64}$") || size <= 0 || size > UpdateClient.MaxBytes) throw new InvalidDataException("Invalid embedded package metadata.");
        return new ReleaseInfo { Version = version, Name = "CodexLocalMCP-" + version + "-windows-x64.zip", Sha256 = hash, Size = size };
      }
    }
    static string HashFile(string path) { using (var stream = File.OpenRead(path)) using (var hash = SHA256.Create()) return UpdateClient.Hex(hash.ComputeHash(stream)); }
    internal static void ValidateDirectory(string directory, bool allowPartial = false) {
      var full = Path.GetFullPath(directory).TrimEnd('\\');
      if (!Path.IsPathRooted(directory) || directory.StartsWith(@"\\") || full.Length < 5 || full == Path.GetPathRoot(full).TrimEnd('\\')) throw new InvalidDataException("Choose a dedicated local installation folder.");
      foreach (var blocked in new[] { Store.Root, Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        if (full.Equals(blocked, StringComparison.OrdinalIgnoreCase) || full.StartsWith(blocked.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) || blocked.StartsWith(full + "\\", StringComparison.OrdinalIgnoreCase))
          throw new InvalidDataException("Choose a writable application folder separate from system files and private settings.");
      foreach (var special in new[] { Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.MyDocuments, Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.LocalApplicationData })
        if (full.Equals(Environment.GetFolderPath(special).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Choose a dedicated application folder.");
      var workspace = Path.GetFullPath(Store.Load().Workspace).TrimEnd('\\');
      if (full.Equals(workspace, StringComparison.OrdinalIgnoreCase) || full.StartsWith(workspace + "\\", StringComparison.OrdinalIgnoreCase) || workspace.StartsWith(full + "\\", StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("Keep the installation folder separate from your Codex workspace.");
      for (var cursor = full; cursor != null && cursor.Length > 3; cursor = Path.GetDirectoryName(cursor))
        if ((Directory.Exists(cursor) || File.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Installation paths must not contain links.");
      if (!allowPartial && Directory.Exists(full) && Directory.EnumerateFileSystemEntries(full).Any()) UpdateInstaller.RequireTarget(Path.Combine(full, "CodexMCP.exe"), true);
    }
    internal static void EnsureStopped(string directory, bool test) {
      foreach (var process in Process.GetProcessesByName("CodexMCP")) using (process) {
        string path; try { path = process.MainModule.FileName; } catch { continue; }
        if (!test || Path.GetDirectoryName(path).Equals(directory, StringComparison.OrdinalIgnoreCase)) throw new IOException("Exit Codex Local MCP from its system tray menu, then select Install again.");
      }
    }
    internal static void CheckResources() {
      var release = Payload();
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload.zip"))
      using (var hash = SHA256.Create()) {
        if (stream == null || stream.Length != release.Size || UpdateClient.Hex(hash.ComputeHash(stream)) != release.Sha256) throw new InvalidDataException("The embedded package failed SHA256 verification.");
      }
    }
    static bool WebViewInstalled() {
      const string path = @"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
      foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
          using (var root = RegistryKey.OpenBaseKey(hive, view)) using (var key = root.OpenSubKey(path)) {
            Version value; if (Version.TryParse(key?.GetValue("pv") as string, out value) && value.Major > 0) return true;
          }
      return false;
    }
    static void EnsureWebView(string cache, IProgress<Tuple<int,string>> progress) {
      using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("WebView2.exe")) {
        if (resource == null || WebViewInstalled()) return;
        progress?.Report(Tuple.Create(90, "Installing Microsoft WebView2. This can take a few minutes…"));
        var executable = Path.Combine(cache, "MicrosoftEdgeWebview2Setup.exe");
        using (var output = new FileStream(executable, FileMode.CreateNew, FileAccess.Write, FileShare.None)) resource.CopyTo(output);
        using (var process = Process.Start(UpdateInstaller.CleanProcess(executable, "/silent /install"))) {
          if (!process.WaitForExit(300000)) throw new IOException("WebView2 setup is still running. Finish it, then run this installer again.");
          if (process.ExitCode != 0 || !WebViewInstalled()) throw new IOException("Microsoft WebView2 could not be installed. Check your internet connection, then try setup again.");
        }
      }
    }
    internal static InstallRecord Install(string requested, string testId, bool shortcuts, IProgress<Tuple<int,string>> progress, CancellationToken cancellation) {
      bool test = testId != null; var directory = Path.GetFullPath(requested).TrimEnd('\\');
      ValidateDirectory(directory); EnsureStopped(directory, test); Store.EnsurePrivateRoot();
      var support = test ? Path.Combine(Store.Root, "installer-tests", testId) : DataDirectory;
      Directory.CreateDirectory(support);
      var cache = Path.Combine(Store.Root, "updates", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(cache);
      var release = Payload(); var package = Path.Combine(cache, release.Name);
      var stage = directory + ".setup-" + Guid.NewGuid().ToString("N"); var backup = directory + ".previous-" + Guid.NewGuid().ToString("N");
      var boundary = Path.GetDirectoryName(directory).TrimEnd('\\') + "\\";
      if (!stage.StartsWith(boundary, StringComparison.OrdinalIgnoreCase) || !backup.StartsWith(boundary, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The setup staging location is invalid.");
      bool movedOld = false, movedNew = false, committed = false;
      try {
        progress?.Report(Tuple.Create(2, "Checking the installation package…"));
        using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload.zip"))
        using (var output = new FileStream(package, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          var buffer = new byte[65536]; int count;
          while ((count = input.Read(buffer, 0, buffer.Length)) > 0) { cancellation.ThrowIfCancellationRequested(); output.Write(buffer, 0, count); }
        }
        UpdateInstaller.VerifyPackage(package, release); cancellation.ThrowIfCancellationRequested();
        Directory.CreateDirectory(stage);
        var files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (var archive = ZipFile.OpenRead(package)) {
          long total = archive.Entries.Sum(entry => entry.Length), written = 0;
          foreach (var entry in archive.Entries) {
            cancellation.ThrowIfCancellationRequested(); UpdateInstaller.EntryPath(entry.FullName);
            var path = Path.GetFullPath(Path.Combine(stage, entry.FullName.Replace('/', '\\')));
            if (!path.StartsWith(stage + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The package escaped its staging folder.");
            if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) { Directory.CreateDirectory(path); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            using (var input = entry.Open())
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var hash = SHA256.Create()) {
              var buffer = new byte[65536]; int count; long received = 0;
              while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                cancellation.ThrowIfCancellationRequested(); received += count; written += count;
                if (received > entry.Length || written > UpdateClient.MaxBytes) throw new InvalidDataException("The package exceeded its extracted size.");
                output.Write(buffer, 0, count); hash.TransformBlock(buffer, 0, count, null, 0);
              }
              if (received != entry.Length) throw new InvalidDataException("The package is incomplete.");
              hash.TransformFinalBlock(new byte[0], 0, 0); files.Add(entry.FullName, UpdateClient.Hex(hash.Hash));
            }
            progress?.Report(Tuple.Create(10 + (int)(written * 78 / Math.Max(1,total)), "Installing " + entry.FullName));
          }
        }
        if (FileVersionInfo.GetVersionInfo(Path.Combine(stage, "CodexMCP.exe")).ProductVersion.Split('+')[0] != release.Version) throw new InvalidDataException("The application version does not match setup.");
        EnsureWebView(cache, progress);
        cancellation.ThrowIfCancellationRequested(); EnsureStopped(directory, test);
        progress?.Report(Tuple.Create(92, "Finishing installation…"));
        if (Directory.Exists(directory)) { Directory.Move(directory, backup); movedOld = true; }
        Directory.Move(stage, directory);
        movedNew = true;
        var uninstaller = Path.Combine(support, "Uninstall.exe"); var temporary = uninstaller + ".new";
        using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("Uninstaller.exe"))
        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) input.CopyTo(output);
        if (File.Exists(uninstaller)) File.Replace(temporary, uninstaller, null); else File.Move(temporary, uninstaller);
        var record = new InstallRecord { Product="codex-local-mcp", Version=release.Version, Directory=directory, Files=files,
          RegistryKey = test ? UninstallKey + "-Test-" + testId : UninstallKey };
        if (shortcuts) {
          record.Shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Codex Local MCP.lnk");
          Shortcut(record.Shortcut, Path.Combine(directory, "CodexMCP.exe"));
        }
        SaveRecord(Path.Combine(support, "install.json"), record);
        Register(record, uninstaller, Path.Combine(support, "install.json"));
        if (!test) using (var key = Registry.CurrentUser.CreateSubKey(AppKey)) key.SetValue("InstallLocation", directory);
        committed = true; progress?.Report(Tuple.Create(100, "Installation complete.")); return record;
      } catch {
        if (!committed && movedNew && Directory.Exists(directory)) Directory.Move(directory, stage);
        if (!committed && movedOld && Directory.Exists(backup)) {
          Directory.Move(backup, directory);
        }
        throw;
      } finally {
        if (File.Exists(package)) File.Delete(package);
        if (Directory.Exists(cache) && Directory.GetFileSystemEntries(cache).Length == 0) Directory.Delete(cache);
        if (Directory.Exists(stage) && Path.GetFullPath(stage).StartsWith(boundary, StringComparison.OrdinalIgnoreCase)) Directory.Delete(stage, true);
      }
    }
    internal static void SaveRecord(string path, InstallRecord record) {
      File.WriteAllText(path + ".new", Json.Serialize(record), new UTF8Encoding(false));
      if (File.Exists(path)) File.Replace(path + ".new", path, null); else File.Move(path + ".new", path);
    }
    static void Shortcut(string path, string executable) {
      var type = Type.GetTypeFromProgID("WScript.Shell"); dynamic shell = Activator.CreateInstance(type);
      dynamic link = shell.CreateShortcut(path); link.TargetPath=executable; link.WorkingDirectory=Path.GetDirectoryName(executable); link.IconLocation=executable + ",0"; link.Description="Codex Local MCP"; link.Save();
    }
    static void Register(InstallRecord record, string uninstaller, string file) {
      using (var key = Registry.CurrentUser.CreateSubKey(record.RegistryKey)) {
        key.SetValue("DisplayName", "Codex Local MCP" + (record.RegistryKey.Contains("-Test-") ? " (setup test)" : "")); key.SetValue("DisplayVersion",record.Version);
        key.SetValue("Publisher","OSS Malaysia"); key.SetValue("InstallLocation",record.Directory); key.SetValue("DisplayIcon",Path.Combine(record.Directory,"CodexMCP.exe"));
        var command = UpdateInstaller.Argument(uninstaller) + " --uninstall --record " + UpdateInstaller.Argument(file);
        key.SetValue("UninstallString",command); key.SetValue("QuietUninstallString",command + " --silent"); key.SetValue("NoModify",1,RegistryValueKind.DWord); key.SetValue("NoRepair",1,RegistryValueKind.DWord);
        key.SetValue("URLInfoAbout","https://github.com/ossmalaysia/codex-local-mcp");
      }
    }
    internal static void Uninstall(string recordPath, IProgress<Tuple<int,string>> progress) {
      string full = Path.GetFullPath(recordPath), root = Path.GetFullPath(Store.Root).TrimEnd('\\') + "\\";
      if (full != Path.Combine(DataDirectory, "install.json") && !(full.StartsWith(root + "installer-tests\\",StringComparison.OrdinalIgnoreCase) && Path.GetFileName(full)=="install.json")) throw new InvalidDataException("The uninstall record is outside the private installer folder.");
      if (new FileInfo(full).Length > 2*1024*1024 || (File.GetAttributes(full) & FileAttributes.ReparsePoint)!=0) throw new InvalidDataException("The uninstall record is invalid.");
      var record = Json.Deserialize<InstallRecord>(File.ReadAllText(full));
      if (record.Product!="codex-local-mcp" || record.Files==null || record.Files.Count>512 || !record.RegistryKey.StartsWith(UninstallKey,StringComparison.Ordinal)) throw new InvalidDataException("The uninstall record does not match this app.");
      string directory=Path.GetFullPath(record.Directory).TrimEnd('\\'); ValidateDirectory(directory,true); EnsureStopped(directory,record.RegistryKey.Contains("-Test-"));
      int index=0;
      foreach (var item in record.Files) {
        UpdateInstaller.EntryPath(item.Key); var path=Path.GetFullPath(Path.Combine(directory,item.Key.Replace('/','\\')));
        if (!path.StartsWith(directory+"\\",StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The uninstall file escaped the application folder.");
        bool linked=false;
        for (var cursor=path; cursor!=null && cursor.StartsWith(directory,StringComparison.OrdinalIgnoreCase); cursor=Path.GetDirectoryName(cursor))
          if ((File.Exists(cursor)||Directory.Exists(cursor)) && (File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0) { linked=true; break; }
        if (!linked && File.Exists(path) && HashFile(path)==item.Value) File.Delete(path);
        progress?.Report(Tuple.Create(++index*90/Math.Max(1,record.Files.Count),"Removing application files…"));
      }
      RemoveEmpty(directory);
      if (!string.IsNullOrEmpty(record.Shortcut) && File.Exists(record.Shortcut)) {
        var expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Codex Local MCP.lnk");
        if (record.Shortcut==expected) { dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")); dynamic link=shell.CreateShortcut(expected); if ((string)link.TargetPath==Path.Combine(directory,"CodexMCP.exe")) File.Delete(expected); }
      }
      const string notificationKey = @"Software\Classes\AppUserModelId\com.ossmalaysia.codex-local-mcp";
      using (var key = Registry.CurrentUser.OpenSubKey(notificationKey)) {
        if (string.Equals(key?.GetValue("ApplicationPath") as string, Path.Combine(directory,"CodexMCP.exe"), StringComparison.OrdinalIgnoreCase)) {
          key.Close();
          try { Registry.CurrentUser.DeleteSubKey(notificationKey, false); } catch (IOException) { /* Preserve unexpected subkeys. */ }
        }
      }
      Registry.CurrentUser.DeleteSubKeyTree(record.RegistryKey,false);
      using (var key=Registry.CurrentUser.OpenSubKey(AppKey)) if ((string)key?.GetValue("InstallLocation")==directory) Registry.CurrentUser.DeleteSubKeyTree(AppKey,false);
      File.Delete(full); progress?.Report(Tuple.Create(100,"Uninstall complete. Your settings and workspace files were kept."));
    }
    static void RemoveEmpty(string directory) {
      if (!Directory.Exists(directory) || (File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0) return;
      foreach (var child in Directory.EnumerateDirectories(directory)) RemoveEmpty(child);
      if (!Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
    }
  }
}
