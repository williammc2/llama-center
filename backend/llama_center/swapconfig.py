"""llama-swap config generation/parsing — the models abstraction.

The UI exposes per-model fields (name, model path, optional mmproj/draft,
ctx-size, gpu-layers, threads, free-form extra flags) and this module renders
them into the `cmd` line llama-swap executes. The llama-server path is
abstracted away: it always points at the llama.cpp managed by llama-center,
never a user-maintained copy.

The config file is written as `llama-swap.yaml` inside the llama-swap install
dir and passed via `--config` on start. `parse_models` reads a generated (or
user-supplied, e.g. an existing config.yaml) file back into model defs —
that's what powers "import from file".
"""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, asdict
from typing import Optional

import yaml

DEFAULT_CTX = 8192
DEFAULT_GPU_LAYERS = 999
CONFIG_NAME = "llama-swap.yaml"


class SwapConfigError(ValueError):
    """Raised when the model list can't be rendered, with a readable message."""


@dataclass
class SwapModel:
    name: str
    model: str
    mmproj: Optional[str] = None
    draft: Optional[str] = None
    ctx_size: int = DEFAULT_CTX
    gpu_layers: int = DEFAULT_GPU_LAYERS
    threads: Optional[int] = None
    extra_flags: str = ""


def _q(path: str) -> str:
    """Always quote path arguments (matches the user's working config)."""
    return f'"{path}"'


def build_cmd(m: SwapModel, llama_server: str) -> str:
    """The full llama-server command line for one model."""
    parts = [
        llama_server,
        "--host",
        "127.0.0.1",
        "--port",
        "${PORT}",
        "--model",
        _q(m.model),
    ]
    if m.mmproj:
        parts += ["--mmproj", _q(m.mmproj)]
    if m.draft:
        parts += ["--model-draft", _q(m.draft)]
    parts += ["--ctx-size", str(m.ctx_size), "--gpu-layers", str(m.gpu_layers)]
    if m.threads:
        parts += ["--threads", str(m.threads)]
    # Collapse newlines/multi-spaces: shlex treats them as plain whitespace,
    # but a single-line cmd keeps the generated YAML readable.
    extra = re.sub(r"\s+", " ", m.extra_flags).strip()
    if extra:
        parts.append(extra)
    return " ".join(parts)


def validate_models(models: list[SwapModel]) -> None:
    """Name/model rules the UI mirrors. Raises SwapConfigError."""
    seen: set[str] = set()
    for m in models:
        if not m.name.strip():
            raise SwapConfigError("a model needs a name")
        if m.name in seen:
            raise SwapConfigError(f"duplicate model name: {m.name}")
        seen.add(m.name)
        if not re.match(r"^[\w./-]+$", m.name):
            raise SwapConfigError(f"model name {m.name!r} should be a simple id (letters, digits, - _ . /)")
        if not m.model.strip():
            raise SwapConfigError(f"model {m.name}: a .gguf path is required")
        if m.ctx_size <= 0 or m.gpu_layers <= 0:
            raise SwapConfigError(f"model {m.name}: ctx-size and gpu-layers must be positive")
        if m.threads is not None and m.threads <= 0:
            raise SwapConfigError(f"model {m.name}: threads must be positive")


def render_yaml(models: list[SwapModel], llama_server: str) -> str:
    """Render the full llama-swap config as YAML (single-line cmd per model)."""
    validate_models(models)
    doc: dict = {"healthCheckTimeout": 120, "models": {}}
    for m in models:
        doc["models"][m.name] = {
            "aliases": [m.name],
            "cmd": build_cmd(m, llama_server),
        }
    return yaml.safe_dump(doc, sort_keys=False, default_flow_style=False, width=10000)


def parse_models(text: str) -> list[SwapModel]:
    """Parse a llama-swap config (generated or user-written) into model defs.

    Best-effort: known flags become fields, everything else (spec decoding,
    sampling, logging…) is preserved verbatim in `extra_flags` so an import
    round-trips without losing anything.
    """
    doc = yaml.safe_load(text)
    if not isinstance(doc, dict):
        return []
    models: list[SwapModel] = []
    for name, mc in (doc.get("models") or {}).items():
        cmd = mc.get("cmd", "") if isinstance(mc, dict) else str(mc or "")
        if not isinstance(cmd, str) or not cmd.strip():
            continue
        models.append(_parse_cmd(str(name), cmd))
    return models


def _parse_cmd(name: str, cmd: str) -> SwapModel:
    try:
        tokens = shlex.split(cmd, posix=False)
    except ValueError:
        tokens = cmd.split()
    known = {
        "--model": "model",
        "--mmproj": "mmproj",
        "--model-draft": "draft",
        "--ctx-size": "ctx_size",
        "--gpu-layers": "gpu_layers",
        "--threads": "threads",
        "--host": None,
        "--port": None,
    }
    m = SwapModel(name=name, model="")
    extra: list[str] = []
    i = 0
    first = True
    while i < len(tokens):
        tok = tokens[i]
        if first:
            first = False  # the exe path — abstracted away
            i += 1
            continue
        if tok in known:
            key = known[tok]
            if key is None:
                i += 2
                continue
            val = tokens[i + 1] if i + 1 < len(tokens) else ""
            # shlex(posix=False) keeps the surrounding double quotes
            if len(val) >= 2 and val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            if key == "ctx_size" or key == "gpu_layers" or key == "threads":
                try:
                    setattr(m, key, int(val))
                except ValueError:
                    setattr(m, key, None)
            else:
                setattr(m, key, val)
            i += 2
        else:
            extra.append(tok)
            i += 1
    m.extra_flags = " ".join(extra)
    return m
