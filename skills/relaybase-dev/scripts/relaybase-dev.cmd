@echo off
setlocal

set "RELAYBASE_DEV_SCRIPT=%~dp0relaybase-dev.ps1"

if not exist "%RELAYBASE_DEV_SCRIPT%" (
  echo Relaybase helper script not found: "%RELAYBASE_DEV_SCRIPT%" 1>&2
  endlocal
  exit /b 1
)

where powershell.exe >nul 2>nul
if not errorlevel 1 (
  set "RELAYBASE_DEV_POWERSHELL=powershell.exe"
) else (
  where pwsh.exe >nul 2>nul
  if errorlevel 1 (
    echo Relaybase helper requires powershell.exe or pwsh.exe. 1>&2
    endlocal
    exit /b 1
  )
  set "RELAYBASE_DEV_POWERSHELL=pwsh.exe"
)

"%RELAYBASE_DEV_POWERSHELL%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%RELAYBASE_DEV_SCRIPT%" %*
set "RELAYBASE_DEV_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %RELAYBASE_DEV_EXIT_CODE%
