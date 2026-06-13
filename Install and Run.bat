@echo off
REM ============================================================================
REM  Intercom Matrix - one-click Windows setup + launcher.
REM
REM  Double-click this file. It will:
REM    1. Download a portable Node.js 24+ if you don't already have one
REM       (no admin needed, installed into a local .node\ folder).
REM    2. Make sure the Visual C++ runtime is present (for the bundled PDF tool).
REM    3. Install the app's dependencies (needs internet, one time).
REM    4. Start the server and open http://localhost:8080 in your browser.
REM
REM  Run it again any time to start the server - already-installed bits are reused.
REM  Serve on another port:   "Install and Run.bat" -Port 9000
REM ============================================================================
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo Setup or server exited with code %EXITCODE%.
  echo If this was unexpected, review the messages above.
  echo.
  pause
)

endlocal
