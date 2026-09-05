"""Per-user data root — the single source of truth for where llama-center
keeps its files.

  Windows: %LOCALAPPDATA%/llama-center
  Linux:   $XDG_DATA_HOME/llama-center  (else ~/.local/share/llama-center)

Both the config file (config.py) and the singleton lock/IPC (singleton.py)
live under this root, so the path is computed once here instead of in two
places that had drifted.
"""
from __future__ import annotations

import os
from pathlib import Path


def data_root() -> Path:
    """Per-user data root (per-user, no admin)."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "llama-center"
