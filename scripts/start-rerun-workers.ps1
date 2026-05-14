param(
  [string]$UniversePath = "",
  [string]$OutputDir = "",
  [string]$RunRoot = "",
  [string]$Model = "deepseek/deepseek-v4-flash",
  [string]$Variant = "max",
  [string]$Agent = "build",
  [int]$Workers = 2,
  [int]$MaxWorkers = 4,
  [int]$CacheAnchorRepeat = 1800,
  [int]$MaxAttempts = 2,
  [int]$OpencodeTimeoutMinutes = 20,
  [switch]$ImportOnline,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$testRoot = "E:\DEV\$([char]0x6D4B)$([char]0x8BD5)\cstd-alpha-opencode-batch"
if (-not $UniversePath) { $UniversePath = Join-Path $testRoot "ashare-universe-next-pass-quality-and-missing-20260514-1614.json" }
if (-not $OutputDir) { $OutputDir = Join-Path $testRoot "production-rerun" }
if (-not $RunRoot) { $RunRoot = Join-Path $testRoot "production-runs" }

if (-not (Test-Path -LiteralPath $UniversePath)) { throw "Universe file not found: $UniversePath" }
if ($Workers -lt 1) { throw "Workers must be at least 1." }
if ($Workers -gt $MaxWorkers) { throw "Workers=$Workers exceeds MaxWorkers=$MaxWorkers. Raise -MaxWorkers explicitly if you really want more." }

$repoRoot = Split-Path -Parent $PSScriptRoot
$batchScript = Join-Path $repoRoot "scripts\opencode-report-batch.ps1"
if (-not (Test-Path -LiteralPath $batchScript)) { throw "Batch script not found: $batchScript" }

$universe = Get-Content -LiteralPath $UniversePath -Raw -Encoding UTF8 | ConvertFrom-Json
$companies = @($universe.companies)
if (-not $companies.Count) { throw "Universe has no companies: $UniversePath" }

New-Item -ItemType Directory -Force -Path $OutputDir, $RunRoot | Out-Null

$sliceSize = [Math]::Ceiling($companies.Count / $Workers)
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$started = @()

for ($index = 0; $index -lt $Workers; $index += 1) {
  $offset = [int]($index * $sliceSize)
  $limit = [int]([Math]::Min($sliceSize, $companies.Count - $offset))
  if ($limit -le 0) { continue }

  $runDir = Join-Path $RunRoot "$timestamp-rerun-w$($index + 1)"
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null
  $stdout = Join-Path $runDir "stdout.log"
  $stderr = Join-Path $runDir "stderr.log"

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $batchScript,
    "-UniversePath", $UniversePath,
    "-OutputDir", $OutputDir,
    "-Offset", $offset,
    "-Limit", $limit,
    "-Model", $Model,
    "-Variant", $Variant,
    "-Agent", $Agent,
    "-ContinueOnError",
    "-MaxAttempts", $MaxAttempts,
    "-OpencodeTimeoutMinutes", $OpencodeTimeoutMinutes,
    "-CacheAnchorRepeat", $CacheAnchorRepeat
  )
  if ($ImportOnline) { $arguments += "-ImportOnline" }

  $started += [pscustomobject]@{
    Worker = $index + 1
    ProcessId = if ($DryRun) { $null } else {
      (Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru).Id
    }
    Offset = $offset
    Limit = $limit
    RunDir = $runDir
    DryRun = [bool]$DryRun
  }
}

$started | Format-Table -AutoSize
