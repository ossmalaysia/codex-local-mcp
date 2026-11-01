param([Parameter(Mandatory=$true)][string]$Executable, [string]$Codex, [string]$HomePath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$assembly=[Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$type=$assembly.GetType('CodexLocalMCP.AccountStatus',$true)
$flags=[Reflection.BindingFlags]'Public,NonPublic,Static,Instance'
function Assert($value,$message) { if (!$value) { throw $message } }
function Parse([string]$value) { $type.GetMethod('Parse',$flags).Invoke($null,@($value)) }
$account=Parse '{"result":{"account":{"type":"chatgpt","email":"test@example.com"}}}'
Assert ($account.SignedIn -and $account.Email -eq 'test@example.com') 'Signed-in email was not read'
Assert (!(Parse '{"result":{"account":null}}').SignedIn) 'Signed-out account reported signed in'
$key=Parse '{"result":{"account":{"type":"apiKey"}}}'
Assert ($key.SignedIn -and !$key.Email) 'API key status was incorrect'
Assert ((Parse '{"result":{"account":{"type":"chatgpt","email":null}}}').SignedIn) 'Account without email was rejected'
foreach ($invalid in @('{"error":{"message":"secret"}}','{}','{"result":{"account":{"type":"unknown"}}}','{"result":{"account":{"type":"chatgpt","email":"bad\nemail"}}}')) {
  $failed=$false; try { Parse $invalid | Out-Null } catch { $failed=$true }; Assert $failed 'Invalid response was accepted'
}
$manager=$assembly.GetType('CodexLocalMCP.Manager',$true)
$window=[Activator]::CreateInstance($manager,$true)
function Field($name) { $manager.GetField($name,$flags).GetValue($window) }
function Call($name,[object[]]$values) {
  for ($i=0;$i -lt $values.Length;$i++) { if ($null -ne $values[$i]) { $values[$i]=$values[$i].PSObject.BaseObject } }
  $manager.GetMethod($name,$flags).Invoke($window,$values)
}
try {
  Call 'DisplayAccount' @($account)
  Assert ((Field 'accountState').Text -match 'Already signed in.*test@example.com') 'UI did not display signed-in email'
  Assert ((Field 'login').Text -eq 'Sign in with another account') 'UI asked a signed-in user to sign in again'
  $settings=[Activator]::CreateInstance($assembly.GetType('CodexLocalMCP.Settings'))
  $store=$assembly.GetType('CodexLocalMCP.Store')
  $settings.Password=$store.GetMethod('Protect',$flags).Invoke($null,@('synthetic-password-for-ui-test'))
  $settings.Tunnel='named';$settings.PublicUrl='https://codex.example.com';$settings.TunnelToken=$store.GetMethod('Protect',$flags).Invoke($null,@('synthetic-tunnel-token'))
  $manager.GetField('saved',$flags).SetValue($window,$settings)
  (Field 'password').Clear()
  Call 'UpdatePasswordHint' @()
  Assert ((Field 'passwordState').Text -match '^Password saved') 'Saved password status was missing'
  (Field 'tunnel').SelectedIndex=1;(Field 'publicUrl').Text=$settings.PublicUrl
  Call 'UpdateSavedCloudflare' @()
  Assert (!(Field 'cloudflareSetupFields').Visible) 'Saved address still asked for creation'
  Assert ((Field 'cloudflareSavedAddress').Text -match 'Address configured: https://codex.example.com') 'Saved address status missing'
  Call 'UpdateEndpointPreview' @()
  Assert ((Field 'endpoint').Text -eq 'https://codex.example.com/mcp') 'Configured MCP URL was missing before startup'
  Assert ((Field 'endpointHint').Text -match 'Start the connection') 'Configured URL was incorrectly shown as running'
  Call 'ConnectionStatus' @('Not connected',$false)
  Assert ((Field 'endpoint').Text -eq 'https://codex.example.com/mcp') 'Stopped named tunnel lost its configured URL'
  (Field 'tunnel').SelectedIndex=0
  Assert (!(Field 'endpoint').Text) 'Quick Tunnel displayed a stale URL'
} finally { $window.Dispose() }
if ($Codex) {
  [Threading.SynchronizationContext]::SetSynchronizationContext($null)
  if (!$HomePath) { throw 'A test account home is required' }
  $info=$type.GetMethod('Info',$flags).Invoke($null,@([string][IO.Path]::GetFullPath($Codex),[string]$HomePath,$true))
  Assert (!$info.EnvironmentVariables.ContainsKey('CODEX_MCP_PASSWORD')) 'Account process inherited the MCP password'
  Assert (!$info.EnvironmentVariables.ContainsKey('OPENAI_API_KEY')) 'Account process inherited an unrelated API key'
  $task=$type.GetMethod('Read',$flags).Invoke($null,@($info,[Threading.CancellationToken]::None))
  $result=$task.GetAwaiter().GetResult()
  Write-Output ('Native account check completed. Signed in: '+$result.SignedIn+'. Email available: '+[bool]$result.Email+'. No model call was made.')
}
Write-Output 'Account UI checks passed: identity, saved password, saved custom address, and configured MCP URL.'
