param(
  [string]$UniversePath = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".tmp\cstd-alpha-opencode-batch\ashare-universe.json"),
  [string]$OutputDir = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".tmp\cstd-alpha-opencode-batch"),
  [string]$BaseUrl = "http://127.0.0.1:8789",
  [string]$Username,
  [string]$Password,
  [int]$Offset = 0,
  [int]$Limit = 1,
  [string]$Model = "opencode/deepseek-v4-flash",
  [string]$Variant = "max",
  [string]$Agent = "build",
  [switch]$ImportOnline,
  [switch]$ContinueOnError,
  [switch]$DirectDeepSeekApi,
  [int]$MaxAttempts = 2,
  [int]$OpencodeTimeoutMinutes = 45,
  [int]$CacheAnchorRepeat = 0
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $OutputDir | Out-Null

$accessPath = $env:CSTD_ALPHA_ACCESS_FILE
$accessLines = if ($accessPath -and (Test-Path $accessPath)) { @(Get-Content $accessPath) } else { @() }
if (-not $PSBoundParameters.ContainsKey("BaseUrl")) {
  $urlLine = $accessLines | Where-Object { $_ -match "^(URL|BASE_URL)[:=]" } | Select-Object -First 1
  if ($urlLine) { $BaseUrl = ($urlLine -replace "^[^:=]+[:=]\s*", "").Trim() }
}

if (-not $Password) {
  if ($env:REPORT_PASSWORD) {
    $Password = $env:REPORT_PASSWORD
  }
}
if (-not $Password) {
  if ($accessLines.Count) {
    $line = $accessLines | Where-Object { $_ -match "^REPORT_PASSWORD[:=]" } | Select-Object -First 1
    if ($line) { $Password = ($line -replace "^[^:=]+[:=]\s*", "").Trim() }
  }
}
if (-not $Password) { throw "Password is required. Pass -Password or set CSTD_ALPHA_ACCESS_FILE." }
if (-not $Username) {
  if ($env:REPORT_USERNAME) {
    $Username = $env:REPORT_USERNAME
  } elseif ($env:USERNAME) {
    $Username = $env:USERNAME
  }
}
if (-not $Username -and $accessLines.Count) {
  $line = $accessLines | Where-Object { $_ -match "^(REPORT_USERNAME|USERNAME)[:=]" } | Select-Object -First 1
  if ($line) { $Username = ($line -replace "^[^:=]+[:=]\s*", "").Trim() }
}
if (-not $Username) { throw "Username is required. Pass -Username or add REPORT_USERNAME to CSTD_ALPHA_ACCESS_FILE." }
if (-not (Test-Path $UniversePath)) { throw "Universe file not found: $UniversePath" }

function Format-ProviderNumber {
  param([double]$Value)
  return ([Math]::Round($Value, 2)).ToString("0.##", [System.Globalization.CultureInfo]::InvariantCulture)
}

function Test-UsableValuationField {
  param([object]$Value)
  if ($null -eq $Value) { return $false }
  if ($Value -is [array] -or $Value -is [System.Collections.IDictionary] -or $Value -is [pscustomobject]) { return $false }
  $text = ([string]$Value).Trim()
  if (-not $text) { return $false }
  $badTerms = @(
    (-join @([char]0x6570, [char]0x636E, [char]0x4E0D, [char]0x8DB3)),
    (-join @([char]0x5F85, [char]0x9A8C, [char]0x8BC1)),
    (-join @([char]0x4E0D, [char]0x53EF, [char]0x7528)),
    (-join @([char]0x7F3A, [char]0x5931)),
    (-join @([char]0x65E0, [char]0x6CD5)),
    (-join @([char]0x672A, [char]0x83B7, [char]0x53D6)),
    (-join @([char]0x672A, [char]0x8BA1, [char]0x7B97))
  )
  foreach ($term in $badTerms) {
    if ($text.Contains($term)) { return $false }
  }
  return -not ($text -match "unavailable|N/A|^@\{")
}

function Get-CurrencyFromMarket {
  param([object]$Market)
  $text = if ($null -eq $Market) { "" } else { ([string]$Market).ToUpperInvariant() }
  if ($text -match "HK") { return "HKD" }
  if ($text -match "US") { return "USD" }
  if ($text -match "A|SH|SZ|STAR|CHINEXT") { return "CNY" }
  return "CNY"
}

function Complete-ValuationAnalysis {
  param(
    [object]$Report,
    [object]$EvidenceResponse
  )

  $quote = $EvidenceResponse.evidence.facts.quote
  $rawPrice = if ($quote -and $quote.regularMarketPrice -ne $null) { $quote.regularMarketPrice } else { $null }
  $price = 0.0
  $hasPrice = $rawPrice -ne $null -and [double]::TryParse([string]$rawPrice, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$price) -and $price -gt 0
  $currency = if ($quote -and $quote.currency) { [string]$quote.currency } else { Get-CurrencyFromMarket -Market $Report.company.market }
  $currencySuffix = if ($currency) { " $currency" } else { "" }

  $existing = if ($Report.PSObject.Properties.Name -contains "valuationAnalysis" -and $Report.valuationAnalysis) { $Report.valuationAnalysis } else { [pscustomobject]@{} }
  $valuationView = if ($Report.summaryDashboard -and $Report.summaryDashboard.valuationView) { [string]$Report.summaryDashboard.valuationView } else { "" }
  $fallbackMethod = "Quote-anchored safety-margin observation range"
  $methods = @($existing.methods | Where-Object { $_ })
  if (-not ($methods -contains $fallbackMethod)) { $methods += $fallbackMethod }

  if ($hasPrice) {
    $currentPrice = if (Test-UsableValuationField $existing.currentPrice) { [string]$existing.currentPrice } else { "$(Format-ProviderNumber $price)$currencySuffix" }
    $fairValueRange = if (Test-UsableValuationField $existing.fairValueRange) {
      [string]$existing.fairValueRange
    } else {
      "$(Format-ProviderNumber ($price * 0.85))-$(Format-ProviderNumber ($price * 1.15))$currencySuffix (quote-anchored observation range)"
    }
    $buyRange = if (Test-UsableValuationField $existing.buyRange) {
      [string]$existing.buyRange
    } else {
      "Below $(Format-ProviderNumber ($price * 0.78))$currencySuffix (about 22% safety margin versus public quote)"
    }
    $sellReduceRange = if (Test-UsableValuationField $existing.sellReduceRange) {
      [string]$existing.sellReduceRange
    } else {
      "Above $(Format-ProviderNumber ($price * 1.25))$currencySuffix (about 25% premium versus public quote)"
    }
    $conclusion = if (Test-UsableValuationField $existing.conclusion) {
      [string]$existing.conclusion
    } elseif ($valuationView) {
      $valuationView
    } else {
      "Public quote is $currentPrice; ranges use a quote-anchored observation method and still require review against financials, cash flow, and peers."
    }
  } else {
    $currentPrice = if (Test-UsableValuationField $existing.currentPrice) { [string]$existing.currentPrice } else { "unavailable" }
    $fairValueRange = if (Test-UsableValuationField $existing.fairValueRange) { [string]$existing.fairValueRange } elseif ($valuationView) { $valuationView } else { "unavailable" }
    $buyRange = if (Test-UsableValuationField $existing.buyRange) { [string]$existing.buyRange } else { "unavailable" }
    $sellReduceRange = if (Test-UsableValuationField $existing.sellReduceRange) { [string]$existing.sellReduceRange } else { "unavailable" }
    $conclusion = if (Test-UsableValuationField $existing.conclusion) { [string]$existing.conclusion } elseif ($valuationView) { $valuationView } else { "unavailable" }
  }

  $Report | Add-Member -NotePropertyName valuationAnalysis -NotePropertyValue ([pscustomobject]@{
    currentPrice = $currentPrice
    fairValueRange = $fairValueRange
    buyRange = $buyRange
    sellReduceRange = $sellReduceRange
    methods = @($methods)
    scenarios = if ($existing.scenarios) { @($existing.scenarios) } else { @() }
    conclusion = $conclusion
  }) -Force
}

function Test-MissingOneSentence {
  param([object]$Value, [string]$CompanyName)
  if ($null -eq $Value) { return $true }
  $text = ([string]$Value).Trim()
  if (-not $text) { return $true }
  return $text.Contains($CompanyName) -and $text.Contains((-join @([char]0x6838, [char]0x5FC3, [char]0x4E00, [char]0x53E5, [char]0x8BDD)))
}

function Get-FirstReportSentence {
  param([object]$Text)
  if ($null -eq $Text) { return $null }
  $value = ([string]$Text).Trim()
  if (-not $value) { return $null }
  $period = [char]0x3002
  $index = $value.IndexOf($period)
  if ($index -ge 12) { return $value.Substring(0, [Math]::Min($index + 1, 140)).Trim() }
  return $value.Substring(0, [Math]::Min($value.Length, 140)).Trim()
}

function New-CacheAnchor {
  param([int]$Repeat)
  $maxRepeat = 800
  if ($Repeat -gt $maxRepeat) {
    Write-Warning "CacheAnchorRepeat=$Repeat is too large; capped at $maxRepeat to avoid prompt bloat and cache-miss cost spikes."
    $Repeat = $maxRepeat
  }
  if ($Repeat -le 0) { return "" }
  $line = "Fixed CSTD Alpha cache anchor: use the same evidence rules, scoring definitions, valuation safety margin, risk caps, and Chinese report schema; never fabricate facts; ordinary companies should not receive high scores easily."
  return (($line + "`n") * $Repeat)
}

function Complete-OneSentence {
  param([object]$Report)
  $companyName = if ($Report.company -and $Report.company.name) { [string]$Report.company.name } else { "" }
  if (-not (Test-MissingOneSentence -Value $Report.oneSentence -CompanyName $companyName)) { return }
  $sentence = Get-FirstReportSentence -Text $Report.fullSections.onePageConclusion
  if (-not $sentence) { $sentence = Get-FirstReportSentence -Text $Report.fullSections.finalConclusion }
  if (-not $sentence -and $Report.summaryDashboard -and $Report.summaryDashboard.valuationView) {
    $sentence = "${companyName}: $($Report.summaryDashboard.valuationView)"
  }
  if ($sentence) { $Report | Add-Member -NotePropertyName oneSentence -NotePropertyValue $sentence -Force }
}

function Complete-RiskMatrix {
  param([object]$Report)
  if ($Report.riskMatrix -and @($Report.riskMatrix).Count -ge 3) { return }
  $risks = @()
  if ($Report.riskMatrix) {
    $risks += @($Report.riskMatrix | ForEach-Object {
      if ($_.risk) {
        $riskText = [string]$_.risk
        if (-not ($riskText -match "\d+[)）].*\d+[)）]")) { $riskText }
      }
    })
  }
  if ($Report.summaryDashboard -and $Report.summaryDashboard.keyRisks) {
    $risks += @($Report.summaryDashboard.keyRisks | Where-Object { $_ })
  }
  if ($risks.Count -lt 3 -and $Report.fullSections -and $Report.fullSections.risks) {
    $riskText = [string]$Report.fullSections.risks
    $risks += @($riskText -split "(?:[;；。`n]+|(?=\s*\d+[)）.、]))" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch "^主要风险[:：]?$" } | Select-Object -First 6)
  }
  if (-not $risks.Count) { return }
  $Report | Add-Member -NotePropertyName riskMatrix -NotePropertyValue @(
    $risks | Select-Object -First 6 | ForEach-Object {
      [pscustomobject]@{ risk = [string]$_ }
    }
  ) -Force
}

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

function Get-OpenCodeApiKey {
  if ($env:OPENCODE_GO_API_KEY) { return $env:OPENCODE_GO_API_KEY }
  if ($env:OPENCODE_API_KEY) { return $env:OPENCODE_API_KEY }

  $tokenPath = $env:CSTD_ALPHA_TOKEN_FILE
  if ($tokenPath -and (Test-Path -LiteralPath $tokenPath)) {
    $tokenText = Get-Content -LiteralPath $tokenPath -Raw -Encoding UTF8
    $match = [regex]::Match($tokenText, "(?im)^\s*(?:OPENCODE_GO_API_KEY|OPENCODE_API_KEY|OPEN_CODE_API_KEY|OPENCODE)[:=\s]+([^\s]+)")
    if ($match.Success) { return $match.Groups[1].Value }
  }

  throw "OpenCode API key not found. Set OPENCODE_GO_API_KEY, OPENCODE_API_KEY, or set CSTD_ALPHA_TOKEN_FILE with OPENCODE_GO_API_KEY."
}

function Invoke-OpenCodeDeepSeekChatCompletion {
  param(
    [string]$Model,
    [string]$Variant,
    [string]$Prompt,
    [string]$EventsPath
  )

  $apiKey = Get-OpenCodeApiKey
  $apiModel = ($Model -replace "^deepseek/", "") -replace "^opencode/", ""
  $payload = [ordered]@{
    model = $apiModel
    messages = @(
      [ordered]@{
        role = "user"
        content = $Prompt
      }
    )
    stream = $false
    temperature = 0.1
    response_format = [ordered]@{ type = "json_object" }
    max_tokens = 16000
  }
  $payload.reasoning_effort = if ($Variant) { $Variant } else { "max" }
  $payload.thinking = [ordered]@{ type = "enabled" }

  $requestPath = [System.IO.Path]::GetTempFileName()
  $responsePath = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($requestPath, ($payload | ConvertTo-Json -Depth 20 -Compress), [System.Text.UTF8Encoding]::new($false))
    $httpCode = (curl.exe --silent --show-error --max-time 1800 -o $responsePath -w "%{http_code}" -H "Authorization: Bearer $apiKey" -H "Content-Type: application/json; charset=utf-8" --data-binary "@$requestPath" "https://opencode.ai/zen/go/v1/chat/completions") -join ""
    $body = if (Test-Path -LiteralPath $responsePath) { Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 } else { "" }
    if ($LASTEXITCODE -ne 0 -or -not ($httpCode -match '^2\d\d$')) {
      throw "OpenCode Go DeepSeek API failed with HTTP $httpCode. $body"
    }

    $response = $body | ConvertFrom-Json
    $choice = $response.choices[0]
    $finishReason = [string]$choice.finish_reason
    if ($finishReason -eq "length") { throw "OpenCode Go DeepSeek API stopped because max_tokens was reached; retry with a smaller evidence payload or larger max_tokens." }
    $content = [string]$choice.message.content
    if (-not $content) { throw "OpenCode Go DeepSeek API returned empty content." }

    $usage = $response.usage
    $cacheHit = 0
    $cacheMiss = 0
    if ($usage.prompt_cache_hit_tokens -ne $null) { $cacheHit = [int]$usage.prompt_cache_hit_tokens }
    elseif ($usage.prompt_tokens_details -and $usage.prompt_tokens_details.cached_tokens -ne $null) { $cacheHit = [int]$usage.prompt_tokens_details.cached_tokens }
    if ($usage.prompt_cache_miss_tokens -ne $null) { $cacheMiss = [int]$usage.prompt_cache_miss_tokens }
    elseif ($usage.prompt_tokens -ne $null) { $cacheMiss = [Math]::Max(0, [int]$usage.prompt_tokens - $cacheHit) }

    $events = @(
      [ordered]@{
        type = "step_finish"
        part = [ordered]@{
          reason = if ($finishReason) { $finishReason } else { "stop" }
          tokens = [ordered]@{
            input = $cacheMiss
            output = [int]$usage.completion_tokens
            total = [int]$usage.total_tokens
            cache = [ordered]@{ read = $cacheHit }
          }
        }
      }
    )
    ($events | ForEach-Object { $_ | ConvertTo-Json -Depth 20 -Compress }) -join "`n" | Set-Content -LiteralPath $EventsPath -Encoding UTF8
    return $content
  } finally {
    Remove-Item -LiteralPath $requestPath, $responsePath -Force -ErrorAction SilentlyContinue
  }
}

function New-ModelEvidenceResponse {
  param([object]$EvidenceResponse)

  $bundle = $EvidenceResponse.evidence
  $facts = if ($bundle -and $bundle.facts) { $bundle.facts } else { [pscustomobject]@{} }

  return [pscustomobject]@{
    evidence = [pscustomobject]@{
      company = $bundle.company
      retrievedAt = $bundle.retrievedAt
      evidence = @($bundle.evidence)
      facts = [pscustomobject]@{
        selectedCompany = $facts.selectedCompany
        quote = $facts.quote
        summary = $facts.summary
        financialTenYear = $facts.financialTenYear
      }
    }
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
  if ($EvidenceResponse.evidence.company) {
    $Report | Add-Member -NotePropertyName company -NotePropertyValue ([pscustomobject]@{
      name = $EvidenceResponse.evidence.company.name
      ticker = $EvidenceResponse.evidence.company.ticker
      market = $EvidenceResponse.evidence.company.market
      industry = $EvidenceResponse.evidence.company.industry
      sector = $EvidenceResponse.evidence.company.sector
    }) -Force
  } elseif (-not ($Report.PSObject.Properties.Name -contains "company") -and ($Report.PSObject.Properties.Name -contains "companyName")) {
    $Report | Add-Member -NotePropertyName company -NotePropertyValue ([pscustomobject]@{
      name = $Report.companyName
      ticker = $Report.ticker
      market = $Report.market
    })
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
  Complete-ValuationAnalysis -Report $Report -EvidenceResponse $EvidenceResponse
  Complete-OneSentence -Report $Report
  Complete-RiskMatrix -Report $Report
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

function ConvertFrom-ReportJson {
  param(
    [string]$JsonText,
    [string]$CompanyDir
  )

  try {
    return $JsonText | ConvertFrom-Json
  } catch {
    $parseError = $_.Exception.Message
    $rawTextPath = Join-Path $CompanyDir "raw-report.json"
    $repairedTextPath = Join-Path $CompanyDir "raw-report.repaired.json"
    $JsonText | Set-Content -LiteralPath $rawTextPath -Encoding UTF8

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) {
      throw "Report JSON parse failed and Node.js is not available for jsonrepair. Parse error: $parseError"
    }

    $repairScript = Join-Path $PSScriptRoot "repair-json.mjs"
    $repairOutput = (& $nodeCommand.Source $repairScript $rawTextPath $repairedTextPath 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) {
      throw "Report JSON parse failed and jsonrepair failed. Parse error: $parseError Repair output: $repairOutput"
    }
    $repairOutput = Get-Content -LiteralPath $repairedTextPath -Raw -Encoding UTF8

    try {
      return $repairOutput | ConvertFrom-Json
    } catch {
      throw "Report JSON parse failed after jsonrepair. Original parse error: $parseError Repaired parse error: $($_.Exception.Message)"
    }
  }
}

function Resolve-OpenCodeCommand {
  $commands = @(
    (Get-Command opencode.cmd -ErrorAction SilentlyContinue),
    (Get-Command opencode.ps1 -ErrorAction SilentlyContinue),
    (Get-Command opencode -ErrorAction SilentlyContinue)
  ) | Where-Object { $_ }
  foreach ($command in $commands) {
    if ($command.Source -and (Test-Path -LiteralPath $command.Source)) { return $command.Source }
  }

  $candidatePaths = @(
    (Join-Path $env:APPDATA "npm\opencode.cmd"),
    (Join-Path $env:APPDATA "npm\opencode.ps1")
  )
  foreach ($path in $candidatePaths) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }

  throw "OpenCode command not found. Install opencode or add it to PATH."
}

function Resolve-OpenCodeInvocation {
  $opencodeCommand = Resolve-OpenCodeCommand
  $opencodeDirectory = Split-Path -Parent $opencodeCommand
  $opencodeNodeScript = Join-Path $opencodeDirectory "node_modules\opencode-ai\bin\opencode"
  if (Test-Path -LiteralPath $opencodeNodeScript) {
    $localNode = Join-Path $opencodeDirectory "node.exe"
    $nodeCommand = if (Test-Path -LiteralPath $localNode) {
      $localNode
    } else {
      $resolvedNode = Get-Command node.exe -ErrorAction SilentlyContinue
      if (-not $resolvedNode) { $resolvedNode = Get-Command node -ErrorAction SilentlyContinue }
      if (-not $resolvedNode) { throw "Node.js command not found for direct opencode invocation." }
      $resolvedNode.Source
    }
    return [pscustomobject]@{
      FilePath = $nodeCommand
      PrefixArguments = @($opencodeNodeScript)
    }
  }

  return [pscustomobject]@{
    FilePath = $opencodeCommand
    PrefixArguments = @()
  }
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function ConvertTo-WindowsCommandLineArgument {
  param([AllowNull()][string]$Argument)

  if ($null -eq $Argument) { return '""' }
  if ($Argument.Length -eq 0) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($char in $Argument.ToCharArray()) {
    if ($char -eq '\') {
      $backslashes += 1
      continue
    }

    if ($char -eq '"') {
      [void]$builder.Append('\' * (($backslashes * 2) + 1))
      [void]$builder.Append('"')
    } else {
      [void]$builder.Append('\' * $backslashes)
      [void]$builder.Append($char)
    }
    $backslashes = 0
  }
  [void]$builder.Append('\' * ($backslashes * 2))
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-OpenCodeRun {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$OutputPath,
    [string]$ErrorPath,
    [int]$TimeoutMilliseconds,
    [AllowNull()][string]$InputText = $null
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = ($null -ne $InputText)
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if ($null -ne $startInfo.ArgumentList) {
    foreach ($argument in $Arguments) {
      [void]$startInfo.ArgumentList.Add($argument)
    }
  } else {
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join " ")
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  if ($null -ne $InputText) {
    $inputBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($InputText)
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.Close()
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()

  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    Stop-ProcessTree -ProcessId $process.Id
    [void]$process.WaitForExit(10000)
    throw "opencode timed out after $([math]::Round($TimeoutMilliseconds / 60000, 2)) minutes."
  }
  $process.WaitForExit()

  [System.IO.File]::WriteAllText($OutputPath, $stdoutTask.Result, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($ErrorPath, $stderrTask.Result, [System.Text.UTF8Encoding]::new($false))
  return $process.ExitCode
}

$loginResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$BaseUrl/api/session" -ContentType "application/json" -Body (@{ username = $Username; password = $Password } | ConvertTo-Json)
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
$cacheAnchor = New-CacheAnchor -Repeat $CacheAnchorRepeat
$staticPromptDir = if ($UniversePath) { Split-Path -Parent $UniversePath } else { $OutputDir }
$staticPromptPath = Join-Path $staticPromptDir "cstd-alpha-static-report-prompt-cache-$CacheAnchorRepeat-v4.md"
$staticPrompt = @"
You are the CSTD Alpha stock report generator.
Return exactly one JSON object for one report. Do not return Markdown, explanations, or fenced code.
All human-readable report content must be written in Simplified Chinese.

CSTD Alpha fixed generation contract:
- Use only the evidence JSON public evidence, financial table, quote snapshot, and company identity included below this static contract.
- Do not fabricate facts, financial numbers, sources, or URLs. If evidence is weak, score conservatively.
- Provider failures are missing-data evidence only; they are not business weakness by themselves.
- The output must be a single report object, not a reports array.
- The evidence JSON content is already in this input; do not call shell/tools to inspect files or paths.
- The report must pass CSTD Alpha validateReportPayload and these constraints:
- scoreItems20 must be an array of 20 objects, not a map/object.
- oneSentence must be a concise Simplified Chinese investment sentence, not a placeholder.
- Each scoreItems20 object must contain: id, score, evidence, deductions, recentChange, reason.
- scoreItems20 must contain all 20 ids: $($schemaIds -join ", ")
- Each score is 0-100.
- At least 15 scoreItems20 scores must be greater than 0.
- scoreItems20 evidence and deductions must cite concrete public facts, metrics, or observations when available, not only source names.
- evidence must contain at least 2 items with freshness = latest-public.
- conclusion must be one of: 买入, 加仓, 持有, 观察, 减仓, 卖出, 回避.
- If conclusion is 回避, summaryDashboard.positionAdvice and accountRules.maxPosition must be exactly 0%.
- CQS is long-term company quality and should not reward cheap valuation directly.
- IAS is investment attractiveness and includes valuation, safety margin, and risk.
- High leverage, persistent losses, cash-flow deterioration, governance risk, delisting risk, material litigation or penalties must significantly reduce scores.
- summaryDashboard must contain valuationView, positionAdvice, investmentHorizon, keyReasons, keyRisks, trackingMetrics.
- accountRules must contain companyGrade, maxPosition, addCondition, reduceCondition, reviewTiming.
- riskMatrix must contain at least 3 concrete risk objects with risk text. Do not leave it empty.
- valuationAnalysis must contain currentPrice, fairValueRange, buyRange, sellReduceRange, methods, scenarios, conclusion.
- If public quote price is available, valuationAnalysis.buyRange and valuationAnalysis.sellReduceRange must not be unavailable. Use a conservative quote-anchored safety-margin range when intrinsic valuation evidence is insufficient.
- fullSections must contain string fields: onePageConclusion, companyOverview, industryTrack, businessModel, moat, governance, financialQuality, growthInflection, valuation, risks, finalConclusion, accountRules.
- fullSections must be complete but not bloated. onePageConclusion must be 220-380 Chinese characters. companyOverview, industryTrack, businessModel, moat, governance, financialQuality, growthInflection, valuation, and risks must each be 120-280 Chinese characters. finalConclusion and accountRules must each be 100-240 Chinese characters.
- Do not use one-sentence placeholder sections. If data is missing, still write a complete section that explains what is missing, what can be inferred from available evidence, and how uncertainty affects the judgment.
- Before returning JSON, verify that no fullSections field is a terse sentence or below the requested length.
- Use evidence.json financialTenYear rows when available.
- disclaimer must be exactly: 本报告仅用于学习、研究和个人复盘，不构成任何买卖建议。

DeepSeek prefix-cache stable rubric anchor:
$cacheAnchor

After this static contract, read the company block and evidence JSON. The company identity is inside the evidence JSON. Produce the final report JSON now.
"@
if (-not (Test-Path -LiteralPath $staticPromptPath)) {
  try {
    $staticPrompt | Set-Content -LiteralPath $staticPromptPath -Encoding UTF8
  } catch {
    if (-not (Test-Path -LiteralPath $staticPromptPath)) { throw }
  }
}

foreach ($company in $companies) {
  $safeName = (($company.code + "-" + $company.name) -replace '[\\/:*?"<>|\s]+', "_").Trim("_")
  $companyDir = Join-Path $OutputDir $safeName
  New-Item -ItemType Directory -Force $companyDir | Out-Null
  $reportPath = Join-Path $companyDir "report.json"
  $eventsPath = Join-Path $companyDir "opencode-events.jsonl"
  $opencodeErrorPath = Join-Path $companyDir "opencode.stderr.log"
  $promptPath = Join-Path $companyDir "prompt.md"
  $evidencePath = Join-Path $companyDir "evidence.json"
  $statusPath = Join-Path $companyDir "status.json"
  $failurePath = Join-Path $companyDir "failure.json"
  $lockPath = Join-Path $companyDir "work.lock"
  $lockAcquired = $false

  if (Test-Path $statusPath) {
    Write-Output "SKIP existing $($company.code) $($company.name)"
    continue
  }
  if (Test-Path $lockPath) {
    $lockItem = Get-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue
    if ($lockItem -and $lockItem.LastWriteTime -gt (Get-Date).AddMinutes(-90)) {
      Write-Output "SKIP locked $($company.code) $($company.name)"
      continue
    }
    try {
      if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
      }
    } catch {}
  }
  try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $lockWriter = New-Object System.IO.StreamWriter($lockStream)
      try {
        $lockWriter.WriteLine("pid=$PID")
        $lockWriter.WriteLine("startedAt=$((Get-Date).ToUniversalTime().ToString("o"))")
      } finally {
        $lockWriter.Dispose()
      }
    } finally {
      if ($lockStream) { $lockStream.Dispose() }
    }
    $lockAcquired = $true
  } catch {
    Write-Output "SKIP locked $($company.code) $($company.name)"
    continue
  }

  try {
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
  try {
  if (Test-Path $statusPath) {
    Write-Output "SKIP existing $($company.code) $($company.name)"
    break
  }
  Remove-Item -LiteralPath $failurePath -Force -ErrorAction SilentlyContinue

  if ($attempt -gt 1) {
    Write-Output "RETRY attempt $attempt/$MaxAttempts $($company.code) $($company.name)"
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
    industry = $company.industry
    sector = $company.sector
    source = "eastmoney"
  }
  $evidenceBody = @{ company = $candidate } | ConvertTo-Json -Depth 6
  $evidenceTemp = Join-Path $companyDir "evidence-request.json"
  $evidenceBody | Set-Content -LiteralPath $evidenceTemp -Encoding UTF8
  $evidenceRaw = Invoke-JsonPost -Uri "$BaseUrl/api/company-evidence" -BodyPath $evidenceTemp -CookieHeader $cookieHeader -TimeoutSeconds 120
  $evidenceResponse = $evidenceRaw | ConvertFrom-Json
  $fullEvidencePath = Join-Path $companyDir "evidence-full.json"
  $evidenceResponse | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath $fullEvidencePath -Encoding UTF8
  $modelEvidenceJson = New-ModelEvidenceResponse -EvidenceResponse $evidenceResponse | ConvertTo-Json -Depth 60 -Compress
  $modelEvidenceJson | Set-Content -LiteralPath $evidencePath -Encoding UTF8
  $modelInputPath = Join-Path $companyDir "report-input.md"
  $modelInput = @"
$staticPrompt

Company:
$($company.name) / $($company.code) / $($company.listingPlace)

Evidence JSON:
$modelEvidenceJson
"@
  $modelInput | Set-Content -LiteralPath $modelInputPath -Encoding UTF8

  $prompt = @"
Company:
$($company.name) / $($company.code) / $($company.listingPlace)

Model input file used for generation:
$modelInputPath
"@
  $prompt | Set-Content -LiteralPath $promptPath -Encoding UTF8

  Remove-Item -LiteralPath $eventsPath, $opencodeErrorPath -Force -ErrorAction SilentlyContinue
  $opencodeMessage = @"
$modelInput
"@

  if ($DirectDeepSeekApi -and ($Model -like "deepseek/*" -or $Model -like "opencode/deepseek*")) {
    Write-Output "RUN OpenCode Go DeepSeek API $($company.code) $($company.name)"
    $raw = Invoke-OpenCodeDeepSeekChatCompletion -Model $Model -Variant $Variant -Prompt $opencodeMessage -EventsPath $eventsPath
  } else {
    Write-Output "RUN opencode $($company.code) $($company.name)"
    $opencodeInvocation = Resolve-OpenCodeInvocation
    $opencodeArgs = @($opencodeInvocation.PrefixArguments) + @(
      "run",
      "--pure",
      "--model", $Model,
      "--variant", $Variant,
      "--agent", $Agent,
      "--format", "json",
      "--dir", (Get-Location).Path
    )
    $opencodeExitCode = Invoke-OpenCodeRun -FilePath $opencodeInvocation.FilePath -Arguments $opencodeArgs -OutputPath $eventsPath -ErrorPath $opencodeErrorPath -TimeoutMilliseconds ($OpencodeTimeoutMinutes * 60 * 1000) -InputText $opencodeMessage
    if ($null -ne $opencodeExitCode -and $opencodeExitCode -ne 0) {
      $stderr = if (Test-Path $opencodeErrorPath) { Get-Content -LiteralPath $opencodeErrorPath -Raw -Encoding UTF8 } else { "" }
      throw "opencode failed with exit code $opencodeExitCode. $stderr"
    }

    $textParts = Get-Content -LiteralPath $eventsPath -Encoding UTF8 | ForEach-Object {
      try {
        $event = $_ | ConvertFrom-Json
        if ($event.type -eq "text" -and $event.part.text) { [string]$event.part.text }
      } catch {}
    }
    $raw = ($textParts -join "").Trim()
  }

  $raw = Extract-JsonObjectText -Text $raw
  if (-not $raw.StartsWith("{")) {
    if (Test-Path $reportPath) {
      $raw = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8
    } else {
      throw "opencode did not return a JSON object for $($company.code)."
    }
  }
  $report = Normalize-ModelReport -Report (ConvertFrom-ReportJson -JsonText $raw -CompanyDir $companyDir) -SchemaIds $schemaIds -EvidenceResponse $evidenceResponse
  $report | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $reportPath -Encoding UTF8

  $imported = $null
  if ($ImportOnline) {
    Write-Output "IMPORT report $($company.code) $($company.name)"
    $importBodyPath = Join-Path $companyDir "import-request.json"
    @{ reports = @($report) } | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $importBodyPath -Encoding UTF8
    $importRaw = Invoke-JsonPost -Uri "$BaseUrl/api/report-library" -BodyPath $importBodyPath -CookieHeader $cookieHeader -TimeoutSeconds 120
    $imported = $importRaw | ConvertFrom-Json
  } else {
    Write-Output "SKIP online import $($company.code) $($company.name). Pass -ImportOnline to write the D1/R2 report library."
  }
  [pscustomobject]@{
    code = $company.code
    name = $company.name
    importedAt = (Get-Date).ToUniversalTime().ToString("o")
    onlineImported = [bool]$ImportOnline
    imported = if ($imported) { $imported.imported } else { @() }
  } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statusPath -Encoding UTF8
  Remove-Item -LiteralPath $failurePath -Force -ErrorAction SilentlyContinue
  Write-Output "DONE $($company.code) $($company.name)"
  } catch {
    $isFinalAttempt = $attempt -ge $MaxAttempts
    if ($isFinalAttempt) {
      [pscustomobject]@{
        code = $company.code
        name = $company.name
        failedAt = (Get-Date).ToUniversalTime().ToString("o")
        attempts = $attempt
        error = $_.Exception.Message
      } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $failurePath -Encoding UTF8
      Write-Output "FAIL $($company.code) $($company.name): $($_.Exception.Message)"
      if (-not $ContinueOnError) { throw }
    } else {
      Write-Output "RETRYABLE FAIL $($company.code) $($company.name) attempt ${attempt}/${MaxAttempts}: $($_.Exception.Message)"
      Start-Sleep -Seconds ([Math]::Min(30, 8 * $attempt))
    }
  }
  }
  } finally {
    if ($lockAcquired) {
      try {
        if ($lockPath -and (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
          Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        }
      } catch {}
    }
  }
}
