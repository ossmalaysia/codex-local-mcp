param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [switch]$Release
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$artifactsRoot = Join-Path $projectRoot 'artifacts'
$buildRoot = Join-Path $artifactsRoot ('windows-' + $Version)
$payload = Join-Path $buildRoot 'payload'
$cache = Join-Path $artifactsRoot 'build-tools'
New-Item -ItemType Directory -Force -Path $payload,$cache | Out-Null
$sha = (& git -c "safe.directory=$projectRoot" rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source commit' }
if ($Release) {
  $tagSha = (& git -c "safe.directory=$projectRoot" rev-list -n 1 "v$Version").Trim()
  if ($LASTEXITCODE -ne 0 -or $tagSha -ne $sha) { throw 'Release installer must be built from its exact version tag' }
  if (& git -c "safe.directory=$projectRoot" status --porcelain --untracked-files=no) { throw 'Release source checkout must be clean' }
}
$dependencies = Get-Content -LiteralPath 'installer/windows/dependencies.json' -Raw | ConvertFrom-Json
function Download-Checked($Item, [string]$Destination) {
  if (!(Test-Path -LiteralPath $Destination) -or (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Item.sha256) {
    Invoke-WebRequest -Uri $Item.url -OutFile $Destination
  }
  if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Item.sha256) { throw "Download integrity check failed: $Destination" }
}
Download-Checked $dependencies.node (Join-Path $cache 'node.zip')
$nodeDirectory = Join-Path $cache ('node-v' + $dependencies.node.version + '-win-x64')
if (!(Test-Path -LiteralPath (Join-Path $nodeDirectory 'node.exe'))) { Expand-Archive -LiteralPath (Join-Path $cache 'node.zip') -DestinationPath $cache }
$node = Join-Path $nodeDirectory 'node.exe'
$npm = Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js'
$runtime = Join-Path $payload 'runtime'
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'node'),(Join-Path $runtime 'codex') | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeDirectory 'node.exe') -Destination (Join-Path $runtime 'node/node.exe') -Force
Copy-Item -LiteralPath (Join-Path $nodeDirectory 'LICENSE') -Destination (Join-Path $runtime 'node/LICENSE') -Force
Download-Checked $dependencies.cloudflared (Join-Path $runtime 'cloudflared.exe')
$signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $runtime 'cloudflared.exe')
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Cloudflare*') { throw 'Cloudflare publisher signature verification failed' }
$packed = (& $node $npm pack $dependencies.codex.package --pack-destination $cache --json --ignore-scripts --registry=https://registry.npmjs.org | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Codex package download failed' }
if ($packed.integrity -ne $dependencies.codex.integrity) { throw 'Codex package integrity pin does not match' }
$codexDirectory = Join-Path $cache ('codex-' + $dependencies.codex.version)
New-Item -ItemType Directory -Force -Path $codexDirectory | Out-Null
& tar -xzf (Join-Path $cache $packed.filename) -C $codexDirectory
if ($LASTEXITCODE -ne 0) { throw 'Codex package extraction failed' }
$vendor = Join-Path $codexDirectory 'package/vendor/x86_64-pc-windows-msvc'
Copy-Item -Path (Join-Path $vendor 'bin/*') -Destination (Join-Path $runtime 'codex') -Recurse -Force
if (Test-Path -LiteralPath (Join-Path $vendor 'path')) { Copy-Item -LiteralPath (Join-Path $vendor 'path') -Destination (Join-Path $runtime 'codex/path') -Recurse -Force }
Copy-Item -Path (Join-Path $codexDirectory 'package/LICENSE*') -Destination (Join-Path $runtime 'codex') -ErrorAction SilentlyContinue
Download-Checked $dependencies.licenses.codex (Join-Path $runtime 'codex/LICENSE')
Download-Checked $dependencies.licenses.cloudflared (Join-Path $runtime 'CLOUDFLARE-LICENSE')
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'Application build failed' }
$app = Join-Path $payload 'app'
New-Item -ItemType Directory -Force -Path $app,(Join-Path $app 'scripts') | Out-Null
Copy-Item -LiteralPath 'dist' -Destination $app -Recurse -Force
Copy-Item -LiteralPath 'package.json','package-lock.json' -Destination $app -Force
Copy-Item -LiteralPath 'scripts/disabled-npm-plugin' -Destination (Join-Path $app 'scripts') -Recurse -Force
& $node $npm ci --prefix $app --omit=dev --ignore-scripts --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }
& $node $npm audit --prefix $app --omit=dev --audit-level=moderate
if ($LASTEXITCODE -ne 0) { throw 'Production dependency security audit failed' }
$package = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
$package.version = $Version
$package | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding utf8
Copy-Item -LiteralPath 'LICENSE','README.md','SECURITY.md' -Destination $payload -Force
Copy-Item -LiteralPath 'installer/windows/verify-installed.mjs' -Destination $payload -Force
$managerOutput = Join-Path $payload 'manager-build'
& dotnet build installer/windows/Manager/Manager.csproj -c Release "-p:Version=$Version" "-p:FileVersion=$Version.0" "-p:AssemblyVersion=$Version.0" -o $managerOutput --nologo
if ($LASTEXITCODE -ne 0) { throw 'Windows manager build failed' }
Get-ChildItem -LiteralPath $managerOutput -File | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $payload $_.Name) -Force }
Remove-Item -LiteralPath $managerOutput
$manifest = @{ product='codex-local-mcp'; version=$Version; commit=$sha; release=[bool]$Release; architecture='x64'; node=$dependencies.node; cloudflared=$dependencies.cloudflared; codex=$dependencies.codex; codexIntegrity=$packed.integrity; sandbox='isolated'; defaultWindowsSandbox='mxc'; defaultCommandNetworking=$false }
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $payload 'release-manifest.json') -Encoding utf8
$wix = Join-Path $cache 'wix5/wix.exe'
if (!(Test-Path -LiteralPath $wix)) {
  & dotnet tool install --tool-path (Join-Path $cache 'wix5') wix --version $dependencies.wix
  if ($LASTEXITCODE -ne 0) { throw 'WiX tool setup failed' }
}
& $wix extension add -g ("WixToolset.UI.wixext/" + $dependencies.wix)
if ($LASTEXITCODE -ne 0) { throw 'WiX UI extension setup failed' }
function Xml([string]$Value) { [System.Security.SecurityElement]::Escape($Value) }
function FileId([string]$Value) {
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { 'F' + ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').Substring(0,30) }
  finally { $hash.Dispose() }
}
$components = New-Object System.Collections.Generic.List[string]
function DirectoryXml([string]$Directory, [string]$Relative) {
  $result = New-Object Text.StringBuilder
  $files = @(Get-ChildItem -LiteralPath $Directory -File | Sort-Object Name)
  # JavaScript package files share a directory component. Thousands of registry
  # keypath components make Windows Installer validation and removal needlessly slow.
  # A membership change creates a new GUID; major upgrades remove the old product first.
  $componentId = FileId ('directory/' + $Relative)
  $membership = $Relative + ':' + (($files | ForEach-Object Name) -join '|')
  $guidHash = FileId $membership
  $componentGuid = [Guid]::ParseExact(($guidHash.Substring(1) + '00'), 'N').ToString()
  [void]$result.Append('<Component Id="C' + $componentId + '" Guid="' + $componentGuid + '">')
  foreach ($file in $files) {
    $relativeFile = ($Relative + '/' + $file.Name).TrimStart('/')
    $id = FileId $relativeFile
    $fileKey = if ($relativeFile -eq 'CodexMCP.exe') { 'ManagerExe' } else { $id }
    $shortcut = if ($relativeFile -eq 'CodexMCP.exe') { '<Shortcut Id="ManagerShortcut" Directory="ProgramMenuDir" Name="Codex Local MCP" WorkingDirectory="INSTALLFOLDER" Advertise="no" />' } else { '' }
    [void]$result.Append('<File Id="' + $fileKey + '" Source="' + (Xml $file.FullName) + '">' + $shortcut + '</File>')
  }
  [void]$result.Append('<RemoveFolder Id="R' + $componentId + '" On="uninstall" /><RegistryValue Root="HKCU" Key="Software\OSS Malaysia\CodexLocalMCP\Files" Name="' + $componentId + '" Value="1" Type="integer" KeyPath="yes" /></Component>')
  $components.Add('<ComponentRef Id="C' + $componentId + '" />')
  foreach ($child in Get-ChildItem -LiteralPath $Directory -Directory | Sort-Object Name) {
    $relativeChild = ($Relative + '/' + $child.Name).TrimStart('/')
    [void]$result.Append('<Directory Id="D' + (FileId $relativeChild) + '" Name="' + (Xml $child.Name) + '">' + (DirectoryXml $child.FullName $relativeChild) + '</Directory>')
  }
  $result.ToString()
}
$tree = DirectoryXml $payload ''
$licenseText = (Get-Content -LiteralPath LICENSE -Raw).Replace('\','\\').Replace('{','\{').Replace('}','\}').Replace("`r",'').Replace("`n",'\par ')
'{\rtf1\ansi\deff0{\fonttbl{\f0 Segoe UI;}}\fs20 ' + $licenseText + '}' | Set-Content -LiteralPath (Join-Path $buildRoot 'License.rtf') -Encoding ascii
$wxs = @"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
 <Package Name="Codex Local MCP" Manufacturer="OSS Malaysia" Version="$Version" UpgradeCode="2A3FA1B7-14D8-4DC8-978B-A0404A81D823" Scope="perUser">
  <MajorUpgrade DowngradeErrorMessage="A newer version is already installed." />
  <Property Id="MSIRESTARTMANAGERCONTROL" Value="Disable" />
  <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
  <StandardDirectory Id="LocalAppDataFolder"><Directory Id="ProgramsFolder" Name="Programs"><Directory Id="INSTALLFOLDER" Name="Codex Local MCP">$tree</Directory></Directory></StandardDirectory>
  <StandardDirectory Id="ProgramMenuFolder"><Directory Id="ProgramMenuDir" Name="Codex Local MCP"><Component Id="MenuCleanup" Guid="*"><RemoveFolder Id="RemoveMenu" On="uninstall" /><RegistryValue Root="HKCU" Key="Software\OSS Malaysia\CodexLocalMCP" Name="Menu" Value="1" Type="integer" KeyPath="yes" /></Component></Directory></StandardDirectory>
  <Feature Id="Main" Title="Codex Local MCP" Level="1">$($components -join '')<ComponentRef Id="MenuCleanup" /></Feature>
  <ui:WixUI Id="WixUI_Minimal" />
  <WixVariable Id="WixUILicenseRtf" Value="$(Xml (Join-Path $buildRoot 'License.rtf'))" />
  <Property Id="WIXUI_EXITDIALOGOPTIONALTEXT" Value="Open Codex Local MCP from the Start menu to configure your login, sandbox, and Cloudflare Tunnel. Configuration and workspaces are preserved during upgrades and uninstall." />
 </Package>
</Wix>
"@
$wxsFile = Join-Path $buildRoot 'Package.wxs'
$wxs | Set-Content -LiteralPath $wxsFile -Encoding utf8
$msi = Join-Path $artifactsRoot "CodexLocalMCP-$Version-windows-x64.msi"
& $wix build $wxsFile -arch x64 -ext WixToolset.UI.wixext -o $msi
if ($LASTEXITCODE -ne 0) { throw 'Windows installer compilation failed' }
$digest = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($msi + '.sha256'), ($digest + '  ' + (Split-Path -Leaf $msi) + "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Output "Installer built: $msi"
Write-Output "SHA256: $digest"
