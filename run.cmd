@echo off
setlocal
cd /d "%~dp0"

rem Start the built CLI directly. The TypeScript source launch through pnpm is a
rem fallback for a tree that has not been built yet; DSH_CLI_ENTRY overrides the
rem built entry (test fixtures and alternate builds).

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

set "DSH_STEP=preparing Node.js"
rem The launchers run the Node.js version pinned in .node-version from a private
rem per-user directory; see scripts\fork-windows-node.ps1. DSH_NODE_DIR, when set,
rem names another Node.js directory to use instead.
if not defined DSH_NODE_DIR for /f "delims=" %%D in ('powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fork-windows-node.ps1"') do set "DSH_NODE_DIR=%%D"
if not defined DSH_NODE_DIR goto :missing_node
set "PATH=%DSH_NODE_DIR%;%PATH%"

set "DSH_DIAGNOSTICS_PATCH_ARG=--patch "%~dp0fork-runtime\diagnostics\cordis.patch.yml""
set "DSH_PERF_PATCH_ARG=--patch "%~dp0fork-runtime\web\perf.patch.yml""
set "DSH_MEMORY_PATCH_ARGS="
if exist "%DSH_HOME%\profiles\web\memory-limits.patch.yml" set DSH_MEMORY_PATCH_ARGS=--patch "%DSH_HOME%\profiles\web\memory-limits.patch.yml"

rem Set up the Host process: priority above normal-priority background work
rem (DSH_PROCESS_PRIORITY) and, on by default, a guard that keeps commands the
rem agent runs from terminating the Host (DSH_PROTECT_HOST=off disables it);
rem see fork-runtime\web\host-process.mjs.
set "DSH_HOST_PRELOAD=%~dp0fork-runtime\web\host-process.mjs"
set "DSH_HOST_PRELOAD=file:///%DSH_HOST_PRELOAD:\=/%"

set "DSH_BUILT_ENTRY=%~dp0apps\cli\lib\bin.js"
if defined DSH_CLI_ENTRY set "DSH_BUILT_ENTRY=%DSH_CLI_ENTRY%"
if not exist "%DSH_BUILT_ENTRY%" goto :source_launch

rem A complete build writes the client build record; without it the served Web
rem bundles may predate the current source. Warn only, never block startup.
if not defined DSH_CLI_ENTRY if not exist "%~dp0.dsh-build\client-build-environment.json" (
  echo.
  echo WARNING: No complete build record was found at .dsh-build\client-build-environment.json.
  echo WARNING: The Web client bundles may not match the current source; rerun build.cmd after source changes.
)

set "DSH_STEP=starting DeepSeek Harness"
node --expose-internals --import "%DSH_HOST_PRELOAD%" "%DSH_BUILT_ENTRY%" web %DSH_DIAGNOSTICS_PATCH_ARG% %DSH_MEMORY_PATCH_ARGS% %DSH_PERF_PATCH_ARG%
if errorlevel 1 goto :failed
exit /b 0

:source_launch
echo.
echo WARNING: Built Web entry "%DSH_BUILT_ENTRY%" is missing.
echo Run build.cmd to build the project; starting from TypeScript source through pnpm instead ^(slower startup^).
echo.
set "DSH_STEP=preparing pnpm"
call "%~dp0scripts\fork-windows-pnpm.cmd" --version
if errorlevel 1 goto :failed
set "DSH_STEP=starting DeepSeek Harness from source"
call "%~dp0scripts\fork-windows-pnpm.cmd" exec node --expose-internals --import "%DSH_HOST_PRELOAD%" --import tsx/esm "%~dp0apps\cli\src\bin.ts" web %DSH_DIAGNOSTICS_PATCH_ARG% %DSH_MEMORY_PATCH_ARGS% %DSH_PERF_PATCH_ARG%
if errorlevel 1 goto :failed
exit /b 0

:missing_node
echo.
echo ERROR: The Node.js version pinned in .node-version could not be prepared.
echo Check the network or set DSH_NODE_MIRROR to a reachable Node.js download mirror, then retry.
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
