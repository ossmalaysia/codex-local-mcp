param([Parameter(Mandatory=$true)][string]$Executable, [string]$Preview)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$type = $assembly.GetType('CodexLocalMCP.Manager', $true)
$flags = [Reflection.BindingFlags]'Instance,NonPublic,Public'
function Field($Name) { $type.GetField($Name, $flags).GetValue($window) }
function Call($Name, [object[]]$Arguments) { $type.GetMethod($Name, $flags).Invoke($window, $Arguments) }
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
$window = [Activator]::CreateInstance($type, $true)
try {
  $window.ShowInTaskbar = $false
  $window.StartPosition = 'Manual'
  $window.Location = New-Object Drawing.Point(-32000, -32000)
  $window.Show()
  [Windows.Forms.Application]::DoEvents()
  Assert ($null -ne $window.Icon) 'Application icon is missing'
  Assert ((Field 'workspace').AccessibleName -eq 'Workspace folder') 'Workspace needs an accessible label'
  Call 'ShowStep' @(0)
  Assert ($window.AcceptButton -eq (Field 'next')) 'Enter must continue workspace setup'
  $window.Size = New-Object Drawing.Size(880, 620)
  [Windows.Forms.Application]::DoEvents()
  Assert ((Field 'workspace').Width -lt 600) 'Workspace field must adapt to a smaller window'
  Call 'ShowStep' @(2)
  Assert ($window.AcceptButton -eq (Field 'start')) 'Enter must start the connection on step 3'
  Assert ((Field 'next').Text -eq 'Open Claude guide') 'Claude guide button must explain its action'
  # Navigation must work with invalid unsaved fields and must not save or restart anything.
  (Field 'workspace').Text = 'invalid-test-path'
  (Field 'next').PerformClick()
  Assert ((Field 'currentStep') -eq 3) 'Claude guide tried to validate or save settings'
  Call 'ShowStep' @(2)
  (Field 'tunnel').SelectedIndex = 0
  Assert (!(Field 'namedFields').Visible) 'Quick Tunnel must hide named tunnel fields'
  (Field 'tunnel').SelectedIndex = 1
  Assert ((Field 'namedFields').Visible) 'Named Tunnel must show its configuration fields'
  if ($Preview) {
    $window.Size = New-Object Drawing.Size(1120, 940)
    [Windows.Forms.Application]::DoEvents()
    $bitmap = New-Object Drawing.Bitmap($window.Width,$window.Height)
    try { $window.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$window.Width,$window.Height))); $bitmap.Save([IO.Path]::GetFullPath($Preview)) } finally { $bitmap.Dispose() }
  }
  Call 'DetectEndpoint' @('Untrusted output https://example.invalid/mcp')
  Assert (!(Field 'copyUrl').Enabled) 'Only the ready message may enable URL copying'
  Call 'DetectEndpoint' @('codex-local-mcp ready: https://example.invalid/mcp (OAuth login required)')
  Assert ((Field 'endpoint').Text -eq 'https://example.invalid/mcp') 'Ready URL was not extracted'
  Assert ((Field 'copyUrl').Enabled) 'Ready URL must be available to copy'
  Assert ((Field 'currentStep') -eq 3) 'Ready connection must show Claude instructions'
  Call 'ConnectionStatus' @('Not connected', $false)
  Assert ((Field 'endpoint').Text -eq '' -and !(Field 'copyUrl').Enabled) 'Stopped connections must clear stale URLs'
  # Redaction test uses only synthetic in-memory settings. No settings are saved.
  $settings = [Activator]::CreateInstance($assembly.GetType('CodexLocalMCP.Settings'))
  $store = $assembly.GetType('CodexLocalMCP.Store')
  $secret = 'ui-smoke-test-secret-only'
  $settings.Password = $store.GetMethod('Protect').Invoke($null, @($secret))
  $type.GetField('saved', $flags).SetValue($window, $settings)
  Call 'Write' @("Sensitive output $secret")
  Assert (!(Field 'log').Text.Contains($secret)) 'Activity output exposed a password'
  Assert ((Field 'log').Text.Contains('[redacted]')) 'Activity output did not redact the password'
  Call 'InitializeTray' @('0.4.0-test')
  Assert ((Field 'tray').Visible) 'System tray icon is missing'
  Assert ((Field 'updateTimer').Interval -eq 15000) 'Startup update check is not scheduled'
  Assert ((Field 'updateAction').Text -eq 'Check for updates') 'Tray update action is missing'
  $type.GetField('trayTipShown',$flags).SetValue($window,$true)
  $window.Close()
  Assert (!$window.Visible -and !$window.IsDisposed) 'Closing must keep the application in the tray'
  $type.GetField('exitRequested',$flags).SetValue($window,$true)
  Write-Output 'Manager checks passed: branding, accessibility labels, navigation, tunnel fields, URL state, secret redaction.'
} finally { $window.Close(); $window.Dispose() }
