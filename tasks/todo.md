# Llama Center — Tasks

## P0 — Scaffold + wizard (owner: @builder) ✅ DONE
- [x] Scaffold: Vite + React 19 + TS + Tailwind 4 (pywebview shell lands with P1/P3)
- [x] i18n setup: EN (default) + PT-BR, toggle stub in Settings
- [x] `config.ts` (schema + validate/coerce) + `detect.ts` — fully unit-tested
- [x] Wizard: OS/arch detect, backend matrix, CUDA major+family, install dir, port, language
- [x] Wizard writes `config.json` (browser stub shows JSON; real fs write via Python bridge)
- [x] Tests: 46 green (config, detect, resolver, wizard)

## P1 — llama-swap install/update (owner: @builder, review: @reviewer) ✅ DONE
- [x] Python bridge: `backend/bridge.py` + pywebview shell (`backend/main.py`) — native window, real config writes (`3d807b7`)
- [x] pytest suite for bridge: 35 green (config rules, round-trips, corrupt files, OS matrix)
- [x] GitHub `releases/latest` client (mock-server tested) — `src/lib/llamaSwapRelease.ts`, real v253 fixtures
- [x] Asset selection by OS+arch + checksum verification — `pickAsset` + SHA-256 from API digest (checksums.txt parsed as cross-check)
- [x] Atomic update: download → verify → staging → swap (keep 2 backups) — `backend/llama_center/updater.py`
- [x] Rollback button — `rollback()` parks the failed install (`.failed`), Home shows Rollback when backups exist
- [x] Existing-process detection (port probe → Adopt / Stop & Take Over / Cancel) — `probe_port`/`stop_llama_swap` + conflict dialog in Home
- [x] Installed version tracked in config (`llamaSwapInstalled`), persisted after swap/rollback

## P2 — llama.cpp resolver + install (owner: @builder, review: @reviewer) ✅ DONE
- [x] Nightly resolver (TS, `src/lib/assetResolver.ts`) — 27 tests vs real b10814 fixture
- [x] Nightly discovery: highest `b####` with matching `{os}-{backend}` asset (calls resolver) — `src/lib/llamaCppNightly.ts`, real b10816/b10814 fixtures + mock server
- [x] Install/update/rollback (same atomic flow as P1) — updater.py generalized per component; Home llama.cpp card; `llamaCppInstalled` in config

## P3 — Run + logs + status (owner: @builder) ✅ DONE
- [x] Spawn llama-swap (piped stdio, CREATE_NO_WINDOW on win) — `backend/llama_center/process.py`, tested with a stand-in command
- [x] Terminal log view (ring buffer 2000) + rotating files (5 MB × 3, `logs/llama-swap.log`)
- [x] Status panel via API polling (2s) — `/health` + `/running` (model list), managed vs external detection
- [x] No orphan process on app exit — atexit hook stops the managed process
- [x] UI: Start/Stop buttons, log terminal, start conflict dialog (Stop & start / Adopt / Cancel), exit code surfaced on Stop

## P4 — Models config (owner: @builder) ✅ DONE
- [x] `swapconfig.py`: models → `cmd` → `llama-swap.yaml`; llama-server path abstracted to the managed llama.cpp
- [x] Parse/import of existing configs (unknown flags preserved in `extra_flags`) — user's real config.yaml is a test fixture
- [x] Api: `save/get/import_llama_swap_config`; start uses `--config`, errors "no-config" when empty
- [x] Home "llama-swap models" card: per-model fields, validation (field errors before save), import from file

## UI — Sidebar shell (owner: @builder) ✅ DONE
- [x] `Shell.tsx`: fixed sidebar (Server / Models / llama.cpp / Settings), one page at a time, window no longer scrolls
- [x] Pages: `src/pages/ServerPage.tsx`, `ModelsPage.tsx`, `CppPage.tsx`, `SettingsPage.tsx` (port, install dir, toggles, "Change setup")
- [x] Status dot in the sidebar (green=healthy, amber=busy, off=stopped); Home.tsx deleted

## P5 — Settings + tray (owner: @builder) ✅ DONE
- [x] Settings page: port, install dir, check-on-start, auto-start llama-swap, close-to-tray, start-with-system, backend display + wizard
- [x] Tray icon (pystray, runtime-generated) + menu: Show / Start / Stop / Check updates / Quit
- [x] Close-to-tray (closing_event → hide); `--minimized` flag for login starts
- [x] Autostart: HKCU Run (win) / XDG .desktop (linux), applied on save_config
- [x] autoStartLlamaSwap: server starts with the app when the port is free
- [ ] Onboarding polish

## P6 — Packaging + release (owner: @builder) ✅ DONE
- [x] `llama-center.spec` (onedir): UI as data (`sys._MEIPASS`), hidden imports (pywebview backends, pystray), icon from icon.py
- [x] `build.bat` → `dist\llama-center\llama-center.exe` (verified: window + WebView2 child)
- [x] CI matrix win/ubuntu (test + package + artifact)
- [x] README updated (features, packaging, layout)
- [ ] App self-update: manual check + redownload (auto-update deferred)
