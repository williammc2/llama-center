"""llama-center — pywebview entry point.

Run:  python backend/main.py  (from the repo root, after `pnpm build`)

Loads the built UI from dist/index.html and exposes `window.pywebview.api`
to the React app (see src/lib/bridge.ts for the client side).

P0 surface:
  - get_config()  → current config (dict) or null
  - save_config(cfg) → writes config.json, returns the path
  - get_detection() → OS/arch/CUDA probe result
  - get_platform() → "win" | "linux" | "macos"

P1 surface (install/update, per component — "llama-swap" | "llama-cpp"):
  - download_and_stage(component, url, sha256) → {staging} | {error}
  - swap_component(component) → {backup} | {error}
  - rollback_component(component) → {rolledBack} | {error}
  - list_component_backups(component) → [names, newest first]
  - probe_port(port) → bool

P3 surface (run llama-swap):
  - start_llama_swap() → {pid} | {error}
  - stop_llama_swap() → {stopped, exitCode} (managed first, then by name)
  - llama_swap_status() → {managed, pid, portBusy, healthy, models}
  - llama_swap_logs(n) → [lines, newest last]

P4 surface (llama-swap config / models):
  - save_llama_swap_config(models) → {path} | {error}
  - get_llama_swap_config() → {models, path}
  - import_llama_swap_config(path) → {models} | {error}

P5 (tray + autostart):
  - save_config applies the autostart entry (startWithSystem)
  - `--minimized` flag: start hidden in the tray (login start)
  - close-to-tray when configured; tray menu: Show / Start / Stop /
    Check updates / Quit
  - autoStartLlamaSwap: the server starts with the app (port must be free)
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
from dataclasses import asdict
from pathlib import Path

# Make `llama_center` importable regardless of CWD (dev mode only — when
# frozen, PyInstaller has already bundled the package into sys.path).
REPO_ROOT = Path(__file__).resolve().parent.parent
FROZEN = getattr(sys, "frozen", False)
if not FROZEN:
    sys.path.insert(0, str(REPO_ROOT / "backend"))


def dist_dir() -> Path:
    """Where the built UI lives: repo dist/ in dev, _MEIPASS/dist when frozen."""
    if FROZEN:
        return Path(sys._MEIPASS) / "dist"
    return REPO_ROOT / "dist"

import webview  # noqa: E402

from llama_center import autostart  # noqa: E402
from llama_center.config import (  # noqa: E402
    AppConfig,
    ConfigError,
    load_config,
    parse_config,
    save_config,
)
from llama_center import process as proc  # noqa: E402
from llama_center import swapconfig as swc  # noqa: E402
from llama_center import updater  # noqa: E402
from llama_center.detect import detect  # noqa: E402

# The single managed llama-swap process (module-level: one per app run).
_managed: proc.LlamaSwapProcess | None = None

# Tray state (module-level: one icon per app run).
_tray_icon: "pystray.Icon | None" = None
_force_quit = False


def shutdown_managed() -> None:
    """atexit hook — no orphan process on a graceful app exit."""
    global _managed
    if _managed is not None and _managed.running:
        _managed.stop(timeout=5)
        _managed.flush()


class Api:
    """The surface exposed to the UI as window.pywebview.api."""

    def get_platform(self) -> str:
        return detect().os

    def get_detection(self) -> dict:
        d = detect()
        return {
            "os": d.os,
            "arch": d.arch,
            "suggestCuda": d.suggest_cuda,
            "cudaMajorHint": d.cuda_major_hint,
            "gpuName": d.gpu_name,
            "backends": list(d.backends),
        }

    def get_config(self):
        """Current config as a dict (camelCase, matching the TS shape) or None."""
        try:
            cfg = load_config()
        except ConfigError:
            return {"error": "corrupt"}
        return self._to_camel(cfg)

    def save_config(self, raw: dict) -> dict:
        """Validate + persist. Returns {path} or {error}.

        Also applies the autostart entry so the toggle takes effect at once.
        """
        try:
            cfg = parse_config(self._from_camel(raw))
            path = save_config(cfg)
        except ConfigError as e:
            return {"error": str(e)}
        try:
            autostart.apply(cfg.start_with_system)
        except Exception:
            pass  # autostart is best-effort; the config save is what matters
        return {"path": path}

    # --- P1: llama-swap install/update -------------------------------------

    def _dirs(self, component: str = "llama-swap") -> dict:
        """Managed paths for the configured install dir. Raises ConfigError."""
        cfg = load_config()
        if not cfg.install_dir:
            raise ConfigError("install_dir not set — run the wizard first")
        return updater.component_dirs(cfg.install_dir, component)

    def _installed_label(self, component: str) -> str | None:
        """What is currently installed, for the backup dir name."""
        cfg = load_config()
        if component == "llama-swap" and cfg.llama_swap_installed:
            return f"v{cfg.llama_swap_installed}"
        if component == "llama-cpp" and cfg.llama_cpp_installed:
            return cfg.llama_cpp_installed
        return None

    def _push_progress(self, payload: dict) -> None:
        """Push a download-progress event to the UI (cosmetic — never raises)."""
        try:
            if webview.windows:
                webview.windows[0].evaluate_js(
                    f"window.__lcProgress && window.__lcProgress({json.dumps(payload)})"
                )
        except Exception:
            pass

    @staticmethod
    def _clean_downloads(downloads: Path) -> None:
        """Remove archives and staging dirs after a successful swap."""
        if not downloads.is_dir():
            return
        for entry in downloads.iterdir():
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)

    def download_and_stage(
        self, component: str, url: str, sha256: str | None = None, into: str | None = None
    ) -> dict:
        """Download a release asset, verify SHA-256, extract to staging.

        With `into` set, the archive is merged INTO that directory (no wipe) —
        used for a second asset (e.g. the Windows CUDA DLLs zip). Returns
        {staging: <content dir>} or {error}.
        """
        try:
            d = self._dirs(component)
            name = url.rsplit("/", 1)[-1].split("?")[0] or component
            archive = d["downloads"] / name

            def _on_progress(received: int, total: int | None) -> None:
                self._push_progress(
                    {"component": component, "file": name, "received": received, "total": total}
                )

            updater.download(url, archive, sha256, progress=_on_progress)
            if into:
                content = updater.extract(archive, Path(into), merge=True)
            else:
                content = updater.extract(archive, d["staging"])
            return {"staging": str(content)}
        except (ConfigError, updater.UpdateError, OSError) as e:
            return {"error": str(e)}

    def swap_component(self, component: str) -> dict:
        """Swap staging into the live dir; previous install → backups.

        Cleans up downloads/ (archives + staging) on success.
        Returns {backup: <name> | null} or {error}.
        """
        try:
            d = self._dirs(component)
            backup = updater.atomic_swap(
                d["live"], d["staging"], d["backups"], label=self._installed_label(component), component=component
            )
            self._clean_downloads(d["downloads"])
            return {"backup": backup}
        except (ConfigError, updater.UpdateError, OSError) as e:
            return {"error": str(e)}

    def rollback_component(self, component: str) -> dict:
        """Restore the newest backup. Returns {rolledBack: bool} or {error}."""
        try:
            d = self._dirs(component)
            return {"rolledBack": updater.rollback(d["live"], d["backups"])}
        except (ConfigError, updater.UpdateError, OSError) as e:
            return {"error": str(e)}

    def list_component_backups(self, component: str) -> list:
        """Backup dir names, newest first. [] when none (or no config)."""
        try:
            return updater.list_backups(self._dirs(component)["backups"])
        except ConfigError:
            return []

    def probe_port(self, port: int) -> bool:
        """True when something listens on 127.0.0.1:<port>."""
        return updater.probe_port(port)

    # --- P3: run llama-swap --------------------------------------------------

    def _exe(self, d: dict) -> Path | None:
        name = "llama-swap.exe" if os.name == "nt" else "llama-swap"
        p = d["live"] / name
        return p if p.exists() else None

    def start_llama_swap(self) -> dict:
        """Spawn the installed llama-swap. {pid} | {error}.

        `error` is "port-in-use" (UI shows the conflict dialog),
        "not-installed", or a spawn failure message.
        """
        global _managed
        try:
            d = self._dirs("llama-swap")
            cfg = load_config()
        except ConfigError as e:
            return {"error": str(e)}
        exe = self._exe(d)
        if exe is None:
            return {"error": "not-installed"}
        if _managed is not None and _managed.running:
            return {"error": "already-running"}
        if updater.probe_port(cfg.llama_swap_port):
            return {"error": "port-in-use", "port": cfg.llama_swap_port}
        config_file = next(
            (d["live"] / n for n in ("llama-swap.json", swc.CONFIG_NAME) if (d["live"] / n).exists()),
            None,
        )
        if config_file is None:
            return {"error": "no-config"}
        cmd = [str(exe), "--listen", f"localhost:{cfg.llama_swap_port}", "--config", str(config_file)]
        try:
            _managed = proc.LlamaSwapProcess(cmd, d["live"], d["logs"])
            pid = _managed.start()
            return {"pid": pid}
        except proc.ProcessError as e:
            return {"error": str(e)}

    def stop_llama_swap(self) -> dict:
        """Stop a running llama-swap: the managed one first, else by image
        name (an adopted process). {stopped: bool, exitCode: int|null}."""
        global _managed
        if _managed is not None and _managed.running:
            code = _managed.stop()
            _managed.flush()
            return {"stopped": True, "exitCode": code}
        return {"stopped": updater.stop_llama_swap(), "exitCode": None}

    def llama_swap_status(self) -> dict:
        """Structured status for the UI (polled ~2s): managed state, port,
        /health, and the /running model list."""
        try:
            cfg = load_config()
        except ConfigError:
            cfg = None
        port = cfg.llama_swap_port if cfg else 8085
        managed = _managed is not None and _managed.running
        port_busy = updater.probe_port(port)
        healthy = updater.health_ok(port) if port_busy else False
        models: list[dict] = []
        if healthy:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/running", timeout=2
                ) as r:
                    data = json.loads(r.read().decode("utf-8"))
                for m in data.get("running", []) if isinstance(data, dict) else []:
                    if isinstance(m, dict) and isinstance(m.get("model"), str):
                        models.append({"model": m["model"], "state": m.get("state", "")})
            except Exception:
                pass
        return {
            "managed": managed,
            "pid": _managed.pid if managed else None,
            "portBusy": port_busy,
            "healthy": healthy,
            "models": models,
        }

    def llama_swap_logs(self, n: int = 200) -> list:
        """Last `n` lines of the managed process (newest last). [] when none."""
        if _managed is not None:
            return _managed.lines(n)
        return []

    # --- P4: llama-swap config (models) ----------------------------------

    def _llama_server_path(self, install_dir: str) -> Path:
        return updater.component_dirs(install_dir, "llama-cpp")["live"] / (
            "llama-server.exe" if os.name == "nt" else "llama-server"
        )

    @staticmethod
    def _models_from_camel(raw: list) -> list:
        out = []
        for r in raw or []:
            if not isinstance(r, dict):
                continue
            out.append(
                swc.SwapModel(
                    name=str(r.get("name", "")),
                    model=str(r.get("model", "")),
                    mmproj=r.get("mmproj") or None,
                    draft=r.get("draft") or None,
                    ctx_size=int(r.get("ctxSize") or swc.DEFAULT_CTX),
                    gpu_layers=int(r.get("gpuLayers") or swc.DEFAULT_GPU_LAYERS),
                    threads=(int(r["threads"]) if r.get("threads") else None),
                    extra_flags=str(r.get("extraFlags", "")),
                )
            )
        return out

    @staticmethod
    def _models_to_camel(models: list) -> list:
        out = []
        for m in models:
            d = asdict(m)
            out.append(
                {
                    "name": d["name"],
                    "model": d["model"],
                    "mmproj": d["mmproj"],
                    "draft": d["draft"],
                    "ctxSize": d["ctx_size"],
                    "gpuLayers": d["gpu_layers"],
                    "threads": d["threads"],
                    "extraFlags": d["extra_flags"],
                }
            )
        return out

    def save_llama_swap_config(self, models: list) -> dict:
        """Render model defs to `llama-swap.yaml` in the llama-swap dir.
        {path} | {error}."""
        try:
            d = self._dirs("llama-swap")
            cfg = load_config()
        except ConfigError as e:
            return {"error": str(e)}
        server = self._llama_server_path(cfg.install_dir)
        if not server.exists():
            return {"error": "llama-cpp-not-installed"}
        try:
            text = swc.render_yaml(self._models_from_camel(models), str(server))
        except swc.SwapConfigError as e:
            return {"error": str(e)}
        p = d["live"] / swc.CONFIG_NAME
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return {"path": str(p)}

    def get_llama_swap_config(self) -> dict:
        """Read the managed config back into model defs (UI prefill)."""
        try:
            d = self._dirs("llama-swap")
        except ConfigError:
            return {"models": [], "path": None}
        p = d["live"] / swc.CONFIG_NAME
        if not p.exists():
            return {"models": [], "path": None}
        try:
            models = swc.parse_models(p.read_text(encoding="utf-8"))
        except Exception:
            return {"models": [], "path": str(p)}
        return {"models": self._models_to_camel(models), "path": str(p)}

    def open_url(self, url: str) -> dict:
        """Open a URL in the default browser (the server dashboard link)."""
        try:
            if os.name == "nt":
                os.startfile(url)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(
                    ["xdg-open", url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            return {"opened": True}
        except Exception as e:
            return {"error": str(e)}

    def open_path(self, path: str) -> dict:
        """Open a folder in the OS file explorer."""
        try:
            if os.name == "nt":
                os.startfile(path)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(
                    ["xdg-open", path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            return {"opened": True}
        except Exception as e:
            return {"error": str(e)}

    def import_llama_swap_config(self, path: str) -> dict:
        """Parse an existing llama-swap config file (e.g. an old config.yaml)
        into model defs. {models} | {error}."""
        p = Path(str(path))
        if not p.is_file():
            return {"error": f"file not found: {path}"}
        try:
            models = swc.parse_models(p.read_text(encoding="utf-8"))
        except Exception as e:
            return {"error": f"could not parse: {e}"}
        if not models:
            return {"error": "no models found in that file"}
        return {"models": self._models_to_camel(models)}

    # --- shape conversion -------------------------------------------------
    # UI speaks camelCase (TS), Python speaks snake_case (PEP8). One place
    # owns the mapping.
    _KEY_MAP = {
        "firstRunDone": "first_run_done",
        "installDir": "install_dir",
        "cudaMajor": "cuda_major",
        "cudaFamily": "cuda_family",
        "llamaCppPin": "llama_cpp_pin",
        "llamaCppInstalled": "llama_cpp_installed",
        "llamaSwapPort": "llama_swap_port",
        "llamaSwapInstalled": "llama_swap_installed",
        "startWithSystem": "start_with_system",
        "autoStartLlamaSwap": "auto_start_llama_swap",
        "closeToTray": "close_to_tray",
        "checkUpdatesOnStart": "check_updates_on_start",
    }

    def _from_camel(self, raw: dict) -> dict:
        out = {}
        for k, v in raw.items():
            out[self._KEY_MAP.get(k, k)] = v
        return out

    def _to_camel(self, cfg: AppConfig) -> dict:
        d = cfg.to_dict()
        rev = {v: k for k, v in self._KEY_MAP.items()}
        return {rev.get(k, k): v for k, v in d.items()}


def _tray_quit(window) -> None:
    global _force_quit
    _force_quit = True
    window.destroy()


def _tray_check_updates(window) -> None:
    window.show()
    try:
        window.evaluate_js("window.__lcCheckUpdates && window.__lcCheckUpdates()")
    except Exception:
        pass


def start_tray(window, api: Api) -> None:
    """Run the tray icon in a daemon thread (pystray blocks).

    pystray is imported lazily: its __init__ resolves the OS backend at
    import time, and the Linux Xorg backend opens an X display — which
    doesn't exist in headless contexts (CI).
    """
    global _tray_icon

    def run() -> None:
        import pystray  # noqa: PLC0415

        from llama_center.icon import make_icon  # noqa: PLC0415

        menu = pystray.Menu(
            pystray.MenuItem("Show", window.show, default=True),
            pystray.MenuItem("Start llama-swap", lambda icon, item: api.start_llama_swap()),
            pystray.MenuItem("Stop llama-swap", lambda icon, item: api.stop_llama_swap()),
            pystray.MenuItem("Check for updates", lambda icon, item: _tray_check_updates(window)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", lambda icon, item: _tray_quit(window)),
        )
        icon = pystray.Icon("llama-center", make_icon(), "llama-center")
        icon.menu = menu
        _tray_icon = icon
        icon.run()

    threading.Thread(target=run, daemon=True).start()


def _maybe_autostart_swap(api: Api) -> None:
    """autoStartLlamaSwap: start the server with the app (only when the port
    is free — an external llama-swap is adopted by the UI, not killed here)."""
    import time

    time.sleep(2)  # let the window + API come up
    try:
        cfg = load_config()
        if not cfg.auto_start_llama_swap:
            return
        if not updater.probe_port(cfg.llama_swap_port):
            api.start_llama_swap()
    except ConfigError:
        pass


def main() -> int:
    dist = dist_dir() / "index.html"
    if not dist.exists():
        print(f"UI not built — run `pnpm build` first (expected {dist}).", file=sys.stderr)
        return 1

    atexit.register(shutdown_managed)

    api = Api()
    window = webview.create_window(
        "llama-center",
        str(dist),
        width=1080,
        height=760,
        min_size=(880, 600),
        background_color="#0a0a0a",
        js_api=api,
        hidden="--minimized" in sys.argv,  # login start → straight to the tray
    )

    def on_closing(window) -> bool:
        """Close-to-tray: return False to cancel the close (hide instead).

        pywebview 6.x: window.events.closing — set() returns False when any
        handler returns False, which the GUI backend uses to cancel.
        """
        try:
            cfg = load_config()
            if cfg.close_to_tray and not _force_quit:
                window.hide()
                return False
        except ConfigError:
            pass
        return True

    window.events.closing += on_closing

    start_tray(window, api)
    threading.Thread(target=_maybe_autostart_swap, args=(api,), daemon=True).start()

    webview.start()

    if _tray_icon is not None:
        try:
            _tray_icon.stop()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
