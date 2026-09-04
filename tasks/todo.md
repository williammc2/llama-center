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

## P3 — Run + logs + status (owner: @builder)
- [ ] Spawn llama-swap (piped stdio, CREATE_NO_WINDOW on win)
- [ ] Terminal log view (ring buffer) + rotating files
- [ ] Status panel via API polling (2s)
- [ ] No orphan process on app exit

## P4 — Config editor (owner: @builder)
- [ ] `llama-swap.json` editor: validation, field errors, apply/reload

## P5 — Settings + tray (owner: @builder)
- [ ] Settings: port, language, auto-start (app / llama-swap), check-on-start, close-to-tray, sycl precision (fp16/fp32)
- [ ] Tray icon + menu; autostart entries (HKCU Run / XDG desktop file)
- [ ] Onboarding polish

## P6 — Packaging + release (owner: @releaser)
- [ ] PyInstaller onedir (win) + linux launcher; clean-VM install test
- [ ] App self-update: manual check + redownload (auto-update deferred)
- [ ] CI matrix win/ubuntu; README + user docs (EN)
