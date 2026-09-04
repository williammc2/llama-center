"""App config: schema, validation, read/write.

Mirrors src/lib/config.ts (the two must stay in sync — same rules, same
defaults). The config file lives at <install_dir>/config.json, where
install_dir defaults to:
  Windows: %LOCALAPPDATA%/llama-center
  Linux:   ~/.local/share/llama-center

Deliberately separate from llama-swap.json (the daemon's own config, P4).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

BACKENDS = ("cpu", "cuda", "vulkan", "rocm", "sycl", "openvino", "opencl")
LANGS = ("en", "pt-BR")
CUDA_FAMILIES = ("cudart", "plain")


class ConfigError(ValueError):
    """Raised when config.json exists but is corrupt / unsupported."""


@dataclass
class AppConfig:
    """Schema version 1 — mirrors the TS AppConfig interface."""

    version: int = 1
    first_run_done: bool = False
    install_dir: str = ""
    backend: str = "cpu"
    cuda_major: Optional[int] = None  # 12 | 13, only when backend == "cuda"
    cuda_family: str = "cudart"
    llama_cpp_pin: Optional[str] = None  # e.g. "b10814"; None = latest-with-asset
    llama_swap_port: int = 8085
    llama_swap_installed: Optional[int] = None  # e.g. 253; None = not installed yet
    lang: str = "en"
    start_with_system: bool = False
    auto_start_llama_swap: bool = False
    close_to_tray: bool = True
    check_updates_on_start: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


def default_install_dir() -> str:
    """Per-OS default install root (per-user, no admin)."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return str(Path(base) / "llama-center")
    # Linux (and anything POSIX-like): XDG_DATA_HOME, else ~/.local/share
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return str(Path(base) / "llama-center")


def config_path() -> Path:
    """Where config.json lives — ALWAYS the default per-user root.

    Chicken-and-egg: a custom install_dir is stored *inside* config.json, so
    the file must live somewhere findable without reading it first. The
    install_dir field then points at the managed components (llama-cpp,
    llama-swap), which may be the same root or elsewhere.
    """
    return Path(default_install_dir()) / "config.json"


def parse_config(raw: object) -> AppConfig:
    """Validate + coerce raw JSON into an AppConfig.

    Rules (must match TS parseConfig):
      - unknown keys dropped, missing keys → defaults
      - wrong type on a present key → ConfigError (UI shows "corrupt config")
      - version must be exactly 1
    """
    if not isinstance(raw, dict):
        raise ConfigError("config: not an object")
    if raw.get("version") is None:
        raise ConfigError("config: missing version")
    if raw.get("version") != 1:
        raise ConfigError(f"config: unsupported version {raw.get('version')!r} (expected 1)")

    backend = raw.get("backend", "cpu")
    if backend not in BACKENDS:
        raise ConfigError(f"config: unknown backend {backend!r}")

    lang = raw.get("lang", "en")
    if lang not in LANGS:
        raise ConfigError(f"config: unknown lang {lang!r}")

    cuda_major = raw.get("cuda_major")
    cuda_major = cuda_major if cuda_major in (12, 13) else None

    cuda_family = raw.get("cuda_family")
    cuda_family = cuda_family if cuda_family in CUDA_FAMILIES else "cudart"

    port = raw.get("llama_swap_port")
    if port is None:
        port = 8085
    # bool is a subclass of int in Python — reject it explicitly
    if isinstance(port, bool) or not isinstance(port, int) or port <= 0:
        raise ConfigError(f"config: llama_swap_port must be a positive int, got {port!r}")

    swap_installed = raw.get("llama_swap_installed")
    if swap_installed is not None:
        if isinstance(swap_installed, bool) or not isinstance(swap_installed, int) or swap_installed <= 0:
            raise ConfigError(
                f"config: llama_swap_installed must be a positive int or null, got {swap_installed!r}"
            )

    install_dir = raw.get("install_dir", "")
    if not isinstance(install_dir, str):
        raise ConfigError(f"config: install_dir must be a string, got {install_dir!r}")

    pin = raw.get("llama_cpp_pin")
    if pin is not None and not isinstance(pin, str):
        raise ConfigError(f"config: llama_cpp_pin must be a string or null, got {pin!r}")

    def _bool(key: str, dflt: bool) -> bool:
        v = raw.get(key)
        return dflt if v is None else bool(v)

    return AppConfig(
        version=1,
        first_run_done=_bool("first_run_done", False),
        install_dir=install_dir,
        backend=backend,
        cuda_major=cuda_major,
        cuda_family=cuda_family,
        llama_cpp_pin=pin,
        llama_swap_port=port,
        llama_swap_installed=swap_installed,
        lang=lang,
        start_with_system=_bool("start_with_system", False),
        auto_start_llama_swap=_bool("auto_start_llama_swap", False),
        close_to_tray=_bool("close_to_tray", True),
        check_updates_on_start=_bool("check_updates_on_start", True),
    )


def serialize_config(cfg: AppConfig) -> str:
    """JSON, indent 2, trailing newline — byte-compatible with the TS output."""
    return json.dumps(cfg.to_dict(), indent=2, ensure_ascii=False) + "\n"


def load_config() -> AppConfig:
    """Read config.json. Missing file → defaults (first run). Corrupt → ConfigError."""
    path = config_path()
    if not path.exists():
        return AppConfig()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"config: invalid JSON at {path}: {e}") from e
    return parse_config(raw)


def save_config(cfg: AppConfig) -> str:
    """Write config.json (creating the root dir). Returns the path written."""
    if not cfg.install_dir:
        cfg.install_dir = default_install_dir()
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize_config(cfg), encoding="utf-8")
    return str(path)
