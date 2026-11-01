using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexLocalMCP {
  sealed partial class Manager {
    readonly ComboBox cloudflareDomain = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly TextBox cloudflarePrefix = new TextBox { Text = "codex", MaxLength = 63 };
    readonly Label cloudflareStatus = Copy("Sign in to choose a domain. Your Cloudflare password stays in your browser.", 9);
    readonly Label cloudflareAddress = Copy("Your address will appear here.", 10, true);
    readonly Button cloudflareLogin = new Button(), cloudflareRefresh = new Button(), cloudflareCreate = new Button(), cloudflareCancel = new Button();
    CancellationTokenSource cloudflareCancellation;
    readonly FlowLayoutPanel cloudflareSetupFields = Stack();
    readonly Label cloudflareSavedAddress = Copy("", 10, true);
    readonly Button cloudflareChangeAddress = new Button();

    void BuildCloudflareFields(FlowLayoutPanel panel) {
      panel.Controls.Add(cloudflareSavedAddress);
      panel.Controls.Add(Row(Style(cloudflareChangeAddress, "Change address")));
      cloudflareSavedAddress.Visible = cloudflareChangeAddress.Visible = false;
      cloudflareChangeAddress.Click += (s, e) => {
        cloudflareSetupFields.Visible = !cloudflareSetupFields.Visible;
        cloudflareChangeAddress.Text = cloudflareSetupFields.Visible ? "Keep saved address" : "Change address";
      };
      panel.Controls.Add(cloudflareSetupFields); panel = cloudflareSetupFields;
      Style(cloudflareLogin, "Sign in to Cloudflare", true);
      Style(cloudflareRefresh, "Load domains");
      Style(cloudflareCancel, "Cancel sign-in"); cloudflareCancel.Visible = false;
      panel.Controls.Add(Row(cloudflareLogin, cloudflareRefresh, cloudflareCancel));
      panel.Controls.Add(cloudflareStatus);
      Field(panel, "Domain", cloudflareDomain, "Use a domain that is active in your Cloudflare account.");
      Field(panel, "Address name", cloudflarePrefix, "For example: codex");
      panel.Controls.Add(cloudflareAddress);
      Style(cloudflareCreate, "Create address", true); cloudflareCreate.Enabled = false;
      panel.Controls.Add(Row(cloudflareCreate));
      panel.Controls.Add(Copy("Create address adds a Cloudflare tunnel and DNS record. Then select Start connection.", 9));
      cloudflareDomain.SelectedIndexChanged += (s, e) => CloudflareAddress();
      cloudflarePrefix.TextChanged += (s, e) => CloudflareAddress();
      cloudflareCancel.Click += (s, e) => cloudflareCancellation?.Cancel();
      cloudflareLogin.Click += async (s, e) => await CloudflareOperation(async service => {
        cloudflareCancellation = new CancellationTokenSource(); cloudflareCancel.Visible = true;
        cloudflareStatus.Text = "Complete sign-in and approve your domain in the browser.";
        try {
          await service.Login(System.IO.Path.Combine(installRoot, "runtime", "cloudflared.exe"), url => {
            if (!IsDisposed) BeginInvoke(new Action(() => {
              try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
              catch { cloudflareCancellation?.Cancel(); }
            }));
          }, cloudflareCancellation.Token);
          await LoadCloudflareDomains(service);
        } finally { cloudflareCancel.Visible = false; cloudflareCancellation.Dispose(); cloudflareCancellation = null; }
      });
      cloudflareRefresh.Click += async (s, e) => await CloudflareOperation(LoadCloudflareDomains);
      cloudflareCreate.Click += async (s, e) => await CloudflareOperation(async service => {
        var domain = cloudflareDomain.SelectedItem as CloudflareDomain;
        if (domain == null) throw new Exception("Sign in and select a domain first.");
        cloudflareStatus.Text = "Creating your address in Cloudflare…";
        var owned = await service.Create(domain.Id, cloudflarePrefix.Text.Trim().ToLowerInvariant(), (int)port.Value);
        publicUrl.Text = "https://" + owned.Hostname;
        // Save only after normal application validation succeeds. Keep the scoped token for retry.
        token.Text = Store.Unprotect(owned.Token); Save();
        UpdateSavedCloudflare();
        cloudflareStatus.Text = "Address ready: " + publicUrl.Text + ". Select Start connection.";
      });
    }
    void UpdateSavedCloudflare() {
      Uri url;
      bool configured = saved.Tunnel == "named" && !string.IsNullOrEmpty(saved.TunnelToken) &&
        Uri.TryCreate(saved.PublicUrl, UriKind.Absolute, out url) && url.Scheme == "https" && url.AbsolutePath == "/" && url.UserInfo == "" && url.Query == "" && url.Fragment == "";
      cloudflareSavedAddress.Visible = cloudflareChangeAddress.Visible = configured;
      cloudflareSavedAddress.Text = configured ? "Address configured: " + saved.PublicUrl + "\nTunnel settings saved. Select Start connection to use this address." : "";
      cloudflareSetupFields.Visible = !configured;
      cloudflareChangeAddress.Text = "Change address";
    }
    void CloudflareAddress() {
      var domain = cloudflareDomain.SelectedItem as CloudflareDomain;
      cloudflareAddress.Text = domain == null ? "Your address will appear here." : "https://" + cloudflarePrefix.Text.Trim().ToLowerInvariant() + "." + domain.Name;
      cloudflareCreate.Enabled = !busy && domain != null;
    }
    async Task LoadCloudflareDomains(CloudflareSetup service) {
      var domains = await service.Domains();
      cloudflareDomain.Items.Clear(); foreach (var domain in domains) cloudflareDomain.Items.Add(domain);
      if (domains.Count > 0) cloudflareDomain.SelectedIndex = 0;
      cloudflareStatus.Text = "Signed in. Choose a domain and address name, then select Create address.";
    }
    async Task CloudflareOperation(Func<CloudflareSetup, Task> action) {
      if (busy) return;
      if (server != null && !server.HasExited) { Guard(() => { }); return; }
      cloudflareLogin.Enabled = cloudflareRefresh.Enabled = cloudflareCreate.Enabled = false;
      cloudflareDomain.Enabled = cloudflarePrefix.Enabled = false;
      try { await Operation(async () => { using (var service = new CloudflareSetup()) await action(service); }); }
      finally {
        cloudflareLogin.Enabled = cloudflareRefresh.Enabled = true;
        cloudflareDomain.Enabled = cloudflarePrefix.Enabled = true; CloudflareAddress();
      }
    }
  }
}
