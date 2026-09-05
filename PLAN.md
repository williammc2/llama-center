# Llama Center — Plan

A cross-platform (Windows + Linux) desktop app that installs, configures, runs, and keeps
up-to-date **llama.cpp** (nightlies) and **llama-swap** for local LLM inference.

Status: P0 done. Owner: @architect (plan) / @builder (code).

## 0. Status (keep this updated — what's done vs. what's next)

| Phase | State | Notes |
|---|---|---|
| P0 wizard + config + resolver | ✅ DONE | React 19 + Tailwind 4, 46 tests green, user verified wizard in browser |
| Stack switch to pywebview/Python | ✅ DONE | `6aff54c`; deps installed (pywebview, pystray, pyinstaller 6.22.2) |
| P1 llama-swap install/update | ✅ DONE + USER-VERIFIED | bridge+shell (`3d807b7`); release client TS (`llamaSwapRelease.ts`, real v253 fixtures + mock server); updater.py (download→sha256→staging→swap, keep 2 backups, rollback, port probe, stop-by-name); Home UI with update/rollback/conflict dialog. vitest 66 + pytest 61 green. Verified in native window: real v253 install to `%LOCALAPPDATA%\llama-center`, port-conflict dialog worked |
| P2 llama.cpp install | ✅ DONE | `llamaCppNightly.ts` (releases-list walk newest→oldest, real b10816/b10814 fixtures, hardMajor from wizard choice); updater generalized per-component (`staging-<component>`, backup prefix); Home llama.cpp card (check/install/update/rollback, size shown). vitest 76 + pytest 63 green |
| P3 run/logs/status | ✅ DONE | `process.py` (spawn piped stdio, CREATE_NO_WINDOW, ring buffer 2000 + rotating file 5MB×3, terminate→kill); Api start/stop/status/logs (`/health` + `/running` model list); Home: Start/Stop, 2s status poll (managed/external/stopped + models), log terminal, start conflict dialog, atexit anti-orphan. vitest 82 + pytest 76 green |
| P4 models config | ✅ DONE | `swapconfig.py` (models → `cmd` → `llama-swap.yaml`, llama-server path abstracted to the managed llama.cpp; parse/import of existing configs preserves unknown flags in `extra_flags`); Api save/get/import; Home "llama-swap models" card (per-model fields + validation + import from file); start uses `--config` and errors "no-config" clearly. vitest 82 + pytest 96 green |
| UI: sidebar shell (Server/Models/llama.cpp/Settings) | ✅ DONE + USER-VERIFIED | `Shell.tsx` (fixed sidebar + one page at a time, no window scrollbar; status dot on Server); pages in `src/pages/` (ServerPage, ModelsPage, CppPage, SettingsPage — port, install dir, toggles, "Change setup"); Home.tsx deleted |
| P5 settings/tray/autostart | ✅ DONE + USER-VERIFIED | Settings page (shell); tray icon (pystray, runtime-generated icon, menu Show/Start/Stop/Check updates/Quit); close-to-tray (user verified Show); `--minimized` login start; autostart (HKCU Run / XDG .desktop, applied on save_config); autoStartLlamaSwap (port must be free) |
| P6 packaging | ⏳ | PyInstaller onedir |

**Next goal:** P6 — Packaging: PyInstaller (win onedir + linux), launcher scripts, CI matrix, README/docs. (P4 note: the config is applied on next Start; a live reload endpoint in llama-swap would be a P6+ polish.)

## 1. Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Shell | **pywebview (Python 3.11)** — WebView2 on Windows, WebKitGTK on Linux | User already has Python 3.11 + knows it; zero new toolchain; PyInstaller packaging is familiar |
| Packaging (win) | PyInstaller `--onedir` (per-user, no admin) | Inno Setup wrapper later if we want a classic installer |
| Packaging (linux) | PyInstaller onedir + systemd-less launcher script (WebKitGTK still required — same as Tauri would be) | |
| Tray | `pystray` | Close-to-tray, menu |
| App auto-update | Manual "check + redownload" first; auto-update of the app itself deferred | |
| UI | **React 18 + TypeScript + Vite + Tailwind + shadcn/ui** | Professional, polished UI is a web problem; shadcn = speed + consistency |
| i18n | `react-i18next` — EN (default) + PT-BR, toggle in Settings | Persisted in `config.json` |
| Autostart | `HKCU\...\Run` (win) / XDG autostart .desktop (linux) | Per-user, no admin |
| CI | GitHub Actions matrix: windows-latest, ubuntu-latest | Build + test per OS |
| Backend tests | `pytest` (Python: bridge, updater, process manager) | |
| UI tests | Vitest + Testing Library; e2e wizard: Playwright | |

Rejected: Electron (RAM/disk footprint), Tauri/Rust (new 350MB+ toolchain for the user), Go+Wails (smaller desktop ecosystem).

## 2. Install layout (per-user, no admin)

- Windows: `%LOCALAPPDATA%\llama-center\`
  - `llama-cpp\` — current llama.cpp build (flat, executable ready)
  - `llama-swap\` — current llama-swap
  - `backups\llama-cpp\`, `backups\llama-swap\` — last 2 versions before each update
  - `downloads\` — staging area (download → verify → extract → move)
  - `logs\` — rotated log files (llama-swap stdout/stderr)
  - `config.json` — app state (below)
- Linux: `~/.local/share/llama-center/` (same internal layout); autostart via
  `~/.config/autostart/llama-center.desktop`

Documents was rejected: OneDrive sync + permission friction for binaries.

### config.json (app state — NOT llama-swap's own config)

```json
{
  "version": 1,
  "installDir": "C:\\Users\\willi\\AppData\\Local\\llama-center",
  "backend": "cuda-13",
  "llamaCpp": { "pinnedBuild": "b10816" },
  "llamaSwap": { "version": "253", "port": 8085, "autoStart": false },
  "ui": { "language": "en", "closeToTray": true },
  "updates": { "checkOnStart": true },
  "firstRunDone": false
}
```

`llama-swap.yaml` (llama-swap's own config) lives inside `llama-swap\` and is **generated**
by the app's models editor (P4): per-model fields (name, .gguf, mmproj, draft, ctx,
gpu-layers, threads, extra flags) → `cmd` line, with the llama-server path abstracted to
the managed llama.cpp. Existing configs can be imported (unknown flags preserved verbatim).
App state and service config stay separate on purpose.

Design rule (P1): `config.json` **always** lives at the default per-user root
(`%LOCALAPPDATA%\llama-center\` / `~/.local/share/llama-center/`). A custom `install_dir`
is stored *inside* the file — it means "where the components go", not where the config lives
(avoiding chicken-and-egg on first run).

## 3. Update mechanics

### llama-swap (stable releases)
1. `GET /repos/mostlygeek/llama-swap/releases/latest`
2. Pick asset by OS+arch: `llama-swap_{ver}_{os}_{arch}.{zip|tar.gz}`
3. Download to `downloads\` → verify SHA-256 against `llama-swap_{ver}_checksums.txt`
4. Extract to staging dir
5. Stop llama-swap (if running) → move current to `backups\` (keep 2) → move staging to live
6. Health check: `GET :{port}/api/v1/...` responds
7. On failure → **Rollback** button (restore from backups)

### llama.cpp (nightlies — there is NO stable release; "latest" is a stub)
- Real binaries are tagged `b####` assets, e.g.
  `llama-b10816-bin-win-cuda-12.9-x64.zip`, `llama-b10816-bin-ubuntu-22.04-cuda-12.9-x64.tar.gz`
- **Windows CUDA ships as TWO assets** (verified against b10816 contents): the plain
  build (all binaries, no CUDA runtime) + the `cudart-...` zip (ONLY cudart/cuBLAS/
  cuBLASLt DLLs, no executables). Both are installed side by side — the resolver
  picks the plain build as primary (`requestFromConfig` forces family=plain for
  win+cuda) and `companionAsset` attaches the matching DLLs zip (same CUDA version
  + arch). `updater.extract(merge=True)` combines them in staging.
- "Check for updates" = find the **highest `b####`** that has an asset matching
  `{os}-{backend}` (cuda-12.x / cuda-13.x / vulkan / cpu)
- Wizard asks backend: **CUDA 13 / CUDA 12 / Vulkan / CPU**. Auto-detect via
  `nvidia-smi` (driver version → max CUDA toolkit) and preselect.
- Asset name resolution lives in **TS** (`src/lib/assetResolver.ts`) — the wizard needs it to
  show "what will be downloaded" before downloading. Python only does download/verify/swap.
  Pure functions, tested against real nightly fixtures (27 tests). Key policies:
  - fallback chain: same backend+family+major → same family, any major → other family, right major
  - `hardMajor: true` flips tier order (requested CUDA major wins over family) — for users with
    a hard driver constraint (e.g. RTX 5090 needs CUDA 13)
  - sycl: `syclPrecision` fp16 (default) / fp32 — Settings toggle, not a wizard option (P5 polish)
  - `no-asset` is a first-class outcome with `available[]` (e.g. Linux+CUDA, win-x64+opencl)

### Update checks
- Automatic on app start (toast if newer available) **and** manual "Check for updates" button.
- Both llama-swap and llama.cpp checked independently.

## 4. Process manager (Python core)

- Spawn llama-swap with piped stdio (`subprocess`); stream lines to UI via pywebview
  `evaluate_js` / events (terminal view).
- Windows: `CREATE_NO_WINDOW` flag (no console popup).
- **Conflict detection before start**: if port responds → dialog:
  **Adopt** (find PID, take over management without killing) / **Stop & Take Over** / **Cancel**.
- Liveness + structured status via **HTTP polling of llama-swap's own API** on `:{port}`
  (model loaded, GPU mem, etc.). Logs = terminal feel; API = structured truth. Poll ~2s.
- Config editor (P4): edit `llama-swap.json` with validation; "Apply" triggers reload.

## 5. UX decisions (all confirmed)

- Per-user install, no admin (both OSes)
- Linux target: any modern distro via PyInstaller onedir (WebKitGTK required — same as Tauri would be); no PPA/deb/flatpak in MVP
- macOS: future phase
- User pins a `b####` build (nightly model); update check suggests newer
- Configurable llama-swap port, default 8085
- i18n: EN default + PT-BR, Settings toggle. Code/commits/docs/errors: EN
- Logs: ring buffer in UI + rotating files in `logs\`
- Rollback: keep last 2 previous versions per component
- **Start with system (opt-in checkbox in Settings)**:
  - Level 1: app starts at login, minimized to tray (win: `HKCU Run`, linux: XDG autostart)
  - Level 2: separate flag "start llama-swap when app starts"
- Tray icon + close-to-tray: **YES** (default), configurable
- Tray menu: Show / Start llama-swap / Stop llama-swap / Check updates / Quit

## 6. Phases (each shippable)

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **P0** | Scaffold (pywebview+Vite+React+Tailwind+shadcn), i18n EN/PT, first-run wizard: detect OS/arch, auto-detect CUDA via `nvidia-smi`, backend choice (CUDA13/12/Vulkan/CPU), install dir (default per-OS), writes `config.json` | Fresh machine → wizard completes → valid `config.json` on disk. Tests: config schema (Python + TS) |
| **P1** | llama-swap install + update check + atomic update + rollback + existing-process detection | Update on a running install: checksum verified, old version in backups, rollback restores. Wiremock tests for GitHub API |
| **P2** | llama.cpp nightly discovery + install + update | Highest `b####` with matching asset discovered (resolver done, 27 tests); install produces runnable `llama-cli` |
| **P3** | Start/stop llama-swap, terminal log view (ring buffer + file rotation), status panel via API polling | Start → status flips to running within 3s of API response; Stop → clean exit code surfaced; kill app → no orphan process |
| **P4** | Models config editor (generates `llama-swap.yaml`) with validation + import | Field errors before save; import of an existing config.yaml round-trips; start fails with "no-config" when empty |
| **P5** | Settings (port, language, auto-start L1/L2, check-on-start, close-to-tray), tray icon, onboarding polish | Each setting persists and takes effect; autostart entries created/removed correctly on both OSes |
| **P6** | Packaging: PyInstaller (win onedir + linux), launcher scripts, CI matrix, README/docs | Packaged app runs on clean VM/container; updater finds next release |

## 7. Not doing (MVP)

- Model downloading (that's llama-swap's job — deep-link to its dashboard only)
- Windows/Linux system *services* (per-user processes only)
- Docker mode, macOS, i18n beyond EN/PT-BR, PPA/deb/flatpak, GPU benchmarking

## 8. Bridge pattern (decided 2026-09)

All system access (fs read/write, process spawn/kill, downloads, tray, autostart) goes through
one `bridge` interface in TS. Today it's a **browser stub** (in-memory, shows JSON in UI);
when the Python shell lands it becomes the pywebview implementation — same 5 functions.
This keeps P1–P4 100% TS-testable and makes the shell swappable a small change.

## 9. Repo layout (target)

```
backend/              # Python: bridge impl, updater, process manager (pytest-tested)
src/                  # React UI
  components/  i18n/  hooks/  lib/
docs/                 # user docs (EN)
tests/                # e2e (Playwright)
.github/workflows/    # ci.yml, release.yml
```
