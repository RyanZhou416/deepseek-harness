@echo off
setlocal
cd /d "%~dp0"

set "DSH_STEP=checking Node.js"
where node >nul 2>&1
if errorlevel 1 goto :missing_node

set "DSH_COREPACK_HOME=%TEMP%\dsh-corepack"
set "DSH_COREPACK_SHIMS=%TEMP%\dsh-corepack-shims"
if not defined COREPACK_HOME set "COREPACK_HOME=%TEMP%\dsh-corepack-cache"
if not defined COREPACK_NPM_REGISTRY set "COREPACK_NPM_REGISTRY=https://registry.npmmirror.com"
if not defined npm_config_registry set "npm_config_registry=%COREPACK_NPM_REGISTRY%"
if not defined npm_config_cache set "npm_config_cache=%TEMP%\dsh-npm-cache"

if not exist "%DSH_COREPACK_SHIMS%" mkdir "%DSH_COREPACK_SHIMS%"
if errorlevel 1 goto :failed

where corepack >nul 2>&1
if not errorlevel 1 goto :corepack_ready
if exist "%DSH_COREPACK_HOME%\node_modules\.bin\corepack.cmd" (
  set "PATH=%DSH_COREPACK_HOME%\node_modules\.bin;%PATH%"
  goto :corepack_ready
)

set "DSH_STEP=installing Corepack"
echo Corepack was not found. Installing it automatically...
call npm install --prefix "%DSH_COREPACK_HOME%" --no-save --no-audit --no-fund corepack@latest
if errorlevel 1 goto :failed
set "PATH=%DSH_COREPACK_HOME%\node_modules\.bin;%PATH%"

:corepack_ready
set "DSH_STEP=preparing pnpm"
call corepack enable pnpm --install-directory "%DSH_COREPACK_SHIMS%"
if errorlevel 1 goto :failed
set "PATH=%DSH_COREPACK_SHIMS%;%PATH%"

set "DSH_STEP=installing project dependencies"
call pnpm install
if errorlevel 1 goto :failed

set "DSH_STEP=building the project"
call pnpm run build
if errorlevel 1 goto :failed

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
