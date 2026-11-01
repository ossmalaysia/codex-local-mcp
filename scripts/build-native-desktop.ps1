param([Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,[switch]$Release)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
$cargo=Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
if (!(Test-Path -LiteralPath $cargo)) { $cargo=(Get-Command cargo -ErrorAction Stop).Source }
# The legacy package remains an upgrade bridge for already installed 0.5 managers.
& "$PSScriptRoot/build-windows.ps1" -Version $Version -PortableOnly -NativeService -Release:$Release
if ($LASTEXITCODE -ne 0) { throw 'Dependency package build failed' }
$payload=Join-Path $project "artifacts/windows-$Version/payload"
$clean=Join-Path $project "artifacts/native-desktop-$Version/payload"
if (Test-Path -LiteralPath $clean) {
  $existing=Get-Content -LiteralPath (Join-Path $clean 'release-manifest.json') -Raw | ConvertFrom-Json
  if ($existing.product -ne 'codex-local-mcp' -or $existing.version -ne $Version -or $existing.desktop -ne 'tauri') { throw 'The native output folder does not match this build' }
}
& node scripts/build-desktop-ui.mjs
if ($LASTEXITCODE -ne 0) { throw 'Desktop interface build failed' }
$previous=$env:TAURI_CONFIG
try {
  $env:TAURI_CONFIG='{"version":"'+$Version+'"}'
  & $cargo build --locked --release -p codex-mcp-desktop -p codex-mcp-release
  if ($LASTEXITCODE -ne 0) { throw 'Rust desktop build failed' }
} finally { $env:TAURI_CONFIG=$previous }
$exe=Join-Path $project 'target/release/CodexMCP.exe'
$info=(Get-Item -LiteralPath $exe).VersionInfo
if ($info.ProductVersion.Split('+')[0] -ne $Version -or $info.ProductName -ne 'Codex Local MCP') { throw 'Desktop version resource is incorrect' }
Copy-Item -LiteralPath $exe -Destination (Join-Path $payload 'CodexMCP.exe') -Force
$manifestPath=Join-Path $payload 'release-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest | Add-Member -NotePropertyName desktop -NotePropertyValue tauri -Force
[IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 15),(New-Object Text.UTF8Encoding($false)))
$inventory=[ordered]@{}
foreach ($directory in @('app','runtime/node')) {
  foreach ($file in Get-ChildItem -LiteralPath (Join-Path $payload $directory) -Recurse -File) {
    $relative=$file.FullName.Substring($payload.Length+1).Replace('\','/')
    $inventory[$relative]=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  }
}
foreach ($name in @('CodexMCP.exe.config','CodexMCP.pdb','verify-installed.mjs')) {
  $file=Join-Path $payload $name
  if (Test-Path -LiteralPath $file) { $inventory[$name]=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() }
}
[IO.File]::WriteAllText((Join-Path $payload 'runtime/migration.json'),($inventory | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
New-Item -ItemType Directory -Path (Join-Path $clean 'runtime') -Force | Out-Null
foreach ($name in @('CodexMCP.exe','LICENSE','README.md','SECURITY.md','THIRD-PARTY-NOTICES.txt','release-manifest.json')) {
  Copy-Item -LiteralPath (Join-Path $payload $name) -Destination $clean -Force
}
foreach ($name in @('codex','cloudflared.exe','CLOUDFLARE-LICENSE','codex-mcp-service.exe','NATIVE-LICENSES.txt')) {
  Copy-Item -LiteralPath (Join-Path $payload "runtime/$name") -Destination (Join-Path $clean 'runtime') -Recurse -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Package([string]$Source,[string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination }
  [IO.Compression.ZipFile]::CreateFromDirectory($Source,$Destination,[IO.Compression.CompressionLevel]::Fastest,$false)
  $hash=(Get-FileHash -LiteralPath $Destination).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($Destination+'.sha256',$hash+'  '+[IO.Path]::GetFileName($Destination)+"`n",(New-Object Text.UTF8Encoding($false)))
}
$legacyZip=Join-Path $project "artifacts/CodexLocalMCP-$Version-windows-x64.zip"
Package $payload $legacyZip
$nativeZip=Join-Path $project "artifacts/CodexLocalMCP-$Version-native-windows-x64.zip"
Package $clean $nativeZip
& "$PSScriptRoot/build-setup.ps1" -Version $Version -Payload $clean -Package $nativeZip
if ($LASTEXITCODE -ne 0) { throw 'Native setup build failed' }
$setup=Join-Path $project "artifacts/CodexLocalMCP-$Version-windows-x64-setup.exe"
$update=[ordered]@{product='codex-local-mcp';version=$Version;architecture='x64';url="https://github.com/ossmalaysia/codex-local-mcp/releases/download/v$Version/CodexLocalMCP-$Version-windows-x64-setup.exe";sha256=(Get-FileHash -LiteralPath $setup).Hash.ToLowerInvariant();size=(Get-Item -LiteralPath $setup).Length}
$metadata=Join-Path $project 'artifacts/update.json'
[IO.File]::WriteAllText($metadata,($update|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
& (Join-Path $project 'target/release/codex-mcp-release.exe') sign $metadata
if ($LASTEXITCODE -ne 0) { throw 'Update signing failed' }
Write-Output "Native desktop and signed update built: $setup"
