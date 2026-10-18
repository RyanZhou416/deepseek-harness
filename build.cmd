@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

set "DSH_STEP=checking Node.js"
where node >nul 2>&1
if errorlevel 1 goto :missing_node

set "DSH_SUBSCRIPTIONS_PLAN=%~dp0fork-runtime\subscriptions-maintenance\plan.json"
set "DSH_LOCAL_PNPM=%~dp0node_modules\pnpm\bin\pnpm.mjs"
if /i "%~1"=="--finish-subscriptions" goto :finish_subscriptions
if not "%~1"=="" goto :invalid_arguments
if not exist "%DSH_SUBSCRIPTIONS_PLAN%" goto :ordinary_build
for /f "delims=" %%M in ('node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const done=fs.existsSync(p.completeReceipt);if(p.installOnly===true&&done)console.log('ordinary');else if(p.resumeBuilt===true&&!done)console.log('resume')" "%DSH_SUBSCRIPTIONS_PLAN%"') do (
  if "%%M"=="resume" goto :finish_subscriptions
  if "%%M"=="ordinary" goto :ordinary_build
)

set "DSH_STEP=checking the stopped Host and applying the subscription update"
where pwsh >nul 2>&1
if errorlevel 1 goto :failed
pwsh -NoLogo -NoProfile -File "%~dp0scripts\fork-subscriptions-maintenance.ps1" -Stage BeforeBuild -PlanFile "%DSH_SUBSCRIPTIONS_PLAN%"
if errorlevel 1 goto :failed

set "DSH_STEP=installing the verified local workspace links"
set "pnpm_config_trust_lockfile=true"
set "COREPACK_ENABLE_NETWORK=0"
set "pnpm_config_verify_deps_before_run=false"
node "%DSH_LOCAL_PNPM%" install --offline --frozen-lockfile --ignore-scripts --child-concurrency=2 --optimistic-repeat-install=false --config.auto-install-peers=false
if errorlevel 1 goto :failed
set "DSH_STEP=building the project"
node "%DSH_LOCAL_PNPM%" run build
if errorlevel 1 goto :failed
set "DSH_STEP=verifying and installing the subscription candidate"
pwsh -NoLogo -NoProfile -File "%~dp0scripts\fork-subscriptions-maintenance.ps1" -Stage AfterBuild -PlanFile "%DSH_SUBSCRIPTIONS_PLAN%"
if errorlevel 1 goto :failed
goto :build_complete

:finish_subscriptions
set "DSH_STEP=resuming subscription checks against the verified existing build"
if not exist "%DSH_SUBSCRIPTIONS_PLAN%" goto :missing_subscription_plan
pwsh -NoLogo -NoProfile -File "%~dp0scripts\fork-subscriptions-maintenance.ps1" -Stage AfterBuild -ResumeBuilt -PlanFile "%DSH_SUBSCRIPTIONS_PLAN%"
if errorlevel 1 goto :failed
goto :build_complete

:missing_subscription_plan
echo ERROR: No prepared subscription maintenance plan exists.
exit /b 1

:invalid_arguments
echo ERROR: Supported argument: --finish-subscriptions
exit /b 1

:ordinary_build
set "DSH_STEP=preparing pnpm"
call "%~dp0scripts\fork-windows-pnpm.cmd" --version
if errorlevel 1 goto :failed
set "DSH_STEP=installing project dependencies"
if not defined DSH_PNPM_CHILD_CONCURRENCY set "DSH_PNPM_CHILD_CONCURRENCY=4"
call "%~dp0scripts\fork-windows-pnpm.cmd" install --child-concurrency=%DSH_PNPM_CHILD_CONCURRENCY% --optimistic-repeat-install=false
if errorlevel 1 goto :failed
set "DSH_STEP=building the project"
call "%~dp0scripts\fork-windows-pnpm.cmd" run build
if errorlevel 1 goto :failed
set "DSH_STEP=building and installing the fork plugins into the web profile"
call "%~dp0scripts\fork-windows-pnpm.cmd" exec tsx "%~dp0scripts\fork-plugins-build.ts"
if errorlevel 1 goto :failed

:build_complete

echo.
echo Build completed successfully.
exit /b 0

:missing_node
echo.
echo ERROR: Node.js was not found in PATH.
echo Install a supported Node.js version ^(22.19 or newer^) and try again.
goto :pause_and_exit

:failed
set "DSH_EXIT_CODE=%errorlevel%"
echo.
echo ERROR: Failed while %DSH_STEP% ^(exit code %DSH_EXIT_CODE%^).
echo Review the messages above for details.

:pause_and_exit
echo.
pause
if defined DSH_EXIT_CODE exit /b %DSH_EXIT_CODE%
exit /b 1
