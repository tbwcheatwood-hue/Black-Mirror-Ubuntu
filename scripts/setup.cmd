@echo off
REM Black Mirror - one-click setup (development / source install)
REM Does not modify system configuration. Isolated to the project folder.
where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found. Install Node.js 18+ from https://nodejs.org
  pause
  exit /b 1
)
echo [..] Installing dependencies...
call npm install --no-audit --no-fund || goto :fail
echo [..] Vendoring renderer bundles...
call node scripts\vendor-renderer-deps.js
echo [ok] Setup complete. Starting Black Mirror...
call npm start
exit /b 0
:fail
echo [x] Setup failed - see messages above.
pause
exit /b 1
