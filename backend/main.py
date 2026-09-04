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
  - stop_llama_swap() → bool
"""
from __future__ import annotations

import os
import sys
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
from llama_center import updater  # noqa: E402
from llama_center.detect import detect  # noqa: E402


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
            updater.download(url, archive, sha256)
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

    def stop_llama_swap(self) -> bool:
        """Best-effort kill of a running llama-swap. True if one was killed."""
        return updater.stop_llama_swap()

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
