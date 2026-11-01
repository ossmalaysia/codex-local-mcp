param([Parameter(Mandatory=$true)][string]$Executable, [string]$Preview)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$assembly=[Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$type=$assembly.GetType('CodexLocalMCP.Manager',$true)
$flags=[Reflection.BindingFlags]'Instance,NonPublic,Public'
$window=[Activator]::CreateInstance($type,$true)
function Field($name) { $type.GetField($name,$flags).GetValue($window) }
function Call($name,[object[]]$values) {
  for ($i=0;$i -lt $values.Length;$i++) { if ($null -ne $values[$i]) { $values[$i]=$values[$i].PSObject.BaseObject } }
  $type.GetMethod($name,$flags).Invoke($window,$values)
}
function Assert($condition,$message) { if (!$condition) { throw $message } }
function Send($value) { Call 'Write' @('codex-local-mcp activity: '+($value | ConvertTo-Json -Compress)) }
try {
  $window.ShowInTaskbar=$false; $window.StartPosition='Manual';$window.Location=New-Object Drawing.Point(-32000,-32000)
  $window.Show();[Windows.Forms.Application]::DoEvents();Call 'ShowStep' @(4)
  Assert ((Field 'activitySummary').Text -eq 'Waiting for requests') 'Idle state was missing'
  Send @{v=1;type='request';action='codex_generate_image'}
  Assert ((Field 'latestRequest').Text -match 'Request received: Generate image') 'Request was not visible'
  $settings=Field 'saved'
  $id=[Guid]::NewGuid().ToString()
  $event=@{v=1;type='job';id=$id;action='codex_generate_image';workspace=(Join-Path $settings.Workspace 'activity-test-image');status='running';phase='running';elapsedMs=12000}
  Send $event
  Assert ((Field 'taskActivity').Items.Count -eq 1) 'Running task was not listed'
  Assert ((Field 'activitySummary').Text -eq '1 task running') 'Active task count was missing'
  Assert ((Field 'taskActivity').Items[0].SubItems[1].Text -eq 'Generating image') 'Generation status was missing'
  Assert ((Field 'taskActivity').Items[0].SubItems[2].Text -eq '00:00:12') 'Elapsed time was incorrect'
  $event.phase='writing_files';$event.elapsedMs=16000;Send $event
  Assert ((Field 'taskActivity').Items.Count -eq 1) 'Progress created a duplicate task'
  Assert ((Field 'taskActivity').Items[0].SubItems[1].Text -eq 'Writing files') 'Phase did not update'
  $event.status='completed';$event.files=1;$event.exitCode=0;$event.elapsedMs=17000;Send $event
  Assert ((Field 'activitySummary').Text -eq 'No tasks running') 'Completed task stayed active'
  Assert ((Field 'taskActivity').Items[0].SubItems[3].Text -eq '1') 'Completed file count was missing'
  Assert ((Field 'log').Text -notmatch 'codex-local-mcp activity:') 'Structured telemetry polluted connection logs'
  $event.id=[Guid]::NewGuid().ToString();$event.status='failed';$event.timedOut=$true;Send $event
  Assert ((Field 'taskActivity').Items[0].SubItems[1].Text -eq 'Timed out') 'Timeout status was missing'
  $event.id=[Guid]::NewGuid().ToString();$event.workspace='C:\Windows';Send $event
  Assert ((Field 'taskActivity').Items.Count -eq 2) 'An outside workspace was accepted'
  $event.workspace=Join-Path $settings.Workspace 'activity-test-active';$event.id=[Guid]::NewGuid().ToString();$event.status='running';$event.phase='running_command';$event.timedOut=$false;$event.elapsedMs=5000;Send $event
  Call 'ConnectionStatus' @('Not connected',$false)
  Assert ((Field 'activitySummary').Text -eq 'No tasks running') 'Stopped server left a task active'
  Assert ((Field 'taskActivity').Items[0].SubItems[1].Text -eq 'Connection stopped') 'Interrupted task was shown as successful'
  $event.id=[Guid]::NewGuid().ToString();$event.action='codex_run';$event.phase='running';$event.elapsedMs=7000;Send $event
  if ($Preview) {
    $window.Size=New-Object Drawing.Size(1120,940);[Windows.Forms.Application]::DoEvents()
    $bitmap=New-Object Drawing.Bitmap($window.Width,$window.Height)
    try { $window.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$window.Width,$window.Height)));$bitmap.Save([IO.Path]::GetFullPath($Preview)) } finally { $bitmap.Dispose() }
  }
  Write-Output 'Activity UI checks passed: requests, progress, elapsed time, completion, timeouts, workspace validation, and interrupted tasks.'
} finally { $window.Dispose() }
