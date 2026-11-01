using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace CodexLocalMCP {
  static partial class UpdateInstaller {
    internal static void RequireTarget(string executable, bool portable) {
      var target = Path.GetFullPath(executable); var folder = Path.GetDirectoryName(target);
      if (Path.GetFileName(target) != "CodexMCP.exe" || !File.Exists(target) ||
          folder == Path.GetPathRoot(folder).TrimEnd('\\') || folder.StartsWith(Store.Root, StringComparison.OrdinalIgnoreCase) ||
          folder.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.Windows), StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("The application update location is invalid.");
      var installed = InstalledExecutable();
      if (!portable && !string.Equals(installed, target, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Install the MSI before using MSI updates.");
      if (portable && string.Equals(installed, target, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Extract the portable ZIP into a separate folder before using portable updates. Keep it outside the old MSI installation folder.");
      if (FileVersionInfo.GetVersionInfo(target).ProductName != "Codex Local MCP") throw new InvalidDataException("The target is not Codex Local MCP.");
      foreach (var special in new[] { Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.MyDocuments, Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        if (string.Equals(folder, Environment.GetFolderPath(special).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Updates require a dedicated application folder.");
      if (portable) {
        var manifest = Path.Combine(folder, "release-manifest.json");
        if (!File.Exists(manifest) || new FileInfo(manifest).Length > 131072) throw new InvalidDataException("The existing application manifest is missing or too large.");
        var data = new JavaScriptSerializer { MaxJsonLength = 131072 }.DeserializeObject(File.ReadAllText(manifest)) as IDictionary<string, object>;
        if (data == null || !data.ContainsKey("product") || !Equals(data["product"], "codex-local-mcp") || !data.ContainsKey("version") || !Equals(data["version"], FileVersionInfo.GetVersionInfo(target).ProductVersion.Split('+')[0]))
          throw new InvalidDataException("The existing application manifest does not match the app.");
        var known = new HashSet<string>(new[] { "app", "runtime", "CodexMCP.exe", "CodexMCP.exe.config", "CodexMCP.pdb", "LICENSE", "README.md", "SECURITY.md", "THIRD-PARTY-NOTICES.txt", "release-manifest.json", "verify-installed.mjs" }, StringComparer.OrdinalIgnoreCase);
        foreach (var entry in Directory.EnumerateFileSystemEntries(folder)) if (!known.Contains(Path.GetFileName(entry))) throw new InvalidDataException("Move unrelated files out of the application folder before updating.");
      }
      for (var cursor = target; cursor != null && cursor.Length > 3; cursor = Path.GetDirectoryName(cursor))
        if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("The application update path must not contain links.");
    }
    internal static void EntryPath(string name) {
      if (string.IsNullOrEmpty(name) || name.Length > 220 || name.IndexOf('\\') >= 0 || name.IndexOf(':') >= 0 || name.StartsWith("/", StringComparison.Ordinal))
        throw new InvalidDataException("The update archive has an unsafe path.");
      foreach (var part in name.TrimEnd('/').Split('/'))
        if (string.IsNullOrEmpty(part) || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) ||
            part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || Regex.IsMatch(part, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", RegexOptions.IgnoreCase))
          throw new InvalidDataException("The update archive has an unsafe Windows filename.");
    }
    internal static void VerifyArchive(string path, ReleaseInfo release) {
      using (var archive = ZipFile.OpenRead(path)) {
        if (archive.Entries.Count == 0 || archive.Entries.Count > 512) throw new InvalidDataException("The update archive has too many files.");
        long total = 0; var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries) {
          EntryPath(entry.FullName);
          if (!names.Add(entry.FullName.TrimEnd('/')) || ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000 || (entry.ExternalAttributes & 0x400) != 0)
            throw new InvalidDataException("Update archives must not contain duplicate names or links.");
          total = checked(total + entry.Length);
          if (total > UpdateClient.MaxBytes) throw new InvalidDataException("The extracted update exceeds the supported size.");
        }
        var manifest = archive.GetEntry("release-manifest.json");
        if (manifest == null || manifest.Length > 131072 || archive.GetEntry("CodexMCP.exe") == null || archive.GetEntry("runtime/node/node.exe") == null || archive.GetEntry("app/dist/index.js") == null)
          throw new InvalidDataException("The portable update is incomplete.");
        using (var stream = manifest.Open())
        using (var reader = new StreamReader(stream, Encoding.UTF8)) {
          var buffer = new char[4096]; var bounded = new StringBuilder(); int count;
          while ((count = reader.Read(buffer, 0, buffer.Length)) > 0) {
            if (bounded.Length + count > 131072) throw new InvalidDataException("The update manifest is too large.");
            bounded.Append(buffer, 0, count);
          }
          var text = bounded.ToString();
          var data = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 20 }.DeserializeObject(text) as IDictionary<string, object>;
          if (data == null || !data.ContainsKey("product") || !Equals(data["product"], "codex-local-mcp") || !data.ContainsKey("version") || !Equals(data["version"], release.Version) || !data.ContainsKey("architecture") || !Equals(data["architecture"], "x64"))
            throw new InvalidDataException("The portable update product, version, or architecture does not match.");
        }
      }
    }
    internal static void InstallArchive(string path, ReleaseInfo release, string executable) {
      RequireTarget(executable, true); VerifyPackage(path, release);
      var target = Path.GetDirectoryName(Path.GetFullPath(executable)); var parent = Path.GetDirectoryName(target);
      var stage = Path.Combine(parent, ".codex-mcp-stage-" + Guid.NewGuid().ToString("N"));
      var backup = target + ".previous-" + Guid.NewGuid().ToString("N");
      var boundary = parent.TrimEnd('\\') + "\\";
      if (!stage.StartsWith(boundary, StringComparison.OrdinalIgnoreCase) || !backup.StartsWith(boundary, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(Path.GetFileName(target)))
        throw new InvalidDataException("The update staging location is invalid.");
      Directory.CreateDirectory(stage);
      try {
        long total = 0;
        using (var archive = ZipFile.OpenRead(path)) foreach (var entry in archive.Entries) {
          EntryPath(entry.FullName);
          var output = Path.GetFullPath(Path.Combine(stage, entry.FullName.Replace('/', '\\')));
          if (!output.StartsWith(stage + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The update escaped its staging folder.");
          if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) { Directory.CreateDirectory(output); continue; }
          Directory.CreateDirectory(Path.GetDirectoryName(output));
          using (var input = entry.Open())
          using (var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            var buffer = new byte[65536]; long received = 0; int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
              received += count; total += count;
              if (received > entry.Length || total > UpdateClient.MaxBytes) throw new InvalidDataException("The update exceeded its extracted size.");
              file.Write(buffer, 0, count);
            }
            if (received != entry.Length) throw new InvalidDataException("The update archive is incomplete.");
          }
        }
        if (FileVersionInfo.GetVersionInfo(Path.Combine(stage, "CodexMCP.exe")).ProductVersion.Split('+')[0] != release.Version)
          throw new InvalidDataException("The extracted application version does not match.");
        // All moves stay under the explicitly checked application parent. Keep one backup for recovery.
        Directory.Move(target, backup);
        try { Directory.Move(stage, target); }
        catch { Directory.Move(backup, target); throw; }
      } finally {
        if (Directory.Exists(stage) && Path.GetFullPath(stage).StartsWith(boundary, StringComparison.OrdinalIgnoreCase)) Directory.Delete(stage, true);
      }
    }
  }
}
