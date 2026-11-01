param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$type = $assembly.GetType('CodexLocalMCP.CloudflareSetup',$true)
$store = $assembly.GetType('CodexLocalMCP.Store',$true)
$flags = [Reflection.BindingFlags]'Public,NonPublic,Static,Instance'
function Assert($ok,$message) { if (!$ok) { throw $message } }
function Reject($action,$message) { $failed=$false; try { & $action | Out-Null } catch { $failed=$true }; Assert $failed $message }
function Static($name,[object[]]$values) { for ($i=0;$i -lt $values.Length;$i++) { if ($null -ne $values[$i]) { $values[$i]=$values[$i].PSObject.BaseObject } }; $type.GetMethod($name,$flags).Invoke($null,$values) }
function Pem($value) { '-----BEGIN ARGO TUNNEL TOKEN-----' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))) + '-----END ARGO TUNNEL TOKEN-----' }
$auth = @{ accountID=('a'*32); zoneID=('b'*32); apiToken='fake-account-secret' }
$pem = Pem $auth
Assert ((Static 'DecodeCertificate' @($pem)).apiToken -eq $auth.apiToken) 'Valid certificate rejected'
foreach ($bad in @('invalid',($pem+$pem),('x'*65537),(Pem @{accountID='bad';zoneID=$auth.zoneID;apiToken=$auth.apiToken}),(Pem ($auth + @{endpoint='https://evil.example'})))) {
  Reject { Static 'DecodeCertificate' @($bad) } 'Invalid certificate accepted'
}
Assert (Static 'LoginUrl' @('https://dash.cloudflare.com/argotunnel?token=abc')) 'Expected login URL rejected'
foreach ($url in @('https://dash.cloudflare.com.evil.example/argotunnel?token=x','http://dash.cloudflare.com/argotunnel','https://user@dash.cloudflare.com/argotunnel','https://dash.cloudflare.com:444/argotunnel','https://dash.cloudflare.com/other')) {
  Assert (!(Static 'LoginUrl' @($url))) 'Untrusted login URL accepted'
}
Add-Type -ReferencedAssemblies System.Net.Http -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
public class CloudflareTestHandler : HttpMessageHandler {
  public Queue<string> Responses = new Queue<string>();
  public List<string> Requests = new List<string>();
  public HttpStatusCode Status = HttpStatusCode.OK;
  protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel) {
    if (request.RequestUri.Host != "api.cloudflare.com" || request.RequestUri.Scheme != "https") throw new Exception("Wrong origin");
    if (request.Headers.Authorization.Parameter != "fake-account-secret") throw new Exception("Wrong token");
    var body = request.Content == null ? "" : await request.Content.ReadAsStringAsync();
    Requests.Add(request.Method + " " + request.RequestUri.AbsolutePath + " " + body);
    var response = Responses.Dequeue();
    if (response == "CREATE") {
      var name = Regex.Match(body, "codex-local-[a-f0-9]{32}").Value;
      response = "{\"success\":true,\"result\":{\"id\":\"11111111-2222-4333-8444-555555555555\",\"name\":\"" + name + "\",\"config_src\":\"cloudflare\"}}";
    }
    return new HttpResponseMessage(Status) { Content = new StringContent(response) };
  }
}
'@
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('codex-cloudflare-test-'+[Guid]::NewGuid().ToString('N')+'.json')
function Save-State($owned=@()) {
  $state = @{Credentials=$auth;Owned=@($owned)} | ConvertTo-Json -Depth 8 -Compress
  $protected = $store.GetMethod('Protect',$flags).Invoke($null,@([string]$state))
  [IO.File]::WriteAllText($fixture,$protected)
}
function Reply($result) { $handler.Responses.Enqueue((@{success=$true;result=$result} | ConvertTo-Json -Depth 10 -Compress)) }
function Invoke-Cloud($name,[object[]]$values) {
  $values = @($values | ForEach-Object { if ($null -ne $_) { $_.PSObject.BaseObject } else { $null } }); $task = ($type.GetMethods($flags) | Where-Object { $_.Name -eq $name -and $_.GetParameters().Length -eq $values.Length } | Select-Object -First 1).Invoke($service,$values)
  $task.GetAwaiter().GetResult()
}
$handler = New-Object CloudflareTestHandler
$constructor = $type.GetConstructor($flags,$null,[type[]]@([Net.Http.HttpMessageHandler],[string]),$null)
$service = $constructor.Invoke(@($handler.PSObject.BaseObject,[string]$fixture))
$zone = @{ id=$auth.zoneID; name='example.com';status='active';account=@{id=$auth.accountID} }
$id = '11111111-2222-4333-8444-555555555555'
$owned = @{Id=$id;Account=$auth.accountID;Name='codex-test';Hostname='codex.example.com';Port=3000;Token=''}
try {
  Save-State
  Reply $zone
  Reply @(@{type='A';name='codex.example.com';content='192.0.2.1'})
  Reject { Invoke-Cloud 'Create' @($auth.zoneID,'codex',3000) } 'DNS conflict was accepted'
  Assert ($handler.Requests.Count -eq 2) 'Conflict caused a mutation'
  Assert (($handler.Requests -join '') -notmatch 'POST|PUT') 'Existing DNS was changed'
  $handler.Requests.Clear()
  Save-State
  Reply $zone
  Reply @()
  $handler.Responses.Enqueue('CREATE')
  Reply @()
  Reply 'scoped-runtime-token-test'
  Reply @{type='CNAME';name='codex.example.com';content=($id+'.cfargotunnel.com');proxied=$true}
  Reply @{config=@{}}
  $created = Invoke-Cloud 'Create' @($auth.zoneID,'codex',3000)
  Assert ($created.Id -eq $id) 'Fresh tunnel creation failed'
  Assert (($handler.Requests | Where-Object { $_ -match '^POST .*/cfd_tunnel ' }).Count -eq 1) 'Fresh setup did not create exactly one tunnel'
  $handler.Requests.Clear()
  Save-State @($owned)
  Reply $zone
  Reply @()
  Reply @{id=$id;name='codex-test';config_src='cloudflare';deleted_at=$null}
  Reply @()
  Reply 'scoped-runtime-token-test'
  Reply @{type='CNAME';name='codex.example.com';content=($id+'.cfargotunnel.com');proxied=$true}
  Reply @{config=@{}}
  $result = Invoke-Cloud 'Create' @($auth.zoneID,'codex',3000)
  Assert ($result.Hostname -eq 'codex.example.com') 'Retry failed'
  Assert (($handler.Requests | Where-Object { $_ -match '^POST .*/cfd_tunnel ' }).Count -eq 0) 'Retry created another tunnel'
  Assert (($handler.Requests -join '') -match 'http://127.0.0.1:3000') 'Wrong local origin'
  Assert ([IO.File]::ReadAllText($fixture) -notmatch 'fake-account-secret|scoped-runtime-token-test') 'Credentials stored as plaintext'
  $settings = [Activator]::CreateInstance($assembly.GetType('CodexLocalMCP.Settings'))
  $settings.Tunnel='named'; $settings.PublicUrl='https://codex.example.com';$settings.TunnelToken=$result.Token;$settings.Port=4000
  Reply @{id=$id;name='codex-test';config_src='cloudflare';deleted_at=$null}
  Reply @{config=@{}}
  Invoke-Cloud 'Reconcile' @($settings)
  Assert ($handler.Requests[-1] -match 'http://127.0.0.1:4000') 'Port update failed'
  $handler.Status=[Net.HttpStatusCode]::Forbidden
  $handler.Responses.Enqueue('secret-provider-body fake-account-secret')
  try { Invoke-Cloud 'Domains' @(); throw 'Expected rejection' } catch {
    Assert ($_.Exception.ToString() -notmatch 'secret-provider-body|fake-account-secret') 'API error exposed secrets'
  }
  Assert ($handler.Responses.Count -eq 0) 'Test responses were not consumed'
  Write-Output 'Cloudflare tests passed: certificate, URL, DNS conflict, retry, encrypted storage, origin update, and redacted API errors.'
} finally {
  $service.Dispose()
  foreach ($path in @($fixture,($fixture+'.new'))) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
}
