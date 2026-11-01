param([Parameter(Mandatory=$true)][string]$Executable, [string]$Installer, [string]$Version, [string]$SwapTarget)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$clientType = $assembly.GetType('CodexLocalMCP.UpdateClient', $true)
$installerType = $assembly.GetType('CodexLocalMCP.UpdateInstaller', $true)
$flags = [Reflection.BindingFlags]'Static,Instance,Public,NonPublic'
function Call($Type, $Name, [object[]]$Arguments) {
  for ($i=0; $i -lt $Arguments.Length; $i++) { if ($null -ne $Arguments[$i]) { $Arguments[$i]=$Arguments[$i].PSObject.BaseObject } }
  $Type.GetMethod($Name,$flags).Invoke($null,$Arguments)
}
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
function SetProperty($Object, $Name, $Value) { $Object.GetType().GetProperty($Name).SetValue($Object.PSObject.BaseObject,$Value.PSObject.BaseObject,$null) }
function Reject($Action, $Message) { $failed = $false; try { & $Action | Out-Null } catch { $failed = $true }; Assert $failed $Message }
function Fixture {
  @{
    tag_name='v0.4.0'; draft=$false; prerelease=$false
    html_url='https://github.com/ossmalaysia/codex-local-mcp/releases/tag/v0.4.0'
    assets=@(@{ name='CodexLocalMCP-0.4.0-windows-x64.msi'; state='uploaded'; size=4
      digest=('sha256:' + ('a' * 64)); browser_download_url='https://github.com/ossmalaysia/codex-local-mcp/releases/download/v0.4.0/CodexLocalMCP-0.4.0-windows-x64.msi' })
  }
}
function Parse($Fixture, $Current='0.3.0') { Call $clientType 'Parse' @(($Fixture | ConvertTo-Json -Depth 8 -Compress),$Current) }
$valid = Parse (Fixture)
Assert ($valid.Version -eq '0.4.0') 'Valid stable release was not accepted'
Assert ($null -eq (Parse (Fixture) '0.4.0')) 'Same version must not update'
Assert ($null -eq (Parse (Fixture) '0.5.0')) 'Downgrades must not update'
Reject { Call $clientType 'StableVersion' @('0.4.0-preview') } 'Prerelease versions must be rejected'
Reject { Call $clientType 'StableVersion' @('01.4.0') } 'Noncanonical versions must be rejected'
foreach ($case in @('draft','preview','repository','digest','size','fraction','asset','url')) {
  $fixture = Fixture
  switch ($case) {
    draft { $fixture.draft=$true }
    preview { $fixture.prerelease=$true }
    repository { $fixture.html_url='https://github.com/attacker/repo/releases/tag/v0.4.0' }
    digest { $fixture.assets[0].digest=$null }
    size { $fixture.assets[0].size=0 }
    fraction { $fixture.assets[0].size=4.5 }
    asset { $fixture.assets[0].name='CodexLocalMCP-0.4.0-windows-arm64.msi' }
    url { $fixture.assets[0].browser_download_url='https://example.invalid/installer.msi' }
  }
  Reject { Parse $fixture } "Invalid release accepted: $case"
}
Assert (Call $clientType 'PermittedAddress' @([Uri]$valid.Url,$valid)) 'Expected GitHub release URL was rejected'
Assert (Call $clientType 'PermittedAddress' @([Uri]'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?token=x',$valid)) 'Expected GitHub CDN was rejected'
foreach ($address in @('http://github.com/ossmalaysia/codex-local-mcp/releases/download/v0.4.0/x.msi','https://evil.example/x.msi','https://github.com/attacker/repo/releases/download/v0.4.0/x.msi','https://release-assets.githubusercontent.com/arbitrary/file','https://user:pass@release-assets.githubusercontent.com/github-production-release-asset/1/file')) {
  Assert (!(Call $clientType 'PermittedAddress' @([Uri]$address,$valid))) "Untrusted address accepted: $address"
}
$info = Call $installerType 'CleanProcess' @((Join-Path $env:WINDIR 'System32/msiexec.exe'),'')
Assert (!$info.EnvironmentVariables.ContainsKey('CODEX_MCP_PASSWORD')) 'Installer inherited MCP credentials'
Assert (!$info.EnvironmentVariables.ContainsKey('CODEX_HOME')) 'Installer inherited Codex authentication settings'
Reject { Call $installerType 'RequirePrivatePath' @($Executable) } 'Installer outside the update cache was accepted'
Reject { Call $installerType 'Argument' @("bad`nargument") } 'Control characters were accepted in process arguments'
foreach ($unsafe in @('../escape.exe','/absolute.exe','C:/outside.exe','dir\escape.exe','dir/../escape.exe','CON.txt','dir/file:stream','dir/file.','dir/file ','a//b')) {
  Reject { Call $installerType 'EntryPath' @($unsafe) } "Unsafe archive path accepted: $unsafe"
}
Call $installerType 'EntryPath' @('runtime/node/node.exe')
$portableFixture = Fixture
$portableAsset = $portableFixture.assets[0].Clone()
$portableAsset.name = 'CodexLocalMCP-0.4.0-windows-x64.zip'
$portableAsset.browser_download_url = 'https://github.com/ossmalaysia/codex-local-mcp/releases/download/v0.4.0/CodexLocalMCP-0.4.0-windows-x64.zip'
$portableFixture.assets = @($portableFixture.assets[0], $portableAsset)
Assert ((Parse $portableFixture).Name.EndsWith('.zip')) 'Portable package must be preferred over MSI'

# Fake HTTPS responses exercise verification and redirect policy without a network request.
Add-Type -ReferencedAssemblies System.Net.Http -TypeDefinition @'
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
public sealed class UpdateTestHandler : HttpMessageHandler {
  public int Requests; public string Redirect;
  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) {
    Requests++;
    var response = new HttpResponseMessage(Redirect == null ? HttpStatusCode.OK : HttpStatusCode.Redirect);
    if (Redirect != null) response.Headers.Location = new Uri(Redirect);
    else response.Content = new ByteArrayContent(new byte[] {1,2,3,4});
    return Task.FromResult(response);
  }
}
'@
foreach ($redirect in @($null,'https://evil.example/file.msi')) {
  $handler = New-Object UpdateTestHandler; if ($null -ne $redirect) { $handler.Redirect = $redirect }
  $constructor = $clientType.GetConstructor($flags,$null,[type[]]@([Net.Http.HttpMessageHandler]),$null)
  $client = $constructor.Invoke(@($handler.PSObject.BaseObject))
  try {
    $failed = $false
    try {
      $task = $clientType.GetMethod('DownloadAsync',$flags).Invoke($client,@($valid.PSObject.BaseObject,$null,[Threading.CancellationToken]::None))
      $task.GetAwaiter().GetResult() | Out-Null
    } catch { $failed = $true; $failure=$_.Exception.GetBaseException().Message }
    Assert $failed 'An unverified download was accepted'
    Assert ($failure -match 'SHA256|untrusted address') "Unexpected download failure: $failure"
    Assert ($handler.Requests -eq 1) 'Updater followed an untrusted redirect'
  } finally { $client.Dispose() }
}

if ($Installer) {
  if (!$Version) { throw 'Installer version is required' }
  $store = $assembly.GetType('CodexLocalMCP.Store')
  Call $store 'EnsurePrivateRoot' @()
  $root = $store.GetField('Root',$flags).GetValue($null)
  $folder = Join-Path $root ('updates/' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  $extension = [IO.Path]::GetExtension($Installer)
  $path = Join-Path $folder "CodexLocalMCP-$Version-windows-x64$extension"
  try {
    Copy-Item -LiteralPath $Installer -Destination $path
    $release = [Activator]::CreateInstance($assembly.GetType('CodexLocalMCP.ReleaseInfo'),$true)
    SetProperty $release 'Version' $Version; SetProperty $release 'Name' ([IO.Path]::GetFileName($path))
    SetProperty $release 'Sha256' ((Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()); SetProperty $release 'Size' ([long](Get-Item -LiteralPath $path).Length)
    Call $installerType 'VerifyPackage' @($path,$release)
    if ($SwapTarget) {
      if ($extension -ne '.zip') { throw 'A ZIP is required for the portable swap test' }
      $resolvedTarget = [IO.Path]::GetFullPath($SwapTarget)
      $testBoundary = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../artifacts')) + [IO.Path]::DirectorySeparatorChar
      if (!$resolvedTarget.StartsWith($testBoundary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Swap test must stay inside artifacts' }
      Call $installerType 'InstallArchive' @($path,$release,$resolvedTarget)
      Assert ((Get-Item -LiteralPath $resolvedTarget).VersionInfo.ProductVersion.Split('+')[0] -eq $Version) 'Portable replacement did not install the new version'
    }
    SetProperty $release 'Version' '99.99.99'
    Reject { Call $installerType 'VerifyPackage' @($path,$release) } 'Wrong MSI product version was accepted'
    SetProperty $release 'Version' $Version; SetProperty $release 'Sha256' ('f' * 64)
    Reject { Call $installerType 'VerifyPackage' @($path,$release) } 'Tampered installer checksum was accepted'
  } finally {
    # Remove only the exact test file and its empty private directory.
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    if ((Test-Path -LiteralPath $folder) -and @(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) { Remove-Item -LiteralPath $folder }
  }
}
Write-Output 'Updater checks passed: version policy, repository, architecture, digest, sizes, redirects, credential isolation, download rejection, MSI identity and tampering.'
