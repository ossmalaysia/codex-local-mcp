param([Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$msi = Join-Path $projectRoot "artifacts/CodexLocalMCP-$Version-windows-x64.msi"
$target = [IO.Path]::GetFullPath((Join-Path $projectRoot "artifacts/install test $Version"))
$boundary = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts')) + [IO.Path]::DirectorySeparatorChar
if (!$target.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test install target is outside artifacts' }
$log = Join-Path $projectRoot "artifacts/install-test-$Version.log"
$arguments = @('/i',('"' + $msi + '"'),'/qn','/norestart',('INSTALLFOLDER="' + $target + '"'),'/l*v',('"' + $log + '"'))
$installed = $false
try {
  $process = Start-Process -FilePath msiexec.exe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -notin @(0,3010)) { throw "MSI test installation failed: $($process.ExitCode). See $log" }
  $installed = $true
  $manifest = Get-Content -LiteralPath (Join-Path $target 'release-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.version -ne $Version) { throw 'Installed release manifest has the wrong version' }
  $appVersion = (Get-Item -LiteralPath (Join-Path $target 'CodexMCP.exe')).VersionInfo.ProductVersion
  if ($appVersion -notlike "$Version*") { throw 'Windows executable has the wrong version' }
  $selfTest = Start-Process -FilePath (Join-Path $target 'CodexMCP.exe') -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
  if ($selfTest.ExitCode -ne 0) { throw "Manager self-test failed: $($selfTest.ExitCode)" }
  & (Join-Path $target 'runtime/node/node.exe') --version
  if ($LASTEXITCODE -ne 0) { throw 'Bundled Node failed' }
  & (Join-Path $target 'runtime/codex/codex.exe') --version
  if ($LASTEXITCODE -ne 0) { throw 'Bundled Codex failed' }
  & (Join-Path $target 'runtime/cloudflared.exe') --version
  if ($LASTEXITCODE -ne 0) { throw 'Bundled Cloudflare connector failed' }
  $installedPackage = Get-Content -LiteralPath (Join-Path $target 'app/package.json') -Raw | ConvertFrom-Json
  if ($installedPackage.version -ne $Version) { throw 'MCP server has the wrong version' }
  & (Join-Path $target 'runtime/node/node.exe') (Join-Path $target 'verify-installed.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Installed MCP protocol smoke test failed' }
  Write-Output "Installed MSI verified: $Version, DPAPI, bundled tools, runtime metadata."
} finally {
  if ($installed) {
    $uninstallLog = Join-Path $projectRoot "artifacts/uninstall-test-$Version.log"
    $process = Start-Process -FilePath msiexec.exe -ArgumentList @('/x',('"' + $msi + '"'),'/qn','/norestart','/l*v',('"' + $uninstallLog + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -notin @(0,3010)) { throw "MSI uninstall test failed: $($process.ExitCode)" }
    if (Test-Path -LiteralPath (Join-Path $target 'CodexMCP.exe')) { throw 'MSI uninstall left the application executable' }
    Write-Output 'MSI uninstall verified.'
  }
}
