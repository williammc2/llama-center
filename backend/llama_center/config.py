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
from dataclasses import asdict, dataclass, field
from pathlib import Path

from llama_center.paths import data_root

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
    cuda_major: int | None = None  # 12 | 13, only when backend == "cuda"
    cuda_family: str = "cudart"
    llama_cpp_installed: str | None = None  # e.g. "b10816"; None = not installed yet
    llama_swap_port: int = 8085
    llama_swap_installed: int | None = None  # e.g. 253; None = not installed yet
    lang: str = "en"
    start_with_system: bool = False
    auto_start_llama_swap: bool = False
    close_to_tray: bool = True
    check_updates_on_start: bool = True
    hf_token: str = ""  # HuggingFace token (optional); "" = anonymous
    model_dirs: list = field(default_factory=list)  # extra model roots (Settings)
    server_backend: str = "llama-swap"  # "llama-swap" | "basalt"
    basalt_exe: str = ""  # full path to basalt.exe / basalt
    basalt_args: str = ""  # CLI args, e.g. "serve --config basalt_config.json --max-context 262144"
    basalt_port: int = 8080
    basalt_installed: str | None = None  # e.g. "0.5.7"; None = not installed yet

    def to_dict(self) -> dict:
        return asdict(self)


def default_install_dir() -> str:
    """Per-OS default install root (per-user, no admin)."""
    return str(data_root())


def normalize_install_dir(s: str) -> str:
    """Expand `~` and env vars (%VAR% on Windows, $VAR on POSIX) and normalize.

    The wizard pre-fills `%LOCALAPPDATA%\\llama-center` verbatim; without this
    expansion Python treats it as a *relative* path and installs into the CWD.
    """
    if not s:
        return s
    s = os.path.expanduser(s)
    # %VAR% on Windows, $VAR on POSIX (expandvars handles each on its OS).
    s = os.path.expandvars(s)
    return os.path.normpath(s)


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

    def _pos_int_or_none(key: str) -> int | None:
        """Positive int or None/null — anything else (incl. bool) is corrupt."""
        v = raw.get(key)
        if v is None:
            return None
        if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
            raise ConfigError(f"config: {key} must be a positive int or null, got {v!r}")
        return v

    port = raw.get("llama_swap_port")
    if port is None:
        port = 8085
    # bool is a subclass of int in Python — reject it explicitly
    if isinstance(port, bool) or not isinstance(port, int) or port <= 0:
        raise ConfigError(f"config: llama_swap_port must be a positive int, got {port!r}")

    swap_installed = _pos_int_or_none("llama_swap_installed")

    install_dir = raw.get("install_dir", "")
    if not isinstance(install_dir, str):
        raise ConfigError(f"config: install_dir must be a string, got {install_dir!r}")
    install_dir = normalize_install_dir(install_dir)

    cpp_installed = raw.get("llama_cpp_installed")
    if cpp_installed is not None and not isinstance(cpp_installed, str):
        raise ConfigError(
            f"config: llama_cpp_installed must be a string or null, got {cpp_installed!r}"
        )

    hf_token = raw.get("hf_token", "")
    if not isinstance(hf_token, str):
        raise ConfigError(f"config: hf_token must be a string, got {hf_token!r}")

    model_dirs = raw.get("model_dirs", [])
    if not isinstance(model_dirs, list) or not all(isinstance(d, str) for d in model_dirs):
        raise ConfigError(f"config: model_dirs must be a list of strings, got {model_dirs!r}")
    model_dirs = [normalize_install_dir(d) for d in model_dirs if d.strip()]

    server_backend = raw.get("server_backend", "llama-swap")
    if server_backend not in ("llama-swap", "basalt"):
        raise ConfigError(f"config: unknown server_backend {server_backend!r}")

    basalt_exe = raw.get("basalt_exe", "")
    if not isinstance(basalt_exe, str):
        raise ConfigError(f"config: basalt_exe must be a string, got {basalt_exe!r}")
    basalt_exe = normalize_install_dir(basalt_exe)
    basalt_args = raw.get("basalt_args", "")
    if not isinstance(basalt_args, str):
        raise ConfigError(f"config: basalt_args must be a string, got {basalt_args!r}")

    basalt_port = raw.get("basalt_port", 8080)
    if isinstance(basalt_port, bool) or not isinstance(basalt_port, int) or basalt_port <= 0:
        raise ConfigError(f"config: basalt_port must be a positive int, got {basalt_port!r}")

    basalt_installed = raw.get("basalt_installed")
    if basalt_installed is not None and not isinstance(basalt_installed, str):
        raise ConfigError(
            f"config: basalt_installed must be a string or null, got {basalt_installed!r}"
        )

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
        llama_cpp_installed=cpp_installed,
        llama_swap_port=port,
        llama_swap_installed=swap_installed,
        lang=lang,
        start_with_system=_bool("start_with_system", False),
        auto_start_llama_swap=_bool("auto_start_llama_swap", False),
        close_to_tray=_bool("close_to_tray", True),
        check_updates_on_start=_bool("check_updates_on_start", True),
        hf_token=hf_token,
        model_dirs=model_dirs,
        server_backend=server_backend,
        basalt_exe=basalt_exe,
        basalt_args=basalt_args,
        basalt_port=basalt_port,
        basalt_installed=basalt_installed,
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
