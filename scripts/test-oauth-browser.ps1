param([Parameter(Mandatory=$true)][string]$BaseUri)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
$handler=New-Object Net.Http.HttpClientHandler
$handler.AllowAutoRedirect=$false
$handler.UseCookies=$true
$client=New-Object Net.Http.HttpClient($handler)
$client.Timeout=[TimeSpan]::FromSeconds(15)
function Send([string]$method,[string]$path,[string]$body,[bool]$json=$false) {
  $request=New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::new($method),($BaseUri+$path))
  if ($body) { $request.Content=New-Object Net.Http.StringContent($body,[Text.Encoding]::UTF8,$(if ($json) {'application/json'} else {'application/x-www-form-urlencoded'})) }
  if ($method -eq 'POST' -and $path -eq '/login') { $request.Headers.TryAddWithoutValidation('Origin',$BaseUri) | Out-Null }
  $client.SendAsync($request).GetAwaiter().GetResult()
}
function Assert($value,$message) { if (!$value) { throw $message } }
try {
  $registration=Send POST '/register' '{"client_name":"Windows cookie test","redirect_uris":["http://127.0.0.1:54321/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}' $true
  Assert ([int]$registration.StatusCode -eq 201) 'Client registration failed'
  $id=($registration.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).client_id
  $verifier='a'*43
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $challenge=[Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($verifier))).TrimEnd('=').Replace('+','-').Replace('/','_') } finally { $sha.Dispose() }
  $query='client_id='+$id+'&redirect_uri='+[Uri]::EscapeDataString('http://127.0.0.1:54321/callback')+'&response_type=code&code_challenge='+$challenge+'&code_challenge_method=S256&scope=codex%3Aaccess&resource='+[Uri]::EscapeDataString($BaseUri+'/mcp')
  $authorization=Send GET ('/authorize?'+$query) ''
  $html=$authorization.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $requestId=[Regex]::Match($html,'name="request_id" value="([^"]+)"').Groups[1].Value
  Assert ($handler.CookieContainer.GetCookies([Uri]($BaseUri+'/login')).Count -eq 1) 'The HTTP cookie jar rejected the login cookie'
  $prefix='request_id='+$requestId+'&username=admin&password='
  $wrong=Send POST '/login' ($prefix+'wrong')
  Assert ([int]$wrong.StatusCode -eq 401) 'Wrong password was not rejected'
  Assert ($wrong.Content.ReadAsStringAsync().GetAwaiter().GetResult().Contains('<form')) 'Wrong password did not preserve a usable form'
  $login=Send POST '/login' ($prefix+'browser-cookie-test-password-only')
  Assert ([int]$login.StatusCode -eq 303) 'Correct password failed after retry with automatically stored cookies'
  $callback=[Uri]$login.Headers.Location
  $code=[Regex]::Match($callback.Query,'[?&]code=([^&]+)').Groups[1].Value
  $exchange=Send POST '/token' ('client_id='+$id+'&grant_type=authorization_code&code='+$code+'&code_verifier='+$verifier+'&redirect_uri='+[Uri]::EscapeDataString('http://127.0.0.1:54321/callback')+'&resource='+[Uri]::EscapeDataString($BaseUri+'/mcp'))
  Assert ([int]$exchange.StatusCode -eq 200) 'PKCE token exchange failed'
  Write-Output 'Automatic cookie storage, wrong-password retry, login redirect, and PKCE token exchange passed.'
} finally { $client.Dispose() }
