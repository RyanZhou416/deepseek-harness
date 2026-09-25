@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "DSH_PNPM_VERSION="
for /f "delims=" %%V in ('node "%~dp0fork-windows-pnpm-version.mjs"') do set "DSH_PNPM_VERSION=%%V"
if not defined DSH_PNPM_VERSION exit /b 1

if not defined npm_config_registry set "npm_config_registry=https://registry.npmmirror.com"
if not defined npm_config_cache set "npm_config_cache=%TEMP%\dsh-npm-cache"
set "DSH_PNPM_HOME=%TEMP%\dsh-pnpm-%DSH_PNPM_VERSION%"
set "DSH_PNPM_ENTRY=%DSH_PNPM_HOME%\node_modules\pnpm\bin\pnpm.mjs"
set "DSH_PNPM_SHIM=%DSH_PNPM_HOME%\node_modules\.bin\pnpm.cmd"
call :verify
if not errorlevel 1 goto :run

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is required to install pnpm %DSH_PNPM_VERSION% without Corepack.
  exit /b 1
)
echo Preparing pnpm %DSH_PNPM_VERSION% in a private temporary directory...
call npm install --prefix "%DSH_PNPM_HOME%" --no-save --no-audit --no-fund "pnpm@%DSH_PNPM_VERSION%"
if errorlevel 1 (
  echo ERROR: Could not install pnpm %DSH_PNPM_VERSION%. Set npm_config_registry to another registry and retry.
  exit /b 1
)
call :verify
if errorlevel 1 (
  echo ERROR: Installed pnpm %DSH_PNPM_VERSION% is incomplete at "%DSH_PNPM_HOME%".
  exit /b 1
)

:run
set "PATH=%DSH_PNPM_HOME%\node_modules\.bin;%PATH%"
node "%DSH_PNPM_ENTRY%" %*
exit /b %errorlevel%

:verify
if not exist "%DSH_PNPM_ENTRY%" exit /b 1
if not exist "%DSH_PNPM_SHIM%" exit /b 1
set "DSH_ACTUAL_PNPM_VERSION="
for /f "delims=" %%V in ('node "%DSH_PNPM_ENTRY%" --version 2^>nul') do set "DSH_ACTUAL_PNPM_VERSION=%%V"
if not "%DSH_ACTUAL_PNPM_VERSION%"=="%DSH_PNPM_VERSION%" exit /b 1
set "DSH_ACTUAL_PNPM_SHIM_VERSION="
for /f "delims=" %%V in ('call "%DSH_PNPM_SHIM%" --version 2^>nul') do set "DSH_ACTUAL_PNPM_SHIM_VERSION=%%V"
if not "%DSH_ACTUAL_PNPM_SHIM_VERSION%"=="%DSH_PNPM_VERSION%" exit /b 1
exit /b 0
