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
"""
from __future__ import annotations

import atexit
import json
import os
import sys
import urllib.request
from pathlib import Path

# Make `llama_center` importable regardless of CWD.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

import webview  # noqa: E402

from llama_center.config import (  # noqa: E402
    AppConfig,
    ConfigError,
    load_config,
    parse_config,
    save_config,
)
from llama_center import process as proc  # noqa: E402
from llama_center import updater  # noqa: E402
from llama_center.detect import detect  # noqa: E402

# The single managed llama-swap process (module-level: one per app run).
_managed: proc.LlamaSwapProcess | None = None


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
        """Validate + persist. Returns {path} or {error}."""
        try:
            cfg = parse_config(self._from_camel(raw))
            path = save_config(cfg)
            return {"path": path}
        except ConfigError as e:
            return {"error": str(e)}

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

        Returns {backup: <name> | null} or {error}.
        """
        try:
            d = self._dirs(component)
            backup = updater.atomic_swap(
                d["live"], d["staging"], d["backups"], label=self._installed_label(component), component=component
            )
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
        cmd = [str(exe), "--listen", f"localhost:{cfg.llama_swap_port}"]
        for name in ("llama-swap.json", "llama-swap.yaml"):
            c = d["live"] / name
            if c.exists():
                cmd += ["--config", str(c)]
                break
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


def main() -> int:
    dist = REPO_ROOT / "dist" / "index.html"
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
    )
    webview.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
