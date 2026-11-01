using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace CodexLocalMCP {
  public sealed class InstallRecord {
    public string Product { get; set; }
    public string Version { get; set; }
    public string Directory { get; set; }
    public string RegistryKey { get; set; }
    public string Shortcut { get; set; }
    public Dictionary<string, string> Files { get; set; }
  }
  static class SetupRegistration {
    internal static void Refresh(string directory, ReleaseInfo release, string package) {
      var path = Path.Combine(Store.Root,"installer","install.json");
      if (!File.Exists(path)) return;
      if ((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0 || new FileInfo(path).Length>2*1024*1024) throw new InvalidDataException("The installer record is invalid.");
      var json=new JavaScriptSerializer { MaxJsonLength=2*1024*1024 };
      var record=json.Deserialize<InstallRecord>(File.ReadAllText(path));
      if (record.Product!="codex-local-mcp" || !string.Equals(Path.GetFullPath(record.Directory),Path.GetFullPath(directory),StringComparison.OrdinalIgnoreCase)) return;
      if (record.RegistryKey!=@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLocalMCP-App") throw new InvalidDataException("The setup registration is invalid.");
      var files=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      using (var archive=ZipFile.OpenRead(package)) foreach (var entry in archive.Entries) {
        UpdateInstaller.EntryPath(entry.FullName); if (entry.FullName.EndsWith("/",StringComparison.Ordinal)) continue;
        var file=Path.GetFullPath(Path.Combine(directory,entry.FullName.Replace('/','\\')));
        if (!file.StartsWith(Path.GetFullPath(directory).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The update record escaped its application folder.");
        using (var input=File.OpenRead(file)) using (var hash=SHA256.Create()) files.Add(entry.FullName,UpdateClient.Hex(hash.ComputeHash(input)));
      }
      record.Version=release.Version; record.Files=files;
      File.WriteAllText(path+".new",json.Serialize(record)); File.Replace(path+".new",path,null);
      using (var key=Registry.CurrentUser.OpenSubKey(record.RegistryKey,true)) key?.SetValue("DisplayVersion",release.Version);
    }
  }
}
