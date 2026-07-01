param(
  [string]$AccessFile = $(if ($env:CSTD_ALPHA_ACCESS_FILE) { $env:CSTD_ALPHA_ACCESS_FILE } else { "" }),
  [string]$OutputDir = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".tmp\cstd-alpha-online-regression"),
  [int]$ReportTimeoutSeconds = 2400,
  [switch]$SkipRefresh
)

$ErrorActionPreference = 'Stop'

function Read-AccessConfig {
  param([string]$Path)
  if (-not $Path) { throw "Access file is required. Pass -AccessFile or set CSTD_ALPHA_ACCESS_FILE." }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\s*([^:=\s]+)\s*[:=]\s*(.*?)\s*$') {
      $key = $Matches[1].Trim()
      $value = $Matches[2].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$key] = $value
    }
  }
  $url = $values["URL"]
  $username = $values["REPORT_USERNAME"]
  if (-not $username) { $username = $values["USERNAME"] }
  if (-not $username) { $username = $values["ADMIN_USERNAME"] }
  $password = $values["REPORT_PASSWORD"]
  if (-not $url -or -not $username -or -not $password) { throw "Access file is missing URL, USERNAME/REPORT_USERNAME, or REPORT_PASSWORD." }
  [pscustomobject]@{ Url = $url.TrimEnd('/'); Username = $username; Password = $password }
}

function Invoke-Json {
  param(
    [string]$Uri,
    [string]$Method = 'GET',
    [object]$Body = $null,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
    [int]$TimeoutSec = 120
  )
  $params = @{
    Uri = $Uri
    Method = $Method
    WebSession = $Session
    UseBasicParsing = $true
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = $Body | ConvertTo-Json -Depth 12
  }
  Invoke-WebRequest @params
}

function Select-Candidate {
  param(
    [object[]]$Candidates,
    [string]$ExpectedCode
  )
  $candidate = $Candidates | Where-Object { $_.code -eq $ExpectedCode -or $_.symbol -eq $ExpectedCode } | Select-Object -First 1
  if (-not $candidate) { $candidate = $Candidates | Select-Object -First 1 }
  if (-not $candidate) { throw "No company candidate returned for expected code $ExpectedCode." }
  $candidate
}

function Parse-StreamEvents {
  param([string]$Content)
  $Content -split "`n" |
    Where-Object { $_.Trim() } |
    ForEach-Object { $_ | ConvertFrom-Json }
}

function Convert-WebResponseContentToText {
  param([object]$Content)
  if ($Content -is [byte[]]) {
    return [System.Text.Encoding]::UTF8.GetString($Content)
  }
  return [string]$Content
}

function Count-Pattern {
  param([string]$Text, [string]$Pattern)
  ([regex]::Matches($Text, [regex]::Escape($Pattern))).Count
}

function New-UnicodeString {
  param([int[]]$CodePoints)
  -join ($CodePoints | ForEach-Object { [char]$_ })
}

function Test-ContainsAny {
  param(
    [string]$Text,
    [string[]]$Patterns
  )
  foreach ($pattern in $Patterns) {
    if ($Text -like "*$pattern*") { return $true }
  }
  return $false
}

$TextAvoid = New-UnicodeString @(0x56DE, 0x907F)
$TextPending = New-UnicodeString @(0x5F85, 0x9A8C, 0x8BC1)
$TextDataInsufficient = New-UnicodeString @(0x6570, 0x636E, 0x4E0D, 0x8DB3)
$TextUnavailable = New-UnicodeString @(0x4E0D, 0x53EF, 0x7528)
$TextMissing = New-UnicodeString @(0x7F3A, 0x5931)
$TextUnable = New-UnicodeString @(0x65E0, 0x6CD5)
$TextUnretrieved = New-UnicodeString @(0x672A, 0x83B7, 0x53D6)
$TextNotProvided = New-UnicodeString @(0x672A, 0x63D0, 0x4F9B)
$TextNotProvidedRecent = New-UnicodeString @(0x672A, 0x63D0, 0x4F9B, 0x6700, 0x8FD1)
$TextFollowUpReview = New-UnicodeString @(0x9700, 0x5728, 0x540E, 0x7EED, 0x590D, 0x6838)
$UnavailableValuePatterns = @($TextPending, $TextDataInsufficient, $TextUnavailable, $TextMissing, $TextUnable, $TextUnretrieved)
$PlaceholderPatterns = @($TextPending, $TextDataInsufficient, $TextUnavailable, $TextMissing, $TextUnable)
$ScorePlaceholderPatterns = @($TextNotProvidedRecent, $TextFollowUpReview, $TextPending, $TextDataInsufficient)
$RiskPlaceholderPatterns = @($TextPending, $TextDataInsufficient, $TextNotProvided)

function Test-ReportQuality {
  param([object]$Report)
  $json = $Report | ConvertTo-Json -Depth 40 -Compress
  $scoreItems = @($Report.scoreItems20)
  $riskItems = @($Report.riskMatrix)
  $evidenceItems = @($Report.evidence)
  $currentPrice = [string]$Report.valuationAnalysis.currentPrice
  $fairValueRange = [string]$Report.valuationAnalysis.fairValueRange
  $buyRange = [string]$Report.valuationAnalysis.buyRange
  $sellRange = [string]$Report.valuationAnalysis.sellReduceRange
  $position = [string]$Report.summaryDashboard.positionAdvice
  $maxPosition = [string]$Report.accountRules.maxPosition
  $conclusion = [string]$Report.conclusion

  $issues = New-Object System.Collections.Generic.List[string]
  if ($conclusion -eq $TextAvoid -and ($position -ne '0%' -or $maxPosition -ne '0%')) {
    $issues.Add("Avoid conclusion did not strictly map to 0% position")
  }
  if (Test-ContainsAny -Text $currentPrice -Patterns $UnavailableValuePatterns) {
    $issues.Add("Current price is still a placeholder or unavailable")
  }
  if (Test-ContainsAny -Text ($fairValueRange + $buyRange + $sellRange) -Patterns $PlaceholderPatterns) {
    $issues.Add("Valuation ranges still contain placeholders or unavailable values")
  }
  if (@($scoreItems | Where-Object {
    Test-ContainsAny -Text (($_.evidence -join ' ') + ($_.deductions -join ' ') + [string]$_.recentChange) -Patterns $ScorePlaceholderPatterns
  }).Count -gt 0) {
    $issues.Add("Score items still contain placeholder evidence or recent-change text")
  }
  if (@($riskItems | Where-Object {
    Test-ContainsAny -Text ([string]$_.risk + [string]$_.warningMetric + [string]$_.response) -Patterns $RiskPlaceholderPatterns
  }).Count -gt 0) {
    $issues.Add("Risk matrix still contains placeholder fields")
  }
  if (@($Report.financialTenYear.rows).Count -lt 6) {
    $issues.Add("Financial table has fewer than 6 valid rows")
  }
  if (@($evidenceItems | Where-Object { $_.freshness -eq 'latest-public' }).Count -lt 2) {
    $issues.Add("latest-public evidence count is fewer than 2")
  }

  [pscustomobject]@{
    Passed = $issues.Count -eq 0
    Issues = @($issues)
    PlaceholderCounts = [pscustomobject]@{
      Pending = Count-Pattern $json $TextPending
      DataInsufficient = Count-Pattern $json $TextDataInsufficient
      Unable = Count-Pattern $json $TextUnable
      Missing = Count-Pattern $json $TextMissing
      NotProvided = Count-Pattern $json $TextNotProvided
    }
    FinancialRows = @($Report.financialTenYear.rows).Count
    RiskRows = @($Report.riskMatrix).Count
    EvidenceCount = @($Report.evidence).Count
    UnavailableEvidenceCount = @($Report.evidence | Where-Object { $_.freshness -eq 'unavailable' }).Count
    YahooUnavailableCount = @($Report.evidence | Where-Object { [string]$_.source -like 'Yahoo*' -and $_.freshness -eq 'unavailable' }).Count
  }
}

function Invoke-ReportRun {
  param(
    [string]$BaseUrl,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
    [object]$Case,
    [object]$Company,
    [bool]$ForceRefresh,
    [string]$RunDir,
    [int]$TimeoutSec
  )
  $mode = if ($ForceRefresh) { 'refresh' } else { 'prefer-cache' }
  $safeName = "$($Case.id)-$mode"
  $ndjsonPath = Join-Path $RunDir "$safeName.ndjson"
  $started = Get-Date
  $response = Invoke-Json -Uri "$BaseUrl/api/report" -Method POST -Session $Session -TimeoutSec $TimeoutSec -Body @{
    company = $Company
    forceRefresh = $ForceRefresh
    cacheMode = $mode
  }
  $responseText = Convert-WebResponseContentToText $response.Content
  Set-Content -LiteralPath $ndjsonPath -Encoding UTF8 -Value $responseText
  $events = @(Parse-StreamEvents $responseText)
  $errorEvent = $events | Where-Object { $_.type -eq 'error' } | Select-Object -Last 1
  $final = $events | Where-Object { $_.type -eq 'final' } | Select-Object -Last 1
  if ($errorEvent) {
    return [pscustomobject]@{
      CaseId = $Case.id
      Mode = $mode
      Status = 'error'
      Error = $errorEvent.error
      ElapsedSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
      NdjsonPath = $ndjsonPath
    }
  }
  if (-not $final) {
    return [pscustomobject]@{
      CaseId = $Case.id
      Mode = $mode
      Status = 'missing-final'
      Error = 'No final event in stream.'
      ElapsedSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
      NdjsonPath = $ndjsonPath
    }
  }

  $quality = Test-ReportQuality $final.report
  $cacheExpectationPassed = $ForceRefresh -or ($final.metrics.cacheHit -eq $true -and [int]$final.metrics.modelCalls -eq 0)
  [pscustomobject]@{
    CaseId = $Case.id
    Query = $Case.query
    ExpectedCode = $Case.expectedCode
    MarketBucket = $Case.marketBucket
    ListingAge = $Case.listingAge
    Mode = $mode
    Status = 'ok'
    ElapsedSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Company = "$($final.report.company.name) / $($final.report.company.ticker) / $($final.report.company.market)"
    CQS = $final.report.cqs
    IAS = $final.report.ias
    Conclusion = $final.report.conclusion
    Position = $final.report.summaryDashboard.positionAdvice
    MaxPosition = $final.report.accountRules.maxPosition
    CurrentPrice = $final.report.valuationAnalysis.currentPrice
    FairValueRange = $final.report.valuationAnalysis.fairValueRange
    Quality = $quality
    CacheExpectationPassed = $cacheExpectationPassed
    Metrics = $final.metrics
    NdjsonPath = $ndjsonPath
  }
}

$MarketA = 'A' + (New-UnicodeString @(0x80A1))
$MarketHK = New-UnicodeString @(0x6E2F, 0x80A1)
$MarketUS = New-UnicodeString @(0x7F8E, 0x80A1)
$OldListing = New-UnicodeString @(0x8001, 0x4E0A, 0x5E02, 0x516C, 0x53F8)
$NewListing = New-UnicodeString @(0x65B0, 0x4E0A, 0x5E02, 0x516C, 0x53F8)

$cases = @(
  [pscustomobject]@{ id='a-old-maotai'; query=(New-UnicodeString @(0x8D35, 0x5DDE, 0x8305, 0x53F0)); expectedCode='600519'; marketBucket=$MarketA; listingAge=$OldListing },
  [pscustomobject]@{ id='a-new-decai'; query=(New-UnicodeString @(0x5FB7, 0x624D, 0x80A1, 0x4EFD)); expectedCode='605287'; marketBucket=$MarketA; listingAge=$NewListing },
  [pscustomobject]@{ id='hk-old-tencent'; query=(New-UnicodeString @(0x817E, 0x8BAF, 0x63A7, 0x80A1)); expectedCode='00700'; marketBucket=$MarketHK; listingAge=$OldListing },
  [pscustomobject]@{ id='hk-new-kuaishou'; query=(New-UnicodeString @(0x5FEB, 0x624B)); expectedCode='01024'; marketBucket=$MarketHK; listingAge=$NewListing },
  [pscustomobject]@{ id='us-old-amazon'; query='AMZN'; expectedCode='AMZN'; marketBucket=$MarketUS; listingAge=$OldListing },
  [pscustomobject]@{ id='us-new-snowflake'; query='SNOW'; expectedCode='SNOW'; marketBucket=$MarketUS; listingAge=$NewListing }
)

$access = Read-AccessConfig $AccessFile
$startedAt = Get-Date
$runId = $startedAt.ToString('yyyyMMdd-HHmmss')
$runDir = Join-Path $OutputDir $runId
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-Json -Uri "$($access.Url)/api/session" -Method POST -Session $session -Body @{ username = $access.Username; password = $access.Password } | Out-Null
Invoke-Json -Uri "$($access.Url)/api/session" -Method GET -Session $session | Out-Null

$summary = New-Object System.Collections.Generic.List[object]
$companies = @{}

foreach ($case in $cases) {
  $searchResponse = Invoke-Json -Uri "$($access.Url)/api/company-search?q=$([uri]::EscapeDataString($case.query))" -Session $session
  $searchJson = $searchResponse.Content | ConvertFrom-Json
  $company = Select-Candidate -Candidates @($searchJson.candidates) -ExpectedCode $case.expectedCode
  $companies[$case.id] = $company
  $company | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runDir "$($case.id)-candidate.json") -Encoding UTF8

  if (-not $SkipRefresh) {
    $refreshResult = Invoke-ReportRun -BaseUrl $access.Url -Session $session -Case $case -Company $company -ForceRefresh $true -RunDir $runDir -TimeoutSec $ReportTimeoutSeconds
    $summary.Add($refreshResult)
    $summary | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $runDir 'summary.partial.json') -Encoding UTF8
  }
}

foreach ($case in $cases) {
  $cacheResult = Invoke-ReportRun -BaseUrl $access.Url -Session $session -Case $case -Company $companies[$case.id] -ForceRefresh $false -RunDir $runDir -TimeoutSec 240
  $summary.Add($cacheResult)
  $summary | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $runDir 'summary.partial.json') -Encoding UTF8
}

$failedResults = @($summary.ToArray() | Where-Object {
  $_.Status -ne 'ok' -or -not $_.Quality.Passed -or -not $_.CacheExpectationPassed
})
$result = [pscustomobject][ordered]@{
  RunId = $runId
  BaseUrl = $access.Url
  OutputDir = $runDir
  StartedAt = $startedAt.ToString('o')
  CompletedAt = (Get-Date).ToString('o')
  CaseCount = $cases.Count
  RefreshSkipped = [bool]$SkipRefresh
  Passed = $failedResults.Count -eq 0
  FailureCount = $failedResults.Count
  Results = @($summary.ToArray())
}
$result | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $runDir 'summary.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 50
if ($failedResults.Count -gt 0) {
  throw "Online regression failed for $($failedResults.Count) run(s). See $runDir\summary.json."
}
