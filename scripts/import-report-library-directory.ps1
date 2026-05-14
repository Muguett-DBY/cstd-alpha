param(
  [string]$InputDir = "E:\DEV\测试\cstd-alpha-opencode-batch\production",
  [string]$BaseUrl,
  [string]$Password,
  [int]$DelayMilliseconds = 200,
  [switch]$ContinueOnError
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl -or -not $Password) {
  $accessPath = "E:\DEV\codex-tools\cstd-alpha-access.txt"
  if (Test-Path $accessPath) {
    $access = Get-Content $accessPath
    if (-not $BaseUrl) {
      $BaseUrl = (($access | Where-Object { $_ -match '^URL[:=]' } | Select-Object -First 1) -replace '^[^:=]+[:=]\s*','').Trim()
    }
    if (-not $Password) {
      $Password = (($access | Where-Object { $_ -match '^REPORT_PASSWORD[:=]' } | Select-Object -First 1) -replace '^[^:=]+[:=]\s*','').Trim()
    }
  }
}

if (-not $BaseUrl) { throw "BaseUrl is required." }
if (-not $Password) { throw "Password is required." }
if (-not (Test-Path $InputDir)) { throw "InputDir not found: $InputDir" }

function Invoke-JsonPost {
  param(
    [string]$Uri,
    [string]$Body,
    [string]$CookieHeader
  )
  $responsePath = [System.IO.Path]::GetTempFileName()
  try {
    $httpCode = (curl.exe -L --http1.1 --ssl-no-revoke --silent --show-error --connect-timeout 15 --max-time 180 -o $responsePath -w "%{http_code}" -X POST -H "Content-Type: application/json; charset=utf-8" -H "Cookie: $CookieHeader" --data-binary "@$Body" $Uri) -join ""
    $raw = if (Test-Path -LiteralPath $responsePath) { Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 } else { "" }
    if ($LASTEXITCODE -ne 0 -or -not ($httpCode -match "^2\d\d$")) {
      throw "POST $Uri failed with HTTP $httpCode. $raw"
    }
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
  }
}

$loginPath = Join-Path ([System.IO.Path]::GetTempPath()) ("cstd-login-" + [guid]::NewGuid().ToString("N") + ".json")
@{ password = $Password } | ConvertTo-Json | Set-Content -LiteralPath $loginPath -Encoding UTF8
try {
  $loginBody = Get-Content -LiteralPath $loginPath -Raw -Encoding UTF8
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $loginResponse = Invoke-WebRequest -Uri "$BaseUrl/api/session" -Method Post -ContentType "application/json" -Body $loginBody -WebSession $session -UseBasicParsing -TimeoutSec 60
  if ($loginResponse.Content -and $loginResponse.Content.TrimStart().StartsWith("{")) {
    $login = $loginResponse.Content | ConvertFrom-Json
    if ($login.error) { throw "Login failed: $($login.error)" }
  }
  if ($session.Cookies.Count -lt 1) { throw "Login did not return a session cookie." }
  $cookies = @()
  foreach ($cookie in $session.Cookies.GetCookies([uri]$BaseUrl)) {
    $cookies += "$($cookie.Name)=$($cookie.Value)"
  }
  $cookieHeader = $cookies -join "; "
  if (-not $cookieHeader) { throw "Login did not return a usable session cookie." }

  $reports = Get-ChildItem -LiteralPath $InputDir -Recurse -Filter report.json |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName "status.json") } |
    Sort-Object FullName
  $imported = 0
  $failed = 0
  foreach ($reportPath in $reports) {
    $bodyPath = Join-Path $reportPath.DirectoryName "import-request.json"
    $reportRaw = Get-Content -LiteralPath $reportPath.FullName -Raw -Encoding UTF8
    try {
      $null = $reportRaw | ConvertFrom-Json
    } catch {
      $failed += 1
      Write-Output "FAILED $($reportPath.FullName): invalid local report JSON: $($_.Exception.Message)"
      if (-not $ContinueOnError) { throw }
      continue
    }
    ('{"reports":[' + $reportRaw + ']}') | Set-Content -LiteralPath $bodyPath -Encoding UTF8
    try {
      Invoke-JsonPost -Uri "$BaseUrl/api/report-library" -Body $bodyPath -CookieHeader $cookieHeader | Out-Null
      $imported += 1
      Write-Output "IMPORTED $imported/$($reports.Count) $($reportPath.Directory.Name)"
    } catch {
      $failed += 1
      Write-Output "FAILED $($reportPath.FullName): $($_.Exception.Message)"
      if (-not $ContinueOnError) { throw }
    }
    if ($DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $DelayMilliseconds }
  }

  [pscustomobject]@{
    inputDir = $InputDir
    total = $reports.Count
    imported = $imported
    failed = $failed
  } | ConvertTo-Json
} finally {
  Remove-Item -LiteralPath $loginPath -Force -ErrorAction SilentlyContinue
}
