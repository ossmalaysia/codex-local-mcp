param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [string]$Output = 'artifacts/native'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (!$cargo) { $cargo = Get-Command (Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe') -ErrorAction Stop }
$destination = [IO.Path]::GetFullPath((Join-Path $projectRoot $Output))
$boundary = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts')) + '\'
if (!$destination.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native build output must stay inside artifacts' }
$previousVersion = $env:CODEX_MCP_BUILD_VERSION
try {
  $env:CODEX_MCP_BUILD_VERSION = $Version
  & $cargo.Source build --locked --release --bin codex-mcp-service
  if ($LASTEXITCODE -ne 0) { throw 'Native service build failed' }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot 'target/release/codex-mcp-service.exe') -Destination $destination -Force
  $reported = & (Join-Path $destination 'codex-mcp-service.exe') --version
  if ($LASTEXITCODE -ne 0 -or $reported -ne "codex-mcp-service $Version") { throw 'Native service version does not match the package' }
  # Preserve upstream license texts for the locked native dependency graph.
  $metadata = (& $cargo.Source metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read native dependency metadata' }
  $notices = New-Object Text.StringBuilder
  foreach ($package in $metadata.packages | Sort-Object name,version) {
    [void]$notices.AppendLine("--- $($package.name) $($package.version) [$($package.license)] ---")
    $directory = Split-Path -Parent $package.manifest_path
    $licenses = @(Get-ChildItem -LiteralPath $directory -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE)([._-]|$)' })
    if ($package.license_file) { $licenses += Get-Item -LiteralPath (Join-Path $directory $package.license_file) }
    if ($package.source -and $licenses.Count -eq 0) { throw "Missing dependency license text: $($package.name)" }
    foreach ($file in $licenses | Sort-Object FullName -Unique) { [void]$notices.AppendLine([IO.File]::ReadAllText($file.FullName)) }
  }
  [IO.File]::WriteAllText((Join-Path $destination 'NATIVE-LICENSES.txt'), $notices.ToString(), (New-Object Text.UTF8Encoding($false)))
  Write-Output "Native service built and version checked: $destination"
} finally {
  $env:CODEX_MCP_BUILD_VERSION = $previousVersion
}
