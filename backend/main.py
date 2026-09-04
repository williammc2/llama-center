"""llama-center — pywebview entry point.

Run:  python backend/main.py  (from the repo root, after `pnpm build`)

Loads the built UI from dist/index.html and exposes `window.pywebview.api`
to the React app (see src/lib/bridge.ts for the client side).

P0 surface:
  - get_config()  → current config (dict) or null
  - save_config(cfg) → writes config.json, returns the path
  - get_detection() → OS/arch/CUDA probe result
  - get_platform() → "win" | "linux" | "macos"
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

    # --- shape conversion -------------------------------------------------
    # UI speaks camelCase (TS), Python speaks snake_case (PEP8). One place
    # owns the mapping.
    _KEY_MAP = {
        "firstRunDone": "first_run_done",
        "installDir": "install_dir",
        "cudaMajor": "cuda_major",
        "cudaFamily": "cuda_family",
        "llamaCppPin": "llama_cpp_pin",
        "llamaSwapPort": "llama_swap_port",
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
