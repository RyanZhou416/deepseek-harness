#Requires -Version 7.0
# A prepared, one-shot AetherShell upgrade runs before run.cmd starts the Host.
[CmdletBinding()]
param([Parameter(Mandatory)][string] $DshHome, [switch] $CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$pending = Join-Path $DshHome 'aether-activation.pending.json'
if (-not (Test-Path -LiteralPath $pending -PathType Leaf)) { exit 0 }
$checkout = Split-Path $PSScriptRoot -Parent
$activation = 'C:\Project\AetherShell\scripts\activate-dsh-aether.ps1'
$held = $null
try {
    $held = [IO.FileStream]::new($pending, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $reader = [IO.StreamReader]::new($held, [Text.UTF8Encoding]::new($false), $true, 1024, $true)
    try { $plan = $reader.ReadToEnd() | ConvertFrom-Json -AsHashtable } finally { $reader.Dispose() }
    if ($plan['schemaVersion'] -ne 1 -or $plan['nativeVersion'] -cne '12.0.2+ryan.3' -or $plan['pluginVersion'] -cne '0.1.0-dsh017rc1.5') { throw 'The prepared AetherShell update has an unsupported version.' }
    if ([IO.Path]::GetFullPath($plan['dshHome']).TrimEnd([char]92) -ne [IO.Path]::GetFullPath($DshHome).TrimEnd([char]92)) { throw 'The prepared update belongs to another DSH home.' }
    if ($plan['completed'] -ceq $true) { exit 0 }
    if ((Get-FileHash -LiteralPath $activation -Algorithm SHA256).Hash -cne $plan['activationScriptSha256']) { throw 'The prepared activation script changed; verify it again before starting DSH.' }
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $arguments = @('-NoLogo','-NoProfile','-File',$activation,'-DshHome',$DshHome,'-DshCheckout',$checkout,'-ExpectedHostProcessId',[string]$plan['hostProcessId'])
    Write-Host 'Checking the prepared AetherShell update before starting DSH...'
    & $pwsh @arguments -CheckOnly
    $preflightExit = $LASTEXITCODE
    if ($CheckOnly) { exit $preflightExit }
    if ($preflightExit -ne 0) { throw 'AetherShell activation is blocked. Close the old DSH Host and interpreter processes, then run run.cmd again.' }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        & $pwsh @arguments
        $activationExit = $LASTEXITCODE
    } else {
        Write-Host 'Windows will ask permission to update AetherShell in Program Files. This does not start another DSH Host.'
        $quoted = @($arguments | ForEach-Object { if ($_ -match '[\s"]') { if ($_ -match '"') { throw 'A quoted activation argument is unsupported.' }; '"' + $_ + '"' } else { $_ } })
        $elevated = Start-Process -FilePath $pwsh -Verb RunAs -ArgumentList $quoted -PassThru -Wait
        $activationExit = $elevated.ExitCode
        $elevated.Dispose()
    }
    if ($activationExit -ne 0) { throw "AetherShell activation failed with exit $activationExit; DSH was not started. Review the activation backup/error before trying again." }
    $manifest = Get-Content -LiteralPath (Join-Path $DshHome 'profiles\web\node_modules\@ryanzhou416\dsh-plugin-aether-shell\package.json') -Raw -Encoding utf8 | ConvertFrom-Json
    if ($manifest.version -cne $plan['pluginVersion']) { throw 'The installed adapter does not match the prepared update.' }
    if ((Get-FileHash -LiteralPath 'C:\Program Files\AetherShell\ae.exe' -Algorithm SHA256).Hash -cne $plan['nativeSha256']) { throw 'The installed interpreter does not match the prepared update.' }
    $plan['completed'] = $true
    $plan['completedUtc'] = [datetime]::UtcNow.ToString('o')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($plan | ConvertTo-Json -Depth 5))
    $held.Position = 0; $held.SetLength(0); $held.Write($bytes, 0, $bytes.Length); $held.Flush($true)
    Write-Host 'AetherShell ryan.3, adapter .5 and typed-v1 are ready. Starting the normal DSH Host next.'
} catch {
    Write-Error $_
    exit 1
} finally { if ($null -ne $held) { $held.Dispose() } }
exit 0
