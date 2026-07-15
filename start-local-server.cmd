@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  echo Starting DSP Tools with system Node.js...
  node server.js
  goto :end
)

set "CODEX_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%CODEX_NODE%" (
  echo Starting DSP Tools with Codex bundled Node.js...
  "%CODEX_NODE%" server.js
  goto :end
)

echo Node.js was not found.
echo Install Node.js 18+ or run this project from Codex runtime.

:end
echo.
echo Server stopped. Press any key to close this window.
pause >nul
