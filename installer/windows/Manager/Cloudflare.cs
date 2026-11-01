using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CodexLocalMCP {
  public sealed class CloudflareCredentials {
    public string accountID { get; set; }
    public string zoneID { get; set; }
    public string apiToken { get; set; }
    public string endpoint { get; set; }
  }
  public sealed class CloudflareDomain {
    public string Id { get; set; }
    public string Name { get; set; }
    public override string ToString() => Name;
  }
  public sealed class CloudflareOwned {
    public string Id { get; set; }
    public string Account { get; set; }
    public string Name { get; set; }
    public string Hostname { get; set; }
    public int Port { get; set; }
    public string Token { get; set; }
  }
  // Account credentials stay in the manager. Only the scoped connector token reaches the server.
  sealed class CloudflareSetup : IDisposable {
    readonly HttpClient client;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024 };
    readonly string statePath;
    public CloudflareSetup(HttpMessageHandler handler = null, string storage = null) {
      client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false });
      client.Timeout = TimeSpan.FromSeconds(15);
      statePath = storage ?? Path.Combine(Store.Root, "cloudflare.json");
    }
    sealed public class State {
      public CloudflareCredentials Credentials { get; set; }
      public List<CloudflareOwned> Owned { get; set; } = new List<CloudflareOwned>();
    }
    State Load() => File.Exists(statePath) ? json.Deserialize<State>(Store.Unprotect(File.ReadAllText(statePath))) : new State();
    void Save(State value) {
      Store.EnsurePrivateRoot();
      var temporary = statePath + ".new";
      File.WriteAllText(temporary, Store.Protect(json.Serialize(value)));
      if (File.Exists(statePath)) File.Replace(temporary, statePath, null); else File.Move(temporary, statePath);
    }
    static bool Identifier(string value) => value != null && Regex.IsMatch(value, @"\A[a-fA-F0-9]{32}\z");
    static bool Host(string value) => value != null && value.Length <= 253 && Regex.IsMatch(value, @"\A(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z");
    public static CloudflareCredentials DecodeCertificate(string pem) {
      try {
        if (pem == null || pem.Length > 65536) throw new Exception();
        var blocks = Regex.Matches(pem, @"-----BEGIN ARGO TUNNEL TOKEN-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END ARGO TUNNEL TOKEN-----");
        if (blocks.Count != 1) throw new Exception();
        var value = new JavaScriptSerializer().Deserialize<CloudflareCredentials>(Encoding.UTF8.GetString(Convert.FromBase64String(blocks[0].Groups[1].Value)));
        if (!Identifier(value.accountID) || !Identifier(value.zoneID) || value.apiToken == null || value.apiToken.Length < 10 || value.apiToken.Length > 8192 || !string.IsNullOrEmpty(value.endpoint)) throw new Exception();
        return value;
      } catch { throw new Exception("Cloudflare returned an invalid sign-in certificate. Sign in again."); }
    }
    public static bool LoginUrl(string value) {
      Uri uri;
      return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "dash.cloudflare.com" && uri.IsDefaultPort && uri.AbsolutePath == "/argotunnel" && uri.UserInfo == "" && uri.Fragment == "";
    }
    public async Task Login(string executable, Action<string> openBrowser, CancellationToken cancel) {
      Store.EnsurePrivateRoot();
      var home = Path.Combine(Store.Root, "cloudflare-login-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(home);
      try {
        var info = new ProcessStartInfo(executable, "tunnel --config= --no-autoupdate login") { WorkingDirectory = home, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.EnvironmentVariables.Clear();
        foreach (var key in new[] { "SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP" }) {
          var value = Environment.GetEnvironmentVariable(key); if (value != null) info.EnvironmentVariables[key] = value;
        }
        info.EnvironmentVariables["HOME"] = home; info.EnvironmentVariables["USERPROFILE"] = home; info.EnvironmentVariables["PATH"] = home;
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel))
        using (var process = new Process { StartInfo = info }) {
          timeout.CancelAfter(TimeSpan.FromMinutes(8));
          process.Start();
          var opened = 0;
          Func<StreamReader, Task> read = async reader => {
            var buffer = new char[2048]; var tail = ""; int count; int total = 0;
            while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) > 0) {
              total += count; if (total > 262144) { timeout.Cancel(); return; }
              tail += new string(buffer, 0, count);
              var match = Regex.Match(tail, "https://dash\\.cloudflare\\.com/argotunnel\\?[^\\s<>\"']+(?=[\\s<>\"'])");
              if (match.Success && LoginUrl(match.Value) && Interlocked.CompareExchange(ref opened, 1, 0) == 0) openBrowser(match.Value);
              if (tail.Length > 8192) tail = tail.Substring(tail.Length - 8192);
            }
          };
          var stdout = read(process.StandardOutput); var stderr = read(process.StandardError);
          using (timeout.Token.Register(() => { try { if (!process.HasExited) process.Kill(); } catch { } })) {
            await Task.Run(() => process.WaitForExit()); await Task.WhenAll(stdout, stderr);
          }
          if (timeout.IsCancellationRequested) throw new Exception("Cloudflare sign-in was cancelled or timed out. Select Sign in to try again.");
          if (process.ExitCode != 0) throw new Exception("Cloudflare sign-in did not finish. Sign in again and approve your domain.");
        }
        var path = Path.Combine(home, ".cloudflared", "cert.pem");
        if (!File.Exists(path) || new FileInfo(path).Length > 65536) throw new Exception("Cloudflare did not return a sign-in certificate.");
        var credentials = DecodeCertificate(File.ReadAllText(path));
        await Domains(credentials);
        var state = Load(); state.Credentials = credentials; Save(state);
      } finally {
        // This is a fresh, app-created directory with a fixed private parent.
        if (Directory.Exists(home)) Directory.Delete(home, true);
      }
    }
    static Dictionary<string, object> Object(object value) => value as Dictionary<string, object> ?? throw new Exception("Cloudflare returned an invalid response.");
    static string Text(Dictionary<string, object> value, string key) => value.ContainsKey(key) ? value[key] as string : null;
    static object[] Array(object value) => value as object[] ?? throw new Exception("Cloudflare returned an invalid list.");
    async Task<object> Request(CloudflareCredentials auth, string path, string method = "GET", object body = null) {
      try {
        using (var message = new HttpRequestMessage(new HttpMethod(method), "https://api.cloudflare.com/client/v4" + path)) {
          message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", auth.apiToken);
          if (body != null) message.Content = new StringContent(json.Serialize(body), Encoding.UTF8, "application/json");
          using (var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead)) {
            if (!response.IsSuccessStatusCode) throw new Exception();
            using (var stream = await response.Content.ReadAsStreamAsync())
            using (var output = new MemoryStream()) {
              var bytes = new byte[8192]; int count;
              using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15))) {
                while ((count = await stream.ReadAsync(bytes, 0, bytes.Length, deadline.Token)) > 0) {
                  if (output.Length + count > 2 * 1024 * 1024) throw new Exception();
                  output.Write(bytes, 0, count);
                }
              }
              var envelope = Object(json.DeserializeObject(Encoding.UTF8.GetString(output.ToArray())));
              if (!envelope.ContainsKey("success") || !true.Equals(envelope["success"]) || !envelope.ContainsKey("result")) throw new Exception();
              return envelope["result"];
            }
          }
        }
      } catch { throw new Exception("Cloudflare could not complete this action. Check your connection and domain permissions, then try again."); }
    }
    CloudflareCredentials Credentials() => Load().Credentials ?? throw new Exception("Sign in to Cloudflare first.");
    CloudflareDomain Domain(object raw, CloudflareCredentials auth) {
      var zone = Object(raw); var id = Text(zone, "id"); var name = Text(zone, "name")?.ToLowerInvariant();
      if (!Identifier(id) || !Host(name) || Text(Object(zone["account"]), "id") != auth.accountID || Text(zone, "status") != "active") throw new Exception("Select an active domain in your Cloudflare account.");
      return new CloudflareDomain { Id = id, Name = name };
    }
    public Task<List<CloudflareDomain>> Domains() => Domains(Credentials());
    async Task<List<CloudflareDomain>> Domains(CloudflareCredentials auth) {
      var selected = Domain(await Request(auth, "/zones/" + auth.zoneID), auth);
      var domains = new List<CloudflareDomain> { selected };
      try {
        for (int page = 1; page <= 100; page++) {
          var zones = Array(await Request(auth, "/zones?account.id=" + auth.accountID + "&status=active&per_page=50&page=" + page));
          foreach (var zone in zones) { var value = Domain(zone, auth); if (domains.All(x => x.Id != value.Id)) domains.Add(value); }
          if (zones.Length < 50) break;
        }
      } catch { /* The selected domain can remain usable without account-wide list permission. */ }
      return domains.OrderBy(x => x.Name).ToList();
    }
    async Task Records(CloudflareCredentials auth, CloudflareDomain zone, string host, CloudflareOwned owned, Action<bool> found) {
      var records = Array(await Request(auth, "/zones/" + zone.Id + "/dns_records?name=" + Uri.EscapeDataString(host) + "&per_page=100"));
      if (records.Length >= 100) throw new Exception("This address has too many DNS records. Choose another address.");
      foreach (var raw in records) {
        var record = Object(raw);
        if (owned == null || Text(record, "type") != "CNAME" || Text(record, "name")?.TrimEnd('.').ToLowerInvariant() != host || Text(record, "content")?.TrimEnd('.').ToLowerInvariant() != owned.Id + ".cfargotunnel.com" || !record.ContainsKey("proxied") || !true.Equals(record["proxied"]))
          throw new Exception("This address is already in use. Choose another address to keep your existing DNS records.");
      }
      found(records.Length > 0);
    }
    async Task Verify(CloudflareCredentials auth, CloudflareOwned owned) {
      var tunnel = Object(await Request(auth, "/accounts/" + auth.accountID + "/cfd_tunnel/" + owned.Id));
      if (Text(tunnel, "id") != owned.Id || Text(tunnel, "name") != owned.Name || Text(tunnel, "config_src") != "cloudflare" || Text(tunnel, "deleted_at") != null) throw new Exception("The saved Cloudflare tunnel has changed. Sign in and create another address.");
    }
    async Task Configure(CloudflareCredentials auth, CloudflareOwned owned, string host, int port) {
      await Request(auth, "/accounts/" + auth.accountID + "/cfd_tunnel/" + owned.Id + "/configurations", "PUT", new { config = new { ingress = new object[] { new { hostname = host, service = "http://127.0.0.1:" + port }, new { service = "http_status:404" } } } });
    }
    public async Task<CloudflareOwned> Create(string zoneId, string prefix, int port) {
      if (!Identifier(zoneId) || port < 1024 || port > 65535 || !Regex.IsMatch(prefix ?? "", @"\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z")) throw new Exception("Use an address name with letters, numbers, or hyphens. Maximum: 63 characters.");
      var state = Load(); var auth = state.Credentials ?? throw new Exception("Sign in to Cloudflare first.");
      var zone = Domain(await Request(auth, "/zones/" + zoneId), auth); var host = prefix + "." + zone.Name;
      if (!Host(host)) throw new Exception("This hostname is too long. Choose a shorter address.");
      var owned = state.Owned.FirstOrDefault(x => x.Account == auth.accountID && x.Hostname == host);
      await Records(auth, zone, host, owned, _ => { });
      var route = "/accounts/" + auth.accountID + "/cfd_tunnel";
      if (owned == null) {
        var name = "codex-local-" + Guid.NewGuid().ToString("N");
        var created = Object(await Request(auth, route, "POST", new { name, config_src = "cloudflare" }));
        Guid id;
        if (!Guid.TryParseExact(Text(created, "id"), "D", out id) || Text(created, "name") != name || Text(created, "config_src") != "cloudflare" || Text(created, "deleted_at") != null) throw new Exception("Cloudflare returned an invalid tunnel.");
        owned = new CloudflareOwned { Id = id.ToString(), Account = auth.accountID, Name = name, Hostname = host };
        state.Owned.Add(owned); Save(state);
      } else await Verify(auth, owned);
      bool exists = false;
      await Records(auth, zone, host, owned, value => exists = value);
      var token = await Request(auth, route + "/" + owned.Id + "/token") as string;
      if (token == null || token.Length < 10 || token.Length > 16384) throw new Exception("Cloudflare returned an invalid tunnel token.");
      if (!exists) {
        var record = Object(await Request(auth, "/zones/" + zone.Id + "/dns_records", "POST", new { type = "CNAME", name = host, content = owned.Id + ".cfargotunnel.com", proxied = true, ttl = 1 }));
        if (Text(record, "name") != host || Text(record, "type") != "CNAME" || Text(record, "content") != owned.Id + ".cfargotunnel.com" || !record.ContainsKey("proxied") || !true.Equals(record["proxied"])) throw new Exception("Cloudflare did not confirm the expected DNS record.");
      }
      await Configure(auth, owned, host, port);
      owned.Port = port; owned.Token = Store.Protect(token); Save(state); return owned;
    }
    public async Task Reconcile(Settings settings) {
      if (settings.Tunnel != "named") return;
      var state = Load();
      var owned = state.Owned.FirstOrDefault(x => "https://" + x.Hostname == settings.PublicUrl && !string.IsNullOrEmpty(x.Token) && Store.Unprotect(x.Token) == Store.Unprotect(settings.TunnelToken));
      if (owned == null || owned.Port == settings.Port) return;
      if (state.Credentials == null || state.Credentials.accountID != owned.Account) throw new Exception("Sign in to the original Cloudflare account to update the listener port.");
      await Verify(state.Credentials, owned); await Configure(state.Credentials, owned, owned.Hostname, settings.Port);
      owned.Port = settings.Port; Save(state);
    }
    public void Dispose() { client.Dispose(); }
  }
}
