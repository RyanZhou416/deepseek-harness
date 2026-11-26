# Resolve the Node.js runtime the Windows launchers use and print its directory.
#
# The exact version is pinned in the repository's `.node-version`. The runtime
# lives in a private per-user directory (%LOCALAPPDATA%\dsh-node\v<version>),
# so the launchers never depend on, or modify, a system-wide Node.js install.
# A missing runtime is downloaded once as the official Windows x64 zip and
# accepted only when its SHA-256 matches the release's SHASUMS256.txt.
#
# DSH_NODE_MIRROR selects the download base (default https://nodejs.org/dist,
# falling back to https://registry.npmmirror.com/-/binary/node). Written for
# Windows PowerShell 5.1 so run.cmd needs no extra tooling.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root '.node-version') -Raw).Trim().TrimStart('v')
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw ".node-version must hold one exact version such as 24.22.3; got '$version'" }

$home_ = Join-Path $env:LOCALAPPDATA 'dsh-node'
$target = Join-Path $home_ "v$version"
$exe = Join-Path $target 'node.exe'

function Test-Runtime {
  if (-not (Test-Path -LiteralPath $exe)) { return $false }
  $reported = & $exe --version 2>$null
  return $reported -eq "v$version"
}

if (-not (Test-Runtime)) {
  $name = "node-v$version-win-x64"
  $mirrors = if ($env:DSH_NODE_MIRROR) { @($env:DSH_NODE_MIRROR) } else { @('https://nodejs.org/dist', 'https://registry.npmmirror.com/-/binary/node') }
  $staging = Join-Path $home_ ".download-$PID"
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  try {
    $zip = Join-Path $staging "$name.zip"
    $downloaded = $false
    foreach ($mirror in $mirrors) {
      try {
        [Console]::Error.WriteLine("Downloading Node.js v$version from $mirror ...")
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$mirror/v$version/SHASUMS256.txt" -TimeoutSec 60).Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
        if (-not $line) { throw "SHASUMS256.txt has no entry for $name.zip" }
        $expected = ($line -split '\s+')[0].ToLowerInvariant()
        Invoke-WebRequest -UseBasicParsing -Uri "$mirror/v$version/$name.zip" -OutFile $zip -TimeoutSec 600
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "SHA-256 mismatch for $name.zip: expected $expected, got $actual" }
        $downloaded = $true
        break
      } catch {
        [Console]::Error.WriteLine("  $($_.Exception.Message)")
      }
    }
    if (-not $downloaded) { throw "could not download a verified Node.js v$version; set DSH_NODE_MIRROR to a reachable mirror" }
    Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $staging $name) -Destination $target
  } finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  }
  if (-not (Test-Runtime)) { throw "Node.js v$version at $target does not report its version" }
}

Write-Output $target
