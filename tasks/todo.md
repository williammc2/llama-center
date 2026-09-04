# Llama Center — Tasks

## P0 — Scaffold + wizard (owner: @builder)
- [ ] Scaffold: Tauri v2 + Vite + React 19 + TS + Tailwind + shadcn/ui
- [ ] i18n setup: EN (default) + PT-BR, toggle stub in Settings
- [ ] Rust: `config.json` schema (serde) + read/write + migration hook
- [ ] Wizard step 1: detect OS/arch; `nvidia-smi` probe → suggest CUDA 12/13
- [ ] Wizard step 2: backend choice (CUDA 13 / CUDA 12 / Vulkan / CPU)
- [ ] Wizard step 3: install dir (default per-OS, editable)
- [ ] Wizard writes `config.json`, sets `firstRunDone`
- [ ] Tests: config round-trip (Rust), wizard component (Vitest)

## P1 — llama-swap install/update (owner: @builder, review: @reviewer)
- [ ] GitHub `releases/latest` client (wiremock-tested)
- [ ] Asset selection by OS+arch + checksum verification
- [ ] Atomic update: download → verify → staging → swap (keep 2 backups)
- [ ] Rollback button
- [ ] Existing-process detection (port probe → Adopt / Stop & Take Over / Cancel)

## P2 — llama.cpp resolver + install (owner: @builder, review: @reviewer)
- [ ] Nightly resolver: highest `b####` with matching `{os}-{backend}` asset
- [ ] Table-driven unit tests ≥ 12 (os, backend, arch) combos
- [ ] Install/update/rollback (same atomic flow as P1)

## P3 — Run + logs + status (owner: @builder)
- [ ] Spawn llama-swap (piped stdio, CREATE_NO_WINDOW on win)
- [ ] Terminal log view (ring buffer) + rotating files
- [ ] Status panel via API polling (2s)
- [ ] No orphan process on app exit

## P4 — Config editor (owner: @builder)
- [ ] `llama-swap.json` editor: validation, field errors, apply/reload

## P5 — Settings + tray (owner: @builder)
- [ ] Settings: port, language, auto-start (app / llama-swap), check-on-start, close-to-tray
- [ ] Tray icon + menu; autostart entries (HKCU Run / XDG desktop file)
- [ ] Onboarding polish

## P6 — Packaging + release (owner: @releaser)
- [ ] NSIS installer (per-user) + AppImage
- [ ] tauri-plugin-updater + release workflow
- [ ] CI matrix win/ubuntu; clean-VM install test
- [ ] README + user docs (EN)
