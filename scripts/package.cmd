@echo off
REM Build the Windows installer (NSIS) and portable executable.
REM Requires: npm install already completed.
echo [..] Building Windows packages (NSIS installer + portable)...
call npx electron-builder --win nsis portable --x64 || goto :fail
echo.
echo [ok] Done. Output in dist\:
dir /b dist\*.exe 2>nul
exit /b 0
:fail
echo [x] Build failed. If NSIS is unavailable, try: npx electron-builder --win dir --x64
exit /b 1
