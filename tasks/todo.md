# Llama Center — Tasks

## P0 — Scaffold + wizard (owner: @builder) ✅ DONE
- [x] Scaffold: Vite + React 19 + TS + Tailwind 4 (pywebview shell lands with P1/P3)
- [x] i18n setup: EN (default) + PT-BR, toggle stub in Settings
- [x] `config.ts` (schema + validate/coerce) + `detect.ts` — fully unit-tested
- [x] Wizard: OS/arch detect, backend matrix, CUDA major+family, install dir, port, language
- [x] Wizard writes `config.json` (browser stub shows JSON; real fs write via Python bridge)
- [x] Tests: 46 green (config, detect, resolver, wizard)

## P1 — llama-swap install/update (owner: @builder, review: @reviewer)
- [ ] GitHub `releases/latest` client (mock-server tested)
- [ ] Asset selection by OS+arch + checksum verification
- [ ] Atomic update: download → verify → staging → swap (keep 2 backups)
- [ ] Rollback button
- [ ] Existing-process detection (port probe → Adopt / Stop & Take Over / Cancel)
- [ ] Python bridge: `backend/bridge.py` (5 fns: config read/write, spawn/stop/pipe, download+sha256, tray) + pywebview shell (`backend/main.py`) — app runs as a real window
- [ ] pytest suite for bridge (config round-trip, download+sha256 with local server)

## P2 — llama.cpp resolver + install (owner: @builder, review: @reviewer)
- [x] Nightly resolver (TS, `src/lib/assetResolver.ts`) — 27 tests vs real b10814 fixture
- [ ] Nightly discovery: highest `b####` with matching `{os}-{backend}` asset (calls resolver)
- [ ] Install/update/rollback (same atomic flow as P1)

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
