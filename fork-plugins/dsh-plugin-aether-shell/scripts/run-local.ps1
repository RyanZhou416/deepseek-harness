param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('typecheck', 'test', 'build', 'pack')]
  [string] $Action,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ExtraArgs
)
$ErrorActionPreference = 'Stop'
$plugin = Split-Path $PSScriptRoot -Parent
$checkout = Split-Path (Split-Path $plugin -Parent) -Parent
$node = (Get-Command node -ErrorAction Stop).Source
$tools = Join-Path $checkout 'node_modules'
Push-Location $plugin
try {
  switch ($Action) {
    'typecheck' { & $node (Join-Path $PSScriptRoot 'typecheck.mjs') @ExtraArgs }
    'test' { & $node (Join-Path $tools 'vitest\vitest.mjs') run --config vitest.config.ts @ExtraArgs }
    'build' { & $node (Join-Path $tools 'tsdown\dist\run.mjs') --config tsdown.config.ts @ExtraArgs }
    'pack' { npm pack --ignore-scripts --pack-destination (Join-Path $checkout 'fork-plugins\releases') @ExtraArgs }
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
