param(
  [string]$OutputPath = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".tmp\cstd-alpha-opencode-batch\ashare-universe.json"),
  [int]$PageSize = 100
)

$ErrorActionPreference = "Stop"
$outDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force $outDir | Out-Null

$fields = "f12,f13,f14,f100,f102"
$fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
$all = New-Object System.Collections.Generic.List[object]
$page = 1
$total = $null
$hosts = @(
  "push2.eastmoney.com",
  "14.push2.eastmoney.com",
  "70.push2.eastmoney.com",
  "84.push2.eastmoney.com",
  "88.push2.eastmoney.com"
)

do {
  $raw = $null
  for ($attempt = 1; $attempt -le ($hosts.Count * 4); $attempt += 1) {
    $hostName = $hosts[($attempt - 1) % $hosts.Count]
    $url = "https://$hostName/api/qt/clist/get?pn=$page&pz=$PageSize&po=1&np=1&fltt=2&invt=2&fid=f3&fs=$([uri]::EscapeDataString($fs))&fields=$fields"
    $raw = (curl.exe -L --http1.1 --ssl-no-revoke --silent --show-error --connect-timeout 10 --max-time 25 -A "Mozilla/5.0" $url) -join ""
    if ($raw -and $raw.TrimStart().StartsWith("{")) { break }
    if (($attempt % $hosts.Count) -eq 0) {
      Start-Sleep -Seconds 8
    } else {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $raw -or -not $raw.TrimStart().StartsWith("{")) { throw "Eastmoney returned non-JSON on page $page." }
  $json = $raw | ConvertFrom-Json
  if (-not $json.data) { throw "Eastmoney response missing data on page $page." }
  $total = [int]$json.data.total
  foreach ($row in $json.data.diff) {
    $code = [string]$row.f12
    $marketId = [int]$row.f13
    $listingPlace = if ($code.StartsWith("688")) { "STAR Market" } elseif ($code.StartsWith("3")) { "ChiNext" } elseif ($marketId -eq 1) { "SH-A" } else { "SZ-A" }
    $exchange = if ($marketId -eq 1) { "Shanghai Stock Exchange" } else { "Shenzhen Stock Exchange" }
    $quotePrefix = if ($marketId -eq 1) { "1" } else { "0" }
    $all.Add([pscustomobject]@{
      id = "eastmoney:$quotePrefix.$code"
      name = [string]$row.f14
      code = $code
      exchange = $exchange
      listingPlace = $listingPlace
      marketType = "AStock"
      quoteId = "$quotePrefix.$code"
      source = "eastmoney"
      industry = [string]$row.f100
      region = [string]$row.f102
    })
  }
  Write-Output "Fetched page $page; $($all.Count)/$total companies"
  Start-Sleep -Milliseconds 1500
  $page += 1
} while ($all.Count -lt $total)

$payload = [pscustomobject]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  count = $all.Count
  companies = $all
}

$payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output "Saved $($all.Count) A-share companies to $OutputPath"
