@echo off
setlocal
cd /d "%~dp0"

set "DSH_STEP=preparing runtime diagnostics"
if not defined DSH_HOME for %%I in ("%~dp0..\deepseek-harness-data") do set "DSH_HOME=%%~fI"
set "DSH_DIAGNOSTICS=%DSH_HOME%\diagnostics"
if not exist "%DSH_DIAGNOSTICS%" mkdir "%DSH_DIAGNOSTICS%"
if errorlevel 1 goto :failed

set "DSH_RUNTIME_NODE_OPTIONS=--max-old-space-size=32768 --report-on-fatalerror --report-uncaught-exception --report-exclude-env --report-exclude-network --report-directory=%DSH_DIAGNOSTICS%"
if defined NODE_OPTIONS (
  set "NODE_OPTIONS=%NODE_OPTIONS% %DSH_RUNTIME_NODE_OPTIONS%"
) else (
  set "NODE_OPTIONS=%DSH_RUNTIME_NODE_OPTIONS%"
)

set "DSH_STEP=checking Node.js"
where node >nul 2>&1
if errorlevel 1 goto :missing_node

set "DSH_STEP=preparing pnpm"
call "%~dp0scripts\fork-windows-pnpm.cmd" --version
if errorlevel 1 goto :failed

set "DSH_STEP=starting DeepSeek Harness"
set "DSH_MEMORY_PATCH_ARGS="
if exist "%DSH_HOME%\profiles\web\memory-limits.patch.yml" set DSH_MEMORY_PATCH_ARGS=--patch "%DSH_HOME%\profiles\web\memory-limits.patch.yml"
call "%~dp0scripts\fork-windows-pnpm.cmd" exec node --expose-internals --import tsx/esm "%~dp0apps\cli\src\bin.ts" web --patch "%~dp0fork-runtime\diagnostics\cordis.patch.yml" %DSH_MEMORY_PATCH_ARGS%
if errorlevel 1 goto :failed
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
