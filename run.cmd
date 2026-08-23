@echo off
setlocal
cd /d "%~dp0"

set "DSH_COREPACK_SHIMS=%TEMP%\dsh-corepack-shims"
if not exist "%DSH_COREPACK_SHIMS%" mkdir "%DSH_COREPACK_SHIMS%"
if errorlevel 1 exit /b %errorlevel%

call corepack enable pnpm --install-directory "%DSH_COREPACK_SHIMS%"
if errorlevel 1 exit /b %errorlevel%
set "PATH=%DSH_COREPACK_SHIMS%;%PATH%"

call pnpm dsh web
exit /b %errorlevel%
