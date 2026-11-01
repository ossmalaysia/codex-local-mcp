param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][string]$Package
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$artifacts=[IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts'))
$payloadPath=[IO.Path]::GetFullPath($Payload); $packagePath=[IO.Path]::GetFullPath($Package)
if (!$payloadPath.StartsWith($artifacts+'\',[StringComparison]::OrdinalIgnoreCase) -or !$packagePath.StartsWith($artifacts+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Setup inputs must stay inside artifacts' }
$manifest=Get-Content -LiteralPath (Join-Path $payloadPath 'release-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) { throw 'Setup and payload versions must match' }
$build=Join-Path $artifacts "setup-$Version"
New-Item -ItemType Directory -Path $build -Force | Out-Null
$metadata=Join-Path $build 'setup.json'
@{version=$Version;sha256=(Get-FileHash -LiteralPath $packagePath).Hash.ToLowerInvariant();size=(Get-Item -LiteralPath $packagePath).Length} | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8
$project=Join-Path $projectRoot 'installer/windows/Setup/Setup.csproj'
$webview=Join-Path $artifacts 'build-tools/MicrosoftEdgeWebview2Setup.exe'
if ($manifest.desktop -eq 'tauri') {
  if (!(Test-Path -LiteralPath $webview)) { Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $webview }
  $signature=Get-AuthenticodeSignature -LiteralPath $webview
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') { throw 'WebView2 publisher signature verification failed' }
} else { $webview='' }
$uninstallerOutput=Join-Path $build 'uninstaller'
& dotnet build $project -c Release "-p:Version=$Version" "-p:FileVersion=$Version.0" "-p:AssemblyVersion=$Version.0" '-p:AssemblyName=CodexLocalMCP-Uninstall' "-p:SetupMetadata=$metadata" -o $uninstallerOutput --nologo
if ($LASTEXITCODE -ne 0) { throw 'Uninstaller build failed' }
$uninstaller=Join-Path $uninstallerOutput 'CodexLocalMCP-Uninstall.exe'
$setupOutput=Join-Path $build 'bootstrap'
& dotnet build $project -c Release "-p:Version=$Version" "-p:FileVersion=$Version.0" "-p:AssemblyVersion=$Version.0" "-p:SetupMetadata=$metadata" "-p:SetupPayload=$packagePath" "-p:SetupUninstaller=$uninstaller" "-p:WebViewBootstrapper=$webview" -o $setupOutput --nologo
if ($LASTEXITCODE -ne 0) { throw 'Setup executable build failed' }
$setup=Join-Path $artifacts "CodexLocalMCP-$Version-windows-x64-setup.exe"
Copy-Item -LiteralPath (Join-Path $setupOutput 'CodexLocalMCP-Setup.exe') -Destination $setup -Force
$digest=(Get-FileHash -LiteralPath $setup).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($setup+'.sha256'),($digest+'  '+[IO.Path]::GetFileName($setup)+"`n"),(New-Object Text.UTF8Encoding($false)))
Write-Output "Setup executable built: $setup"
Write-Output "Setup SHA256: $digest"
