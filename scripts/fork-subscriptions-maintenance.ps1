<# Build hooks for a hash-bound local subscription update. The user stops and starts DSH. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('BeforeBuild', 'AfterBuild')][string]$Stage,
  [Parameter(Mandatory = $true)][string]$PlanFile,
  [switch]$ResumeBuilt
)
$ErrorActionPreference = 'Stop'
$phaseFile = "$PlanFile.phase.json"
function Write-Json([string]$Path, $Value) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
}
function Required($Value, [string]$Name) {
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value -or [string]$property.Value -eq '') { throw "Missing maintenance field: $Name" }
  return $property.Value
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
function Run-Step([string]$Exe, [object[]]$Arguments, [string]$Cwd, [string]$Log, [int]$Seconds) {
  # The prepared plan uses literal arguments, not shell commands.
  $joined = (@($Arguments) | ForEach-Object {
    $arg = [string]$_
    if ($arg.Contains('"')) { throw 'Maintenance arguments must not contain embedded quotes' }
    if ($arg -match '\s' -or $arg -eq '') { '"' + $arg + '"' } else { $arg }
  }) -join ' '
  $child = Start-Process -FilePath $Exe -ArgumentList $joined -WorkingDirectory $Cwd -NoNewWindow -PassThru -RedirectStandardOutput "$Log.out.log" -RedirectStandardError "$Log.err.log"
  $timedOut = -not $child.WaitForExit($Seconds * 1000)
  if ($timedOut) {
    $child.Kill($true)
    $child.WaitForExit()
    throw "Maintenance command timed out; see $Log.err.log"
  }
  $child.WaitForExit()
  $child.Refresh()
  if ($child.ExitCode -ne 0) { throw "Maintenance command exited $($child.ExitCode); see $Log.err.log and $Log.out.log" }
}
try {
  if (-not [System.IO.Path]::IsPathRooted($PlanFile)) { throw 'PlanFile must be absolute' }
  $plan = Get-Content -LiteralPath $PlanFile -Raw | ConvertFrom-Json
  $repo = Required $plan 'repo'
  $node = Required $plan 'node'
  $runRoot = Required $plan 'runRoot'
  $logs = Join-Path $runRoot 'build-logs'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $phaseFile = Join-Path $runRoot "build-maintenance-$Stage.phase.json"
  $port = [int](Required $plan 'port')
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $listener) { throw "DSH still listens on port $port (pid $($listener.OwningProcess)). Stop it manually, then run build.cmd again." }
  foreach ($pair in @(@('applyScript', 'applyScriptSha256'), @('finalizeScript', 'finalizeScriptSha256'), @('sourceInputsManifestPath', 'sourceInputsManifestSha256'), @('candidatePath', 'candidateSha256'))) {
    if ((Hash (Required $plan $pair[0])) -ne (Required $plan $pair[1]).ToLowerInvariant()) { throw "Maintenance input changed: $($pair[0])" }
  }
  $receipt = Required $plan 'completeReceipt'
  if (Test-Path -LiteralPath $receipt) {
    $done = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($done.candidateSha256 -ne $plan.candidateSha256 -or $done.version -ne $plan.version) { throw 'Completion receipt belongs to a different candidate' }
    Write-Host "Subscriptions maintenance already completed: $($plan.version)"
    exit 0
  }
  Write-Json $phaseFile @{ stage=$Stage; state='started'; at=(Get-Date).ToString('o') }
  if ($Stage -eq 'BeforeBuild') {
    Run-Step $node @($plan.applyScript, '--preflight', $PlanFile) $repo (Join-Path $logs 'preflight') 60
    Run-Step $node @($plan.applyScript, '--apply', $PlanFile) $repo (Join-Path $logs 'apply') 60
    Write-Json $phaseFile @{ stage=$Stage; state='applied'; at=(Get-Date).ToString('o') }
    Write-Host 'Subscriptions source integration applied with verified backups.'
    exit 0
  }
  if ($ResumeBuilt) {
    Run-Step $node @($plan.applyScript, '--preflight', $PlanFile) $repo (Join-Path $logs 'resume-preflight') 60
  }
  $index = 0
  foreach ($step in @($plan.afterBuildSteps)) {
    $index++
    $arguments = @($step.args)
    if ($ResumeBuilt) {
      if ($arguments.Count -lt 1 -or $arguments[0] -ne $plan.finalizeScript) { throw 'Resume mode only permits the prepared finalizer' }
      $arguments += '--resume-built'
    }
    Write-Host "Subscriptions final check $index; details: $logs"
    Run-Step (Required $step 'exe') $arguments (Required $step 'cwd') (Join-Path $logs "final-$index") ([int](Required $step 'timeoutSeconds'))
  }
  Run-Step $node @($plan.applyScript, '--verify', $PlanFile) $repo (Join-Path $logs 'verify') 60
  Write-Json $receipt @{ version=$plan.version; candidateSha256=$plan.candidateSha256; verifiedAt=(Get-Date).ToString('o'); status='installed-and-verified' }
  Write-Json $phaseFile @{ stage=$Stage; state='completed'; at=(Get-Date).ToString('o') }
  Write-Host "Subscriptions $($plan.version) installed and verified. Run run.cmd to start DSH."
  exit 0
} catch {
  $reason = $_.Exception.Message
  Write-Json $phaseFile @{ stage=$Stage; state='failed'; reason=$reason; at=(Get-Date).ToString('o') }
  [Console]::Error.WriteLine("Subscriptions maintenance failed: $reason")
  exit 1
}
