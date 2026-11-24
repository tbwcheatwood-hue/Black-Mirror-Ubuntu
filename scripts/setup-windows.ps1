# ============================================================
#  Black Mirror - Windows setup script
#  Prepares a development or source installation:
#    1. verifies Node.js >= 18
#    2. installs npm dependencies (Electron + builder + renderer libs)
#    3. vendors renderer bundles (markdown / syntax highlighting)
#    4. runs the automated test suite (optional with -SkipTests)
#
#  The script does NOT modify system settings, existing inference
#  installations, or model directories. Everything Black Mirror
#  installs later lives under %APPDATA%\BlackMirror.
# ============================================================
[CmdletBinding()]
param(
  [switch]$SkipTests,
  [switch]$StartAfterSetup
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host ""
Write-Host "BLACK MIRROR - setup" -ForegroundColor Magenta
Write-Host "=====================" -ForegroundColor DarkGray

# ---- 1. Node.js -------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[x] Node.js was not found." -ForegroundColor Red
  Write-Host "    Install Node.js 18 or newer from https://nodejs.org and re-run this script."
  exit 1
}
$nodeVersion = (node --version) -replace 'v','' | ForEach-Object { [version]($_ -replace '\..*$','') + '.0.0' }
if ($nodeVersion.Major -lt 18) {
  Write-Host "[x] Node.js $(node --version) is too old. Black Mirror needs >= 18." -ForegroundColor Red
  exit 1
}
Write-Host "[ok] Node.js $(node --version)" -ForegroundColor Green
Write-Host "[ok] npm $(npm --version)" -ForegroundColor Green

# ---- 2. dependencies --------------------------------------------
Write-Host "[..] installing npm dependencies (first run downloads Electron, ~100 MB)..." -ForegroundColor Yellow
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "[x] npm install failed" -ForegroundColor Red; exit 1 }
Write-Host "[ok] dependencies installed" -ForegroundColor Green

# ---- 3. renderer vendor bundles ---------------------------------
Write-Host "[..] vendoring renderer bundles..." -ForegroundColor Yellow
node scripts/vendor-renderer-deps.js
Write-Host "[ok] renderer bundles ready" -ForegroundColor Green

# ---- 4. tests ----------------------------------------------------
if (-not $SkipTests) {
  Write-Host "[..] running automated test suite..." -ForegroundColor Yellow
  node --test tests/
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[x] tests failed - see output above" -ForegroundColor Red
    exit 1
  }
  Write-Host "[ok] test suite passed" -ForegroundColor Green
}

# ---- 5. first-run hints ------------------------------------------
Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  - npm start               launch the app"
Write-Host "  - npm run build:win       build the Windows installer + portable exe"
Write-Host "  - In the app: Inference Engines -> Install to fetch llama.cpp builds"
Write-Host "  - Model Library -> Add scan directory to index your existing GGUF files"
Write-Host ""
Write-Host "User data lives in %APPDATA%\BlackMirror (config, library index, conversations,"
Write-Host "installed engines, logs). Your model files are only indexed, never modified."

if ($StartAfterSetup) {
  npm start
}
