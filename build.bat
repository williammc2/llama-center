@echo off
setlocal
cd /d %~dp0

echo [1/2] Building UI (pnpm build)...
call pnpm build || goto :err

echo [2/2] Packaging (PyInstaller onedir)...
backend\.venv\Scripts\python.exe -m PyInstaller llama-center.spec --noconfirm || goto :err

echo.
echo Done: dist\llama-center\llama-center.exe
goto :eof

:err
echo Build failed.
exit /b 1
