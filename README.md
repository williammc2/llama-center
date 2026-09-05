# llama-center

A cross-platform (Windows + Linux) desktop app that installs, configures, runs,
and keeps up-to-date **llama.cpp** (nightlies) and **llama-swap** for local LLM
inference. It owns the component paths end to end, so the user never edits raw
config files or hunts for binaries.

This file is the canonical project overview — read it first for context on what
the app is, how it works, and where things live.

## Features

- **llama-swap** — install, auto-update (stable releases), and rollback. Downloads
  the asset for the current OS/arch, verifies SHA-256, and swaps atomically
  (keeps the last 2 versions for rollback).
- **llama.cpp** — install/update/rollback from **nightlies** (no stable release
  exists; the app walks the release list for the highest `b####` build that has
  an asset matching the chosen OS + backend). The asset resolver lives in TS so
  the wizard can show "what will be downloaded" before downloading.
  - Windows CUDA ships as **two assets** (plain binaries + a cudart/cuBLAS DLLs
    zip); the resolver picks the plain build as primary and attaches the matching
    DLLs zip.
- **Models editor** — per-model fields (gguf, mmproj, draft, ctx, gpu-layers,
  threads, and structured flag groups: sampling, speculative decoding, flash
  attention, KV-cache dtype, batching, reasoning, image) rendered into
  `llama-swap.yaml`. The llama-server path is abstracted to the managed
  llama.cpp. Import an existing config (unknown flags preserved verbatim).
- **Server controls** — start/stop llama-swap, live terminal logs (ring buffer +
  rotating files), status via polling llama-swap's own HTTP API, dashboard link.
- **Tray + lifecycle** — system tray icon (generated at runtime), close-to-tray,
  start-with-system (opt-in), and auto-start the server with the app when the
  port is free.
- **App self-update** — checks the latest GitHub release of llama-center itself,
  compares versions, and downloads/launches the installer.
- **Installer** — Inno Setup per-user setup (no UAC), shortcuts + uninstaller.

## How it works

- **Bridge pattern** — all system access (fs, process spawn/kill, downloads,
  tray, autostart) goes through one `bridge` interface in TS. The UI is written
  against it and is unit-testable in the browser; the Python shell provides the
  real implementation. This keeps the UI and the shell swappable.
- **Two configs, on purpose** — app state lives in `config.json` (install dir,
  backend, port, toggles); llama-swap's own `llama-swap.yaml` is *generated* by
  the models editor. They never mix.
- **Per-user, no admin** — everything installs under the user's data dir
  (Windows `%LOCALAPPDATA%\llama-center`, Linux `~/.local/share/llama-center/`),
  so no UAC and no OneDrive-synced binaries.
- **Atomic updates** — download → verify → staging → swap, with the previous
  version parked in `backups/` (keep 2) and a one-click rollback.

## Stack

- **UI** — React 19 + TypeScript + Vite + Tailwind (built to static assets)
- **Shell** — pywebview (Python 3.11) — native window + system work
- **Tray** — pystray (icon generated at runtime)
- **Packaging** — PyInstaller (onedir) → `llama-center.exe` (Windows) / launcher (Linux)
- **Tests** — Vitest (UI + resolver) + pytest (Python backend)
- **CI** — GitHub Actions matrix (windows + ubuntu): test → package → release

Node is **build-time only** (compiles the UI). Python is the **runtime**
(PyInstaller bundles it into the final `.exe`). End users need neither.

## Install layout (per-user, no admin)

```
%LOCALAPPDATA%\llama-center\        (win)   ~/.local/share/llama-center/  (linux)
  llama-cpp\        current llama.cpp build (flat, executable ready)
  llama-swap\       current llama-swap + generated llama-swap.yaml
  backups\          last 2 versions per component (rollback)
  downloads\        staging area (download → verify → extract → move)
  logs\             rotated llama-swap stdout/stderr
  config.json       app state
```

## Development

Prereqs: **Node 20+** (with `pnpm`) and **Python 3.11** (the venv is pinned to
3.11 — see note below).

```bash
# one-time
pnpm install
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt   # Windows
#   backend/.venv/bin/pip install -r backend/requirements.txt                # Linux
```

Run (Windows — double-click, or from a terminal):

```
dev.bat          # Windows
./dev.sh         # Linux
```

The scripts rebuild the UI and launch the app with the **correct** interpreter
(`backend/.venv`). Prefer them over bare `python backend/main.py`, which can
resolve to a different interpreter (e.g. a 3.14 the `py` launcher auto-installs).

Run the tests:

```bash
pnpm test                 # UI + resolver (vitest)
backend/.venv/Scripts/python.exe -m pytest backend -q   # Python backend
#   backend/.venv/bin/python -m pytest backend -q       # Linux
```

## Packaging

```
build.bat        # Windows
./build.sh       # Linux
```

Builds the UI and runs PyInstaller (`llama-center.spec`) → onedir at
`dist\llama-center\llama-center.exe`. On Windows the CI additionally runs
Inno Setup to produce the installer (`llama-center-setup-<version>.exe`).
The app icon and tray icon are generated from the same code
(`backend/llama_center/icon.py`).

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
                   #   llamaSwapRelease.ts, llamaCppNightly.ts, appUpdate.ts,
                   #   flagGroups.ts
llama-center.spec  # PyInstaller spec (onedir)
installer/         # Inno Setup script (Windows installer)
build.bat/.sh      # UI build + packaging
dev.bat/.sh        # dev run (rebuild UI + launch)
.github/workflows/ # ci.yml (test + package + release)
```

## License

[MIT](LICENSE)
