#requires -Version 5.1
<#
  Intercom Matrix - one-click Windows setup + launcher.

  Bootstraps everything a clean Windows machine needs, then starts the app:
    1. Node.js 24+  - downloaded as a PORTABLE copy into .node\ (no admin,
                      no system change) if a suitable Node isn't already present.
    2. VC++ runtime - the bundled pdftotext.exe (PDF config-print parsing) needs
                      the Microsoft Visual C++ runtime; installed if missing
                      (this step may prompt for admin / UAC).
    3. npm deps     - express, ws, exceljs, ... via `npm ci` (needs internet).
    4. Launch       - starts server.js and opens the browser.

  Re-running is safe and idempotent: existing Node and up-to-date dependencies
  are reused, so day-to-day this doubles as the launcher.

  Launched by "Install and Run.bat", which pipes this file through
  Invoke-Expression rather than running it as a .ps1. That matters: a downloaded
  script is unsigned, and under an AllSigned/RemoteSigned execution policy - the
  default on many managed Windows machines - an unsigned .ps1 is blocked. When
  the policy is set by Group Policy, even `-ExecutionPolicy Bypass` is ignored.
  IEX'd content is not a "script file", so it runs regardless of policy.

  Two consequences of being run via IEX (instead of as a file):
    - there is no $MyInvocation file path, so the project root comes from
      $env:IMX_ROOT (set by the .bat), with fallbacks for direct invocation;
    - a param() block isn't valid, so options are read from environment
      variables (the .bat maps -Port / -NoBrowser / -NoStart onto these).
#>

$ErrorActionPreference = 'Stop'
# Some older Windows builds default to TLS 1.0; force modern TLS for the downloads.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# Honor an authenticated corporate proxy (common on managed networks). Invoke-
# WebRequest uses the system proxy but won't send credentials to an authenticating
# one by default; wire in default creds, and hand the same proxy to npm via the
# env vars it reads. All best-effort: a box with no proxy is unaffected.
try {
  $sysProxy = [System.Net.WebRequest]::GetSystemWebProxy()
  $sysProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
  [System.Net.WebRequest]::DefaultWebProxy = $sysProxy
  $PSDefaultParameterValues['Invoke-WebRequest:ProxyUseDefaultCredentials'] = $true
  $PSDefaultParameterValues['Invoke-RestMethod:ProxyUseDefaultCredentials'] = $true
  $npmProxy = $sysProxy.GetProxy('https://registry.npmjs.org/')
  if ($npmProxy -and $npmProxy.Host -ne 'registry.npmjs.org') {
    if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $npmProxy.AbsoluteUri }
    if (-not $env:HTTP_PROXY)  { $env:HTTP_PROXY  = $npmProxy.AbsoluteUri }
  }
} catch { }

# Options (env vars; "Install and Run.bat" maps its flags onto these).
$Port      = if ($env:IMX_PORT) { [int]$env:IMX_PORT } elseif ($env:PORT) { [int]$env:PORT } else { 8080 }
$NoBrowser = ($env:IMX_NOBROWSER -eq '1')
$NoStart   = ($env:IMX_NOSTART -eq '1')

# Project root: from the .bat, else infer it when the file is invoked directly.
if     ($env:IMX_ROOT)  { $Root = $env:IMX_ROOT.TrimEnd('\') }
elseif ($PSScriptRoot)  { $Root = Split-Path -Parent $PSScriptRoot }
elseif ($PSCommandPath) { $Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
else                    { $Root = (Get-Location).Path }
Set-Location $Root

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host ""; Write-Host "  ERROR: $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Intercom Matrix - Windows setup" -ForegroundColor White
Write-Host "  ===============================" -ForegroundColor DarkGray

$MinNodeMajor = 24
$LocalNodeDir = Join-Path $Root ".node"

function Get-NodeMajor($exe) {
  try { $v = (& $exe -v) 2>$null; if ($v -match 'v(\d+)\.') { return [int]$Matches[1] } } catch {}
  return 0
}

# --- Step 1: ensure Node.js >= MinNodeMajor -----------------------------------
Info "[1/4] Checking for Node.js $MinNodeMajor+ ..."
$NodeExe = $null

$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode -and (Get-NodeMajor $pathNode.Source) -ge $MinNodeMajor) {
  $NodeExe = $pathNode.Source
  Ok "Found Node $(& $NodeExe -v) on PATH."
}

if (-not $NodeExe) {
  $cand = Join-Path $LocalNodeDir "node.exe"
  if ((Test-Path $cand) -and (Get-NodeMajor $cand) -ge $MinNodeMajor) {
    $NodeExe = $cand
    Ok "Using portable Node $(& $NodeExe -v) from .node\."
  }
}

if (-not $NodeExe) {
  Info "No suitable Node found - downloading a portable copy (no admin needed)..."
  try {
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
  } catch {
    Die "Couldn't reach nodejs.org to download Node. Check your internet connection (or install Node $MinNodeMajor+ manually, then re-run)."
  }
  # Eligible = any release at or above our minimum major. Prefer the newest
  # LTS line (more stable for a production box); fall back to the newest of
  # anything eligible if no LTS qualifies yet.
  $eligible = $index | Where-Object { [int]($_.version.TrimStart('v').Split('.')[0]) -ge $MinNodeMajor }
  $pick = $eligible | Where-Object { $_.lts } |
            Sort-Object { [version]($_.version.TrimStart('v')) } -Descending |
            Select-Object -First 1
  if (-not $pick) {
    $pick = $eligible | Sort-Object { [version]($_.version.TrimStart('v')) } -Descending | Select-Object -First 1
  }
  if (-not $pick) { Die "No Node $MinNodeMajor+ release found on nodejs.org." }

  $ver = $pick.version
  $arch = "x64"
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
  elseif (-not [Environment]::Is64BitOperatingSystem) {
    Die "This is 32-bit Windows, for which Node.js $MinNodeMajor+ ships no build. Use a 64-bit Windows machine, or install Node $MinNodeMajor+ manually and re-run."
  }

  $zipName = "node-$ver-win-$arch.zip"
  $url     = "https://nodejs.org/dist/$ver/$zipName"
  $zipPath = Join-Path $env:TEMP $zipName
  $tmp     = Join-Path $Root ".node-tmp"

  try {
    Info "Downloading $zipName ..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    Info "Extracting ..."
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $inner) { throw "the downloaded archive was empty or corrupt" }
    if (Test-Path $LocalNodeDir) { Remove-Item $LocalNodeDir -Recurse -Force }
    Move-Item $inner.FullName $LocalNodeDir
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  } catch {
    Die "Couldn't download or unpack Node from nodejs.org ($($_.Exception.Message)). On a managed network this usually means a proxy or firewall is blocking nodejs.org - ask IT to allow it, or install Node $MinNodeMajor+ manually and re-run."
  }

  $NodeExe = Join-Path $LocalNodeDir "node.exe"
  if (-not (Test-Path $NodeExe)) { Die "Node download failed - node.exe missing after extract." }
  Ok "Installed portable Node $(& $NodeExe -v) into .node\."
}

# Make this Node (and its bundled npm) take precedence for the rest of the run.
$NodeDir   = Split-Path -Parent $NodeExe
$env:PATH  = "$NodeDir;$env:PATH"
$Npm       = Join-Path $NodeDir "npm.cmd"

# --- Step 2: ensure the VC++ runtime so bundled pdftotext can launch ----------
Info "[2/4] Checking the bundled PDF tool (pdftotext)..."
$Pdftotext = Join-Path $Root "vendor\poppler\win-x64\pdftotext.exe"
$PdfReady  = $false   # true only when pdftotext can actually run (VC++ present)

function Test-VCRedist {
  foreach ($k in @(
    "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
  )) {
    try { if ((Get-ItemProperty $k -ErrorAction Stop).Installed -eq 1) { return $true } } catch {}
  }
  return $false
}

if (-not (Test-Path $Pdftotext)) {
  Warn "Bundled pdftotext not found under vendor\poppler\win-x64."
  Warn "PDF config-print parsing will be unavailable; the app still runs (upload pre-extracted .txt prints)."
}
elseif (Test-VCRedist) {
  $PdfReady = $true
  Ok "PDF tool ready (Visual C++ runtime present)."
}
else {
  Warn "Visual C++ runtime missing - the bundled PDF tool needs it."
  try {
    $vc = Join-Path $env:TEMP "vc_redist.x64.exe"
    Info "Downloading the VC++ runtime (one-time)..."
    Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vc -UseBasicParsing
    Info "Installing the VC++ runtime (may prompt for admin)..."
    Start-Process -FilePath $vc -ArgumentList "/install","/quiet","/norestart" -Wait -Verb RunAs | Out-Null
    if (Test-VCRedist) { $PdfReady = $true; Ok "Visual C++ runtime installed." }
    else { Warn "VC++ runtime not confirmed - PDF parsing stays off, but everything else works (.txt prints)." }
  } catch {
    Warn "Couldn't install the VC++ runtime automatically (admin declined, or no rights)."
    Warn "The app still runs; PDF config-print parsing stays off until it's installed. See windows\README.md."
  }
}

# --- Step 3: install app dependencies -----------------------------------------
Info "[3/4] Installing app dependencies (npm)..."
$lock   = Join-Path $Root "package-lock.json"
$nmDir  = Join-Path $Root "node_modules"
$fresh  = $false
if (Test-Path $nmDir) {
  if ((-not (Test-Path $lock)) -or ((Get-Item $nmDir).LastWriteTime -ge (Get-Item $lock).LastWriteTime)) {
    $fresh = $true
  }
}

if ($fresh) {
  Ok "Dependencies already up to date."
} else {
  if (Test-Path $lock) {
    & $Npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { Warn "npm ci failed - falling back to npm install..."; & $Npm install --omit=dev }
  } else {
    & $Npm install --omit=dev
  }
  if ($LASTEXITCODE -ne 0) { Die "npm install failed - check your internet connection and re-run." }
  Ok "Dependencies installed."
}

# --- Step 4: launch -----------------------------------------------------------
# Make PDF capability unmissable: it's the one thing that silently won't work if
# the VC++ runtime didn't get installed (declined UAC / no admin rights).
Write-Host ""
if ($PdfReady) {
  Ok   "PDF config-print upload: ENABLED (Visual C++ runtime present)."
} else {
  Warn "PDF config-print upload: DISABLED - the Visual C++ runtime is not installed."
  Warn "  To enable PDFs: install https://aka.ms/vs/17/release/vc_redist.x64.exe then re-run."
  Warn "  The app works now; until then, upload pre-extracted .txt prints instead of PDFs."
}

if ($NoStart) {
  Write-Host ""
  Ok "Setup complete. Double-click 'Install and Run.bat' again any time to start the server."
  exit 0
}

$env:PORT = "$Port"
$url = "http://localhost:$Port"
Write-Host ""
Info "[4/4] Starting Intercom Matrix ..."
Ok   "Open in your browser:  $url"
Write-Host "  (Close this window or press Ctrl-C to stop the server.)" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
  # Poll the liveness endpoint, then open the browser once the server answers.
  Start-Job -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 60; $i++) {
      try { Invoke-WebRequest "$u/api/systems" -UseBasicParsing -TimeoutSec 2 | Out-Null; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
    Start-Process $u
  } -ArgumentList $url | Out-Null
}

& $NodeExe (Join-Path $Root "server.js")
