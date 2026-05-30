param(
  [string]$AccessFile = $(if ($env:CSTD_ALPHA_ACCESS_FILE) { $env:CSTD_ALPHA_ACCESS_FILE } else { "" }),
  [string]$OutputDir = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".tmp\cstd-alpha-online-regression"),
  [int]$ReportTimeoutSeconds = 2400
)

$ErrorActionPreference = 'Stop'

function Read-AccessConfig {
  param([string]$Path)
  if (-not $Path) { throw "Access file is required. Pass -AccessFile or set CSTD_ALPHA_ACCESS_FILE." }
  $text = Get-Content -Raw -LiteralPath $Path
  $url = (($text -split "`r?`n") | Where-Object { $_ -match '^URL:' } | Select-Object -First 1) -replace '^URL:\s*',''
  $username = (($text -split "`r?`n") | Where-Object { $_ -match '^(USERNAME|REPORT_USERNAME):' } | Select-Object -First 1) -replace '^(USERNAME|REPORT_USERNAME):\s*',''
  $password = (($text -split "`r?`n") | Where-Object { $_ -match '^REPORT_PASSWORD:' } | Select-Object -First 1) -replace '^REPORT_PASSWORD:\s*',''
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

function Count-Pattern {
  param([string]$Text, [string]$Pattern)
  ([regex]::Matches($Text, [regex]::Escape($Pattern))).Count
}

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
  if ($conclusion -eq '回避' -and ($position -ne '0%' -or $maxPosition -ne '0%')) {
    $issues.Add("回避结论没有严格对应 0% 仓位")
  }
  if ($currentPrice -match '待验证|数据不足|不可用|缺失|无法|未获取') {
    $issues.Add("当前价格仍是占位或不可用")
  }
  if (($fairValueRange + $buyRange + $sellRange) -match '待验证|数据不足|不可用|缺失|无法') {
    $issues.Add("估值区间仍有占位或不可用")
  }
  if (@($scoreItems | Where-Object {
    (($_.evidence -join ' ') + ($_.deductions -join ' ') + [string]$_.recentChange) -match '未提供最近|需在后续复核|待验证|数据不足'
  }).Count -gt 0) {
    $issues.Add("20 项评分仍有占位证据或占位最近变化")
  }
  if (@($riskItems | Where-Object {
    ([string]$_.risk + [string]$_.warningMetric + [string]$_.response) -match '待验证|数据不足|未提供'
  }).Count -gt 0) {
    $issues.Add("风险矩阵仍有占位字段")
  }
  if (@($Report.financialTenYear.rows).Count -lt 6) {
    $issues.Add("十年财务表有效行数少于 6")
  }
  if (@($evidenceItems | Where-Object { $_.freshness -eq 'latest-public' }).Count -lt 2) {
    $issues.Add("latest-public 证据少于 2 条")
  }

  [pscustomobject]@{
    Passed = $issues.Count -eq 0
    Issues = @($issues)
    PlaceholderCounts = [pscustomobject]@{
      Pending = Count-Pattern $json '待验证'
      DataInsufficient = Count-Pattern $json '数据不足'
      Unable = Count-Pattern $json '无法'
      Missing = Count-Pattern $json '缺失'
      NotProvided = Count-Pattern $json '未提供'
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
  $response.Content | Set-Content -LiteralPath $ndjsonPath -Encoding UTF8
  $events = @(Parse-StreamEvents $response.Content)
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
    Metrics = $final.metrics
    NdjsonPath = $ndjsonPath
  }
}

$cases = @(
  [pscustomobject]@{ id='a-old-maotai'; query='贵州茅台'; expectedCode='600519'; marketBucket='A股'; listingAge='老上市公司' },
  [pscustomobject]@{ id='a-new-decai'; query='德才股份'; expectedCode='605287'; marketBucket='A股'; listingAge='新上市公司' },
  [pscustomobject]@{ id='hk-old-tencent'; query='腾讯控股'; expectedCode='00700'; marketBucket='港股'; listingAge='老上市公司' },
  [pscustomobject]@{ id='hk-new-kuaishou'; query='快手'; expectedCode='01024'; marketBucket='港股'; listingAge='新上市公司' },
  [pscustomobject]@{ id='us-old-amazon'; query='AMZN'; expectedCode='AMZN'; marketBucket='美股'; listingAge='老上市公司' },
  [pscustomobject]@{ id='us-new-snowflake'; query='SNOW'; expectedCode='SNOW'; marketBucket='美股'; listingAge='新上市公司' }
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

  $refreshResult = Invoke-ReportRun -BaseUrl $access.Url -Session $session -Case $case -Company $company -ForceRefresh $true -RunDir $runDir -TimeoutSec $ReportTimeoutSeconds
  $summary.Add($refreshResult)
  $summary | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $runDir 'summary.partial.json') -Encoding UTF8
}

foreach ($case in $cases) {
  $cacheResult = Invoke-ReportRun -BaseUrl $access.Url -Session $session -Case $case -Company $companies[$case.id] -ForceRefresh $false -RunDir $runDir -TimeoutSec 240
  $summary.Add($cacheResult)
  $summary | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $runDir 'summary.partial.json') -Encoding UTF8
}

$result = [pscustomobject][ordered]@{
  RunId = $runId
  BaseUrl = $access.Url
  OutputDir = $runDir
  StartedAt = $startedAt.ToString('o')
  CompletedAt = (Get-Date).ToString('o')
  CaseCount = $cases.Count
  Results = @($summary.ToArray())
}
$result | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $runDir 'summary.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 50
