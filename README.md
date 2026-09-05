# llama-center

A cross-platform (Windows + Linux) desktop app that installs, configures, runs,
and keeps up-to-date **llama.cpp** (nightlies) and **llama-swap** for local LLM
inference.

- Installs + auto-updates **llama-swap** (stable releases) and **llama.cpp** (nightlies)
- **Models** editor: per-model fields (gguf, mmproj, draft, ctx, gpu-layers, extra
  flags) rendered into `llama-swap.yaml` — the llama-server path is abstracted to the
  managed llama.cpp. Import existing configs (unknown flags preserved).
- **Server** controls: start/stop, live logs, status, dashboard link
- Tray icon, close-to-tray, autostart, auto-start the server with the app

## Stack

- **UI** — React 19 + TypeScript + Vite + Tailwind (built to static assets)
- **Shell** — pywebview (Python 3.11) — native window + system work
- **Tray** — pystray (icon generated at runtime)
- **Packaging** — PyInstaller (onedir) → `llama-center.exe` (Windows) / launcher (Linux)

Node is **build-time only** (compiles the UI). Python is the **runtime**
(PyInstaller bundles it into the final `.exe`). End users need neither.

## Development

Prereqs: **Node 20+** (with `pnpm`) and **Python 3.11** (3.12 may work; the
venv is pinned to 3.11 — see note below).

```bash
# one-time
pnpm install
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt   # Windows
#   backend/.venv/bin/pip install -r backend/requirements.txt                # Linux
```

Run (Windows — double-click, or from a terminal):

```
dev.bat
```

`dev.bat` rebuilds the UI and launches the app with the **correct** interpreter
(`backend\.venv`). Prefer it over bare `python backend/main.py`, which can
resolve to a different interpreter (e.g. a 3.14 the `py` launcher auto-installs).

Run the tests:

```bash
pnpm test                 # UI + resolver (vitest)
backend/.venv/Scripts/python.exe -m pytest backend -q   # Python backend
```

## Packaging

```
build.bat
```

Builds the UI and runs PyInstaller (`llama-center.spec`) → onedir at
`dist\llama-center\llama-center.exe`. Ship that whole folder (no installer,
per-user — just copy it anywhere). The app icon and tray icon are generated
from the same code (`backend/llama_center/icon.py`).

### Python version note

The canonical venv is **3.11**. If your system `python` points elsewhere,
recreate the venv explicitly:

```bash
py -3.11 -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
```

## Layout

```
backend/           # Python: config, detection, updater, process, tray, autostart (pytest-tested)
  llama_center/    #   package: config.py, detect.py, updater.py, process.py,
                   #           swapconfig.py, autostart.py, icon.py
  main.py          #   pywebview entry point
src/               # React UI
  components/      #   Wizard, Shell (sidebar)
  pages/           #   ServerPage, ModelsPage, CppPage, SettingsPage
  lib/             #   bridge.ts, config.ts, detect.ts, assetResolver.ts,
                   #   llamaSwapRelease.ts, llamaCppNightly.ts
llama-center.spec  # PyInstaller spec (onedir)
build.bat          # UI build + packaging
PLAN.md            # plan + status
tasks/todo.md      # task list
```
