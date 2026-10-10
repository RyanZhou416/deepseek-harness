# Deploy a pinned dsh-plugin-subscriptions artifact into the live Web profile.
#
# Run this from a PLAIN PowerShell window AFTER the DSH Host has stopped
# (the Host serving this fork cannot update itself). The script refuses to
# run while the Web Host still listens on its port unless -SkipHostCheck is
# passed. It backs up the currently installed plugin before swapping, updates
# the profile's package.json + pnpm-lock.yaml through pnpm so a later
# `pnpm install` cannot silently downgrade, and never touches the credential
# store under DSH_HOME\plugins\subscriptions.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\deploy-subscriptions-web.ps1
#         powershell -ExecutionPolicy Bypass -File .\deploy-subscriptions-web.ps1 -Version 0.9.4-dsh017rc1.16
# Rollback (after stopping the Host again):
#         corepack pnpm@11.7.0 add "dsh-plugin-subscriptions@file:C:/Project/deepseek-harness/fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.14.tgz"
#         (from C:\Project\deepseek-harness-data\profiles\web; or restore the backup directory printed below)

param(
  [string]$Version = '0.9.4-dsh017rc1.16',
  [int]$HostPort = 3080,
  [switch]$SkipHostCheck
)

$ErrorActionPreference = 'Stop'
$repo    = 'C:\Project\deepseek-harness'
$profile = 'C:\Project\deepseek-harness-data\profiles\web'
$name    = 'dsh-plugin-subscriptions'
$tgz     = Join-Path $repo "fork-plugins\releases\$name-$Version.tgz"
$sha     = "$tgz.sha256"

function Fail($message) { Write-Host "[deploy] ERROR: $message" -ForegroundColor Red; exit 1 }

# 1. Preconditions -----------------------------------------------------------
if (-not (Test-Path $tgz))  { Fail "artifact not found: $tgz" }
if (-not (Test-Path $profile)) { Fail "profile directory not found: $profile" }
if (-not (Test-Path $sha)) { Fail "sha256 sidecar not found: $sha" }

$expected = (Get-Content $sha -Raw).Trim().ToUpper()
$actual   = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToUpper()
if ($actual -ne $expected) { Fail "sha256 mismatch: expected $expected, got $actual" }
Write-Host "[deploy] artifact verified: $Version"

if (-not $SkipHostCheck) {
  $listeners = Get-NetTCPConnection -LocalPort $HostPort -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    Fail "the Web Host still listens on port $HostPort — stop DSH first (or pass -SkipHostCheck at your own risk)."
  }
  Write-Host "[deploy] no Host listening on port $HostPort"
} else {
  Write-Host "[deploy] host check skipped (-SkipHostCheck)"
}

# 2. Backup ------------------------------------------------------------------
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $repo "fork-plugins\releases\backup-web-profile-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$installed = Join-Path $profile "node_modules\$name"
if (Test-Path $installed) {
  Copy-Item -Recurse -Force $installed (Join-Path $backup $name)
}
Copy-Item -Force (Join-Path $profile 'package.json')    $backup
Copy-Item -Force (Join-Path $profile 'pnpm-lock.yaml')  $backup
Write-Host "[deploy] backup: $backup"

# 3. Swap via pnpm (updates package.json + lockfile + node_modules together) --
Push-Location $profile
try {
  corepack pnpm@11.7.0 add --ignore-scripts "$name@file:$tgz"
  if ($LASTEXITCODE -ne 0) { Fail "pnpm add exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# 4. Verify ------------------------------------------------------------------
$pkg = Get-Content (Join-Path $installed 'package.json') -Raw | ConvertFrom-Json
if ($pkg.version -ne $Version) { Fail "installed version is $($pkg.version), expected $Version" }
if (-not (Test-Path (Join-Path $installed 'lib\index.js'))) { Fail "installed package has no lib\index.js" }
$dep = (Get-Content (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json).dependencies.$name
if ($dep -notmatch [regex]::Escape($Version)) { Fail "profile dependency still points at: $dep" }

Write-Host ""
Write-Host "[deploy] OK: $name $Version installed in $profile" -ForegroundColor Green
Write-Host "[deploy] Credential store (DSH_HOME\plugins\subscriptions) was NOT touched."
Write-Host "[deploy] Restart the Host with your usual launch command."
Write-Host "[deploy] Rollback: $repo\fork-plugins\releases\backup-web-profile-$stamp (see script header)."
