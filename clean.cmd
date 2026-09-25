@echo off
setlocal
cd /d "%~dp0"

set "DSH_STEP=checking Node.js"
where node >nul 2>&1
if errorlevel 1 goto :missing_node

set "DSH_STEP=preparing pnpm"
call "%~dp0scripts\fork-windows-pnpm.cmd" --version
if errorlevel 1 goto :failed

if exist "node_modules\tsx\package.json" goto :clean
set "DSH_STEP=installing project dependencies"
echo Project dependencies are missing. Installing them before cleanup...
if not defined DSH_PNPM_CHILD_CONCURRENCY set "DSH_PNPM_CHILD_CONCURRENCY=4"
call "%~dp0scripts\fork-windows-pnpm.cmd" install --child-concurrency=%DSH_PNPM_CHILD_CONCURRENCY%
if errorlevel 1 goto :failed

:clean
set "DSH_STEP=cleaning repository build outputs"
call "%~dp0scripts\fork-windows-pnpm.cmd" run clean
if errorlevel 1 goto :failed

echo.
echo Repository build outputs cleaned successfully.
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
