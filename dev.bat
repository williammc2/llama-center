@echo off
rem llama-center dev launcher — rebuild UI + open the native window.
rem Use THIS instead of bare `python`, which may resolve to a different
rem interpreter (e.g. the 3.14 the py launcher auto-installs).
setlocal
cd /d "%~dp0"

echo [1/2] Building UI (pnpm build)...
call pnpm build
if errorlevel 1 (
  echo Build failed — check the output above.
  exit /b 1
)

echo [2/2] Starting llama-center (backend\.venv, Python 3.11)...
backend\.venv\Scripts\python.exe backend\main.py
endlocal
