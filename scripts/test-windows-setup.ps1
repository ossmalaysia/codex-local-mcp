param([Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$setup=Join-Path $project "artifacts/CodexLocalMCP-$Version-windows-x64-setup.exe"
$target=[IO.Path]::GetFullPath((Join-Path $project "artifacts/setup lifecycle $Version"))
$boundary=[IO.Path]::GetFullPath((Join-Path $project 'artifacts'))+'\'
if (!$target.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Setup test escaped artifacts' }
$testId=[Guid]::NewGuid().ToString('N')
$support=Join-Path $env:LOCALAPPDATA "CodexLocalMCPData/installer-tests/$testId"
$registry="HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/CodexLocalMCP-App-Test-$testId"
$settings=Join-Path $env:LOCALAPPDATA 'CodexLocalMCPData/settings.json'
$settingsHash=if (Test-Path -LiteralPath $settings) { (Get-FileHash -LiteralPath $settings).Hash } else { $null }
$installed=$false
$watch=[Diagnostics.Stopwatch]::StartNew()
try {
  $errorLog=Join-Path $project "artifacts/setup-$Version-test.error.log"
  $process=Start-Process -FilePath $setup -ArgumentList @('--silent','--test-id',$testId,'--target',('"'+$target+'"'),'--no-shortcuts') -WindowStyle Hidden -Wait -PassThru -RedirectStandardError $errorLog
  if ($process.ExitCode -ne 0) { throw "Setup installation failed: $($process.ExitCode). $(Get-Content -LiteralPath $errorLog -Raw)" }
  $installed=$true; $watch.Stop()
  Write-Output "Setup install duration: $([math]::Round($watch.Elapsed.TotalSeconds,2)) seconds."
  if ((Get-Item -LiteralPath (Join-Path $target 'CodexMCP.exe')).VersionInfo.ProductVersion.Split('+')[0] -ne $Version) { throw 'Installed app version is incorrect' }
  if ((Get-ItemProperty -LiteralPath $registry).DisplayVersion -ne $Version) { throw 'Windows Installed apps version is incorrect' }
  & powershell.exe -NoProfile -STA -File (Join-Path $project 'installer/windows/test-manager.ps1') -Executable (Join-Path $target 'CodexMCP.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Installed app UI checks failed' }
  & powershell.exe -NoProfile -STA -File (Join-Path $project 'installer/windows/test-accounts.ps1') -Executable (Join-Path $target 'CodexMCP.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Installed app saved account checks failed' }
  & (Join-Path $target 'runtime/node/node.exe') (Join-Path $target 'verify-installed.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Installed app protocol checks failed' }
  [IO.File]::WriteAllText((Join-Path $target 'user-notes.txt'),'test user file; uninstall must preserve it')
} finally {
  if ($installed) {
    $process=Start-Process -FilePath (Join-Path $support 'Uninstall.exe') -ArgumentList @('--uninstall','--silent','--record',('"'+(Join-Path $support 'install.json')+'"')) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
    if (Test-Path -LiteralPath (Join-Path $target 'CodexMCP.exe')) { throw 'Uninstall left the app executable' }
    if (Test-Path -LiteralPath $registry) { throw 'Uninstall left the Installed apps entry' }
    if (!(Test-Path -LiteralPath (Join-Path $target 'user-notes.txt'))) { throw 'Uninstall removed user files' }
    if ($settingsHash -and (Get-FileHash -LiteralPath $settings).Hash -ne $settingsHash) { throw 'Setup changed saved settings' }
    Remove-Item -LiteralPath (Join-Path $target 'user-notes.txt')
    if (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) { Remove-Item -LiteralPath $target }
    foreach ($name in @('Uninstall.exe','install.json')) { $file=Join-Path $support $name; if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file } }
    if (@(Get-ChildItem -LiteralPath $support -Force).Count -eq 0) { Remove-Item -LiteralPath $support }
    Write-Output 'Setup and uninstall verified: version, Installed apps, UI, OAuth/MCP, user file preservation, and saved settings.'
  }
}
