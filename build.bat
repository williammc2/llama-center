@echo off
setlocal
cd /d %~dp0

echo [1/3] Building UI (pnpm build)...
call pnpm build || goto :err

echo [2/3] Packaging (PyInstaller onedir)...
backend\.venv\Scripts\python.exe -m PyInstaller llama-center.spec --noconfirm || goto :err

echo [3/3] Building installer (Inno Setup)...
set "ISCC="
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if "%ISCC%"=="" (
  echo WARNING: Inno Setup not found. Skipping installer.
  echo Install from: https://jrsoftware.org/isinfo.php
  goto :done
)
"%ISCC%" installer\llama-center.iss || goto :err

:done
echo.
echo Done:
echo   App:      dist\llama-center\llama-center.exe
echo   Installer: dist\llama-center-setup-0.2.6.exe
goto :eof

:err
echo Build failed.
exit /b 1
