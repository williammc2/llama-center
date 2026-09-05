#!/usr/bin/env bash
# Packaging launcher (Linux) — the dev.sh twin of build.bat.
# Builds the UI and runs PyInstaller -> dist/llama-center/llama-center (onedir).
set -e
cd "$(dirname "$0")"

echo "[1/2] Building UI (pnpm build)..."
pnpm build

echo "[2/2] Packaging (PyInstaller onedir)..."
backend/.venv/bin/python -m PyInstaller llama-center.spec --noconfirm

echo
echo "Done: dist/llama-center/llama-center"
