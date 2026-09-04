# Llama Center — Plan

A cross-platform (Windows + Linux) desktop app that installs, configures, runs, and keeps
up-to-date **llama.cpp** (nightlies) and **llama-swap** for local LLM inference.

Status: P0 in progress. Owner: @architect (plan) / @builder (code).

## 1. Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri v2** (Rust) | ~15MB binary, Rust for process management (spawn, stdio pipes, exit codes) |
| UI | **React 18 + TypeScript + Vite + Tailwind + shadcn/ui** | Professional, polished UI is a web problem; shadcn = speed + consistency |
| i18n | `react-i18next` — EN (default) + PT-BR, toggle in Settings | Persisted in `config.json` |
| Packaging (win) | NSIS installer, per-user, no admin | `HKCU\...\Run` for autostart |
| Packaging (linux) | **AppImage** (bundles WebKitGTK) | Zero system deps, any modern distro |
| App auto-update | `tauri-plugin-updater` | Same channel as releases |
| CI | GitHub Actions matrix: windows-latest, ubuntu-latest | Build + test per OS |
| Rust tests | `cargo test` + `wiremock` for GitHub API | |
| UI tests | Vitest + Testing Library; e2e wizard: Playwright | |

Rejected: Electron (RAM/disk footprint), Go+Wails (smaller desktop ecosystem).

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

`llama-swap.json` (llama-swap's own config) lives inside `llama-swap\` and is edited by
the app's validated editor (P4). App state and service config stay separate on purpose.

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
- "Check for updates" = find the **highest `b####`** that has an asset matching
  `{os}-{backend}` (cuda-12.x / cuda-13.x / vulkan / cpu)
- Wizard asks backend: **CUDA 13 / CUDA 12 / Vulkan / CPU**. Auto-detect via
  `nvidia-smi` (driver version → max CUDA toolkit) and preselect.
- Asset name resolution lives in **TS** (`src/lib/assetResolver.ts`) — the wizard needs it to
  show "what will be downloaded" before downloading. Rust only does download/verify/swap.
  Pure functions, tested against real nightly fixtures (27 tests). Key policies:
  - fallback chain: same backend+family+major → same family, any major → other family, right major
  - `hardMajor: true` flips tier order (requested CUDA major wins over family) — for users with
    a hard driver constraint (e.g. RTX 5090 needs CUDA 13)
  - sycl: `syclPrecision` fp16 (default) / fp32 — Settings toggle, not a wizard option (P5 polish)
  - `no-asset` is a first-class outcome with `available[]` (e.g. Linux+CUDA, win-x64+opencl)

### Update checks
- Automatic on app start (toast if newer available) **and** manual "Check for updates" button.
- Both llama-swap and llama.cpp checked independently.

## 4. Process manager (Rust core)

- Spawn llama-swap with piped stdio; stream lines to UI via Tauri events (terminal view).
- Windows: `CREATE_NO_WINDOW` (no console popup).
- **Conflict detection before start**: if port responds → dialog:
  **Adopt** (find PID, take over management without killing) / **Stop & Take Over** / **Cancel**.
- Liveness + structured status via **HTTP polling of llama-swap's own API** on `:{port}`
  (model loaded, GPU mem, etc.). Logs = terminal feel; API = structured truth. Poll ~2s.
- Config editor (P4): edit `llama-swap.json` with validation; "Apply" triggers reload.

## 5. UX decisions (all confirmed)

- Per-user install, no admin (both OSes)
- Linux target: any modern distro via AppImage; no PPA/deb/flatpak in MVP
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
| **P0** | Scaffold (Tauri+Vite+React+Tailwind+shadcn), i18n EN/PT, first-run wizard: detect OS/arch, auto-detect CUDA via `nvidia-smi`, backend choice (CUDA13/12/Vulkan/CPU), install dir (default per-OS), writes `config.json` | Fresh machine → wizard completes → valid `config.json` on disk. Tests: config schema (Rust + TS) |
| **P1** | llama-swap install + update check + atomic update + rollback + existing-process detection | Update on a running install: checksum verified, old version in backups, rollback restores. Wiremock tests for GitHub API |
| **P2** | llama.cpp nightly discovery + install + update | Highest `b####` with matching asset discovered (resolver done, 27 tests); install produces runnable `llama-cli` |
| **P3** | Start/stop llama-swap, terminal log view (ring buffer + file rotation), status panel via API polling | Start → status flips to running within 3s of API response; Stop → clean exit code surfaced; kill app → no orphan process |
| **P4** | `llama-swap.json` editor with validation + apply/reload | Invalid JSON shows field errors before save; apply triggers reload without restart if supported |
| **P5** | Settings (port, language, auto-start L1/L2, check-on-start, close-to-tray), tray icon, onboarding polish | Each setting persists and takes effect; autostart entries created/removed correctly on both OSes |
| **P6** | Packaging: NSIS + AppImage, tauri-plugin-updater, CI matrix, README/docs | Installers run on clean VM/container; updater finds next release |

## 7. Not doing (MVP)

- Model downloading (that's llama-swap's job — deep-link to its dashboard only)
- Windows/Linux system *services* (per-user processes only)
- Docker mode, macOS, i18n beyond EN/PT-BR, PPA/deb/flatpak, GPU benchmarking

## 8. Bridge pattern (decided 2026-09)

All system access (fs read/write, process spawn/kill, downloads, tray, autostart) goes through
one `bridge` interface in TS. Today it's a **browser stub** (in-memory, shows JSON in UI);
when Rust lands it becomes the Tauri implementation — same 5 functions. This keeps P1–P4
100% TS-testable and makes the shell swappable (Tauri gnu / Electron / Wails) a small change.

Rust toolchain decision deferred: when the Tauri shell lands, use the **`gnu`** toolchain
(x86_64-pc-windows-gnu, ~350MB, no MSVC Build Tools). P1–P4 don't need any of it.

## 9. Repo layout (target)

```
src-tauri/            # Rust core: config, updater, process manager, asset resolver
src/                  # React UI
  components/  i18n/  hooks/  lib/
docs/                 # user docs (EN)
tests/                # e2e (Playwright)
.github/workflows/    # ci.yml, release.yml
```
