#!/usr/bin/env bash
# Dev launcher (Linux) — the dev.sh twin of dev.bat.
# Rebuilds the UI and launches the app with the venv interpreter.
set -e
cd "$(dirname "$0")"

echo "[1/2] Building UI (pnpm build)..."
pnpm build

echo "[2/2] Starting llama-center (backend/.venv)..."
exec backend/.venv/bin/python backend/main.py "$@"
