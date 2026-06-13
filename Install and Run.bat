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
REM  Options:  "Install and Run.bat" -Port 9000 -NoBrowser -NoStart
REM ============================================================================
setlocal
cd /d "%~dp0"
set "IMX_ROOT=%~dp0"

REM Guard against double-clicking this from INSIDE the ZIP preview (no extraction):
REM the windows\ folder won't be alongside the .bat, so nothing can run. Tell the
REM user to Extract All first.
if not exist "%~dp0windows\install.ps1" (
  echo.
  echo   This looks like it's running from inside the ZIP, or the download is incomplete.
  echo   windows\install.ps1 is missing next to this file.
  echo.
  echo   Fix: right-click the downloaded .zip -^> "Extract All...", then open the
  echo   extracted folder and double-click "Install and Run.bat" from there.
  echo.
  pause
  exit /b 1
)

REM Map optional flags onto environment variables. install.ps1 reads these
REM instead of using a param() block, because it is launched via
REM Invoke-Expression (see below), where param() is not available.
:parseargs
if "%~1"==""              goto endargs
if /i "%~1"=="-Port"      ( set "IMX_PORT=%~2" & shift & shift & goto parseargs )
if /i "%~1"=="-NoBrowser" ( set "IMX_NOBROWSER=1" & shift & goto parseargs )
if /i "%~1"=="-NoStart"   ( set "IMX_NOSTART=1" & shift & goto parseargs )
shift
goto parseargs
:endargs

REM Run the script by piping its text through Invoke-Expression rather than with
REM -File. A downloaded install.ps1 is unsigned, and under an AllSigned /
REM RemoteSigned execution policy (common on managed machines) an unsigned .ps1
REM is blocked - and when that policy is set by Group Policy, -ExecutionPolicy
REM Bypass is ignored. IEX'd content is not a "script file", so it runs anyway.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Raw -LiteralPath ($env:IMX_ROOT + 'windows\install.ps1') | Invoke-Expression"
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo Setup or server exited with code %EXITCODE%.
  echo If this was unexpected, review the messages above.
  echo.
  pause
)

endlocal
