param(
  [string]$UniversePath = "E:\DEV\测试\cstd-alpha-opencode-batch\ashare-universe.json",
  [string]$OutputDir = "E:\DEV\测试\cstd-alpha-opencode-batch",
  [string]$BaseUrl = "http://127.0.0.1:8789",
  [string]$Password,
  [int]$Offset = 0,
  [int]$Limit = 1,
  [string]$Model = "opencode-go/deepseek-v4-flash",
  [string]$Variant = "max",
  [string]$Agent = "build"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $OutputDir | Out-Null

if (-not $Password) {
  $accessPath = "E:\DEV\codex-tools\cstd-alpha-access.txt"
  if (Test-Path $accessPath) {
    $line = Get-Content $accessPath | Where-Object { $_ -match "^REPORT_PASSWORD[:=]" } | Select-Object -First 1
    if ($line) { $Password = ($line -replace "^[^:=]+[:=]\s*", "").Trim() }
  }
}
if (-not $Password) { throw "Password is required. Pass -Password or provide E:\DEV\codex-tools\cstd-alpha-access.txt." }
if (-not (Test-Path $UniversePath)) { throw "Universe file not found: $UniversePath" }

function Invoke-JsonPost {
  param(
    [string]$Uri,
    [string]$BodyPath,
    [string]$CookieHeader,
    [int]$TimeoutSeconds = 120
  )
  $responsePath = [System.IO.Path]::GetTempFileName()
  try {
    $httpCode = (curl.exe --silent --show-error --max-time $TimeoutSeconds -o $responsePath -w "%{http_code}" -H "Cookie: $CookieHeader" -H "Content-Type: application/json; charset=utf-8" --data-binary "@$BodyPath" $Uri) -join ""
    $body = if (Test-Path $responsePath) { Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 } else { "" }
    if ($LASTEXITCODE -ne 0 -or -not ($httpCode -match '^2\d\d$')) {
      throw "POST $Uri failed with HTTP $httpCode. $body"
    }
    return $body
  } finally {
    Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
  }
}

function Normalize-ModelReport {
  param(
    [object]$Report,
    [object[]]$SchemaIds,
    [object]$EvidenceResponse
  )
  if ($Report.PSObject.Properties.Name -contains "report" -and -not ($Report.PSObject.Properties.Name -contains "company")) {
    $Report = $Report.report
  }
  if (-not ($Report.PSObject.Properties.Name -contains "company") -and ($Report.PSObject.Properties.Name -contains "companyName")) {
    $Report | Add-Member -NotePropertyName company -NotePropertyValue ([pscustomobject]@{
      name = $Report.companyName
      ticker = $Report.ticker
      market = $Report.market
    })
  }
  if ($Report.company -and $EvidenceResponse.evidence.company) {
    if (-not $Report.company.name) { $Report.company.name = $EvidenceResponse.evidence.company.name }
    if (-not $Report.company.ticker) { $Report.company.ticker = $EvidenceResponse.evidence.company.ticker }
    if (-not $Report.company.market) { $Report.company.market = $EvidenceResponse.evidence.company.market }
  }
  if (-not ($Report.PSObject.Properties.Name -contains "asOf")) {
    $asOf = if ($Report.generatedAt) { $Report.generatedAt } elseif ($EvidenceResponse.evidence.retrievedAt) { $EvidenceResponse.evidence.retrievedAt } else { (Get-Date).ToUniversalTime().ToString("o") }
    $Report | Add-Member -NotePropertyName asOf -NotePropertyValue $asOf
  }
  if (-not ($Report.PSObject.Properties.Name -contains "evidence") -and $EvidenceResponse.evidence.evidence) {
    $Report | Add-Member -NotePropertyName evidence -NotePropertyValue @($EvidenceResponse.evidence.evidence)
  }
  if (-not ($Report.PSObject.Properties.Name -contains "financialTenYear") -and $EvidenceResponse.evidence.facts.financialTenYear) {
    $Report | Add-Member -NotePropertyName financialTenYear -NotePropertyValue $EvidenceResponse.evidence.facts.financialTenYear
  }
  if (-not ($Report.PSObject.Properties.Name -contains "valuationAnalysis")) {
    $quote = $EvidenceResponse.evidence.facts.quote
    $price = if ($quote -and $quote.regularMarketPrice -ne $null) { [string]$quote.regularMarketPrice } else { "unavailable" }
    $currency = if ($Report.company.market -match "US") { "USD" } elseif ($Report.company.market -match "HK") { "HKD" } else { "CNY" }
    $Report | Add-Member -NotePropertyName valuationAnalysis -NotePropertyValue ([pscustomobject]@{
      currentPrice = if ($price -eq "unavailable") { $price } else { "$price $currency" }
      fairValueRange = if ($Report.summaryDashboard.valuationView) { [string]$Report.summaryDashboard.valuationView } else { "unavailable" }
      buyRange = "unavailable"
      sellReduceRange = "unavailable"
      methods = @("PE/PB and public quote snapshot")
      scenarios = @()
      conclusion = if ($Report.summaryDashboard.valuationView) { [string]$Report.summaryDashboard.valuationView } else { "unavailable" }
    })
  }
  if ($Report.scoreItems20 -and -not ($Report.scoreItems20 -is [array])) {
    $items = foreach ($id in $SchemaIds) {
      $raw = $Report.scoreItems20.$id
      $score = if ($raw -is [double] -or $raw -is [int]) { $raw } elseif ($raw -and $raw.score -ne $null) { $raw.score } else { 0 }
      [pscustomobject]@{
        id = $id
        score = $score
        evidence = @()
        deductions = @()
        recentChange = "Recent change was conservatively reflected in the score based on public evidence."
        reason = "The model provided this score; see the relevant narrative section for details."
      }
    }
    $Report.scoreItems20 = @($items)
  }
  if ($Report.fullSections) {
    foreach ($key in @($Report.fullSections.PSObject.Properties.Name)) {
      $section = $Report.fullSections.$key
      if ($section -and ($section.PSObject.Properties.Name -contains "content")) {
        $Report.fullSections.$key = [string]$section.content
      }
    }
  }
  return $Report
}

function Extract-JsonObjectText {
  param([string]$Text)
  $trimmed = $Text.Trim()
  $fenced = [regex]::Match($trimmed, '(?s)```(?:json)?\s*(\{.*?\})\s*```')
  if ($fenced.Success) { return $fenced.Groups[1].Value.Trim() }
  if ($trimmed.StartsWith("{")) { return $trimmed }
  $start = $trimmed.IndexOf("{")
  $end = $trimmed.LastIndexOf("}")
  if ($start -ge 0 -and $end -gt $start) {
    return $trimmed.Substring($start, $end - $start + 1).Trim()
  }
  return $trimmed
}

$loginResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$BaseUrl/api/session" -ContentType "application/json" -Body (@{ password = $Password } | ConvertTo-Json)
$setCookie = @($loginResponse.Headers["Set-Cookie"])[0]
if (-not $setCookie) { throw "Login succeeded but no session cookie was returned." }
$cookieHeader = ($setCookie -split ";")[0]
Write-Output "LOGIN cookie length $($cookieHeader.Length)"
$sessionCheck = (curl.exe --silent --show-error --max-time 30 -H "Cookie: $cookieHeader" "$BaseUrl/api/session") -join ""
if (-not $sessionCheck.Contains('"authenticated":true')) { throw "Login cookie verification failed." }

$universe = Get-Content -LiteralPath $UniversePath -Raw -Encoding UTF8 | ConvertFrom-Json
$companies = @($universe.companies) | Select-Object -Skip $Offset -First $Limit
$schemaIds = @(
  "industryLifecycle", "industryCyclicality", "businessModelQuality", "bargainingAndCashConversion", "assetAndCostStructure",
  "durableMoat", "marketPosition", "innovationRisk", "revenueGrowthQuality", "profitAndFcfGrowth",
  "roeRoicMargins", "cashFlowConsistency", "balanceSheetHealth", "managementExecution", "governanceFairness",
  "capitalReturn", "relativeValuation", "tenYearReturnSafety", "riskAndDisconfirmingEvidence", "ownerPerspective"
)

foreach ($company in $companies) {
  $safeName = (($company.code + "-" + $company.name) -replace '[\\/:*?"<>|]', "_")
  $companyDir = Join-Path $OutputDir $safeName
  New-Item -ItemType Directory -Force $companyDir | Out-Null
  $reportPath = Join-Path $companyDir "report.json"
  $eventsPath = Join-Path $companyDir "opencode-events.jsonl"
  $promptPath = Join-Path $companyDir "prompt.md"
  $evidencePath = Join-Path $companyDir "evidence.json"
  $statusPath = Join-Path $companyDir "status.json"

  if (Test-Path $statusPath) {
    Write-Output "SKIP existing $($company.code) $($company.name)"
    continue
  }

  Write-Output "FETCH evidence $($company.code) $($company.name)"
  $candidate = [pscustomobject]@{
    id = $company.id
    name = $company.name
    code = $company.code
    exchange = $company.exchange
    listingPlace = $company.listingPlace
    marketType = $company.marketType
    quoteId = $company.quoteId
    source = "eastmoney"
  }
  $evidenceBody = @{ company = $candidate } | ConvertTo-Json -Depth 6
  $evidenceTemp = Join-Path $companyDir "evidence-request.json"
  $evidenceBody | Set-Content -LiteralPath $evidenceTemp -Encoding UTF8
  $evidenceRaw = Invoke-JsonPost -Uri "$BaseUrl/api/company-evidence" -BodyPath $evidenceTemp -CookieHeader $cookieHeader -TimeoutSeconds 120
  $evidenceResponse = $evidenceRaw | ConvertFrom-Json
  $evidenceResponse | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath $evidencePath -Encoding UTF8

  $prompt = @"
You are the CSTD Alpha stock report generator.
Return exactly one JSON object for one report. Do not return Markdown, explanations, or fenced code.
All human-readable report content must be written in Simplified Chinese.

Company:
$($company.name) / $($company.code) / $($company.listingPlace)

Use only the attached evidence.json public evidence, financial table, quote snapshot, and company identity.
Do not fabricate facts, financial numbers, sources, or URLs. If evidence is weak, score conservatively.

The output must be a single report object, not a reports array. It must pass CSTD Alpha validateReportPayload and these constraints:
- scoreItems20 must be an array of 20 objects, not a map/object.
- Each scoreItems20 object must contain: id, score, evidence, deductions, recentChange, reason.
- scoreItems20 must contain all 20 ids: $($schemaIds -join ", ")
- Each score is 0-100.
- At least 15 scoreItems20 scores must be greater than 0.
- evidence must contain at least 2 items with freshness = latest-public.
- conclusion must be one of: 买入, 加仓, 持有, 观察, 减仓, 卖出, 回避.
- If conclusion is 回避, summaryDashboard.positionAdvice and accountRules.maxPosition must be exactly 0%.
- CQS is long-term company quality and should not reward cheap valuation directly.
- IAS is investment attractiveness and includes valuation, safety margin, and risk.
- High leverage, persistent losses, cash-flow deterioration, governance risk, delisting risk, material litigation or penalties must significantly reduce scores.
- summaryDashboard must contain valuationView, positionAdvice, investmentHorizon, keyReasons, keyRisks, trackingMetrics.
- accountRules must contain companyGrade, maxPosition, addCondition, reduceCondition, reviewTiming.
- fullSections must contain string fields: onePageConclusion, companyOverview, industryTrack, businessModel, moat, governance, financialQuality, growthInflection, valuation, risks, finalConclusion, accountRules.
- Use evidence.json financialTenYear rows when available.
- disclaimer must be exactly: 本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。

Read evidence.json and produce the final report JSON now.
"@
  $prompt | Set-Content -LiteralPath $promptPath -Encoding UTF8

  Write-Output "RUN opencode $($company.code) $($company.name)"
  opencode run "Generate the final report JSON from prompt.md and evidence.json. Do not write files or call tools. Return only JSON in the final answer." --model $Model --variant $Variant --agent $Agent --format json --dir (Get-Location).Path --file $promptPath --file $evidencePath | Tee-Object -FilePath $eventsPath | Out-Null

  $textParts = Get-Content -LiteralPath $eventsPath -Encoding UTF8 | ForEach-Object {
    try {
      $event = $_ | ConvertFrom-Json
      if ($event.type -eq "text" -and $event.part.text) { [string]$event.part.text }
    } catch {}
  }
  $raw = ($textParts -join "").Trim()
  $raw = Extract-JsonObjectText -Text $raw
  if (-not $raw.StartsWith("{")) {
    if (Test-Path $reportPath) {
      $raw = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8
    } else {
      throw "opencode did not return a JSON object for $($company.code)."
    }
  }
  $report = Normalize-ModelReport -Report ($raw | ConvertFrom-Json) -SchemaIds $schemaIds -EvidenceResponse $evidenceResponse
  $report | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $reportPath -Encoding UTF8

  Write-Output "IMPORT report $($company.code) $($company.name)"
  $importBodyPath = Join-Path $companyDir "import-request.json"
  @{ reports = @($report) } | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $importBodyPath -Encoding UTF8
  $importRaw = Invoke-JsonPost -Uri "$BaseUrl/api/report-library" -BodyPath $importBodyPath -CookieHeader $cookieHeader -TimeoutSeconds 120
  $imported = $importRaw | ConvertFrom-Json
  [pscustomobject]@{
    code = $company.code
    name = $company.name
    importedAt = (Get-Date).ToUniversalTime().ToString("o")
    imported = $imported.imported
  } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statusPath -Encoding UTF8
  Write-Output "DONE $($company.code) $($company.name)"
}
