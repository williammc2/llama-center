"""Runtime detection: OS, arch, CUDA presence.

Pure functions mirroring src/lib/detect.ts (same outputs, same rules).
In the pywebview shell we run on the real host, so detection is local;
in browser mode the UI does its own navigator-based detection.
"""
from __future__ import annotations

import platform
import subprocess
from dataclasses import dataclass, field
from typing import Optional

BACKENDS_BY_OS = {
    "win": ("cpu", "cuda", "vulkan", "rocm", "sycl", "opencl", "openvino"),
    "linux": ("cpu", "vulkan", "rocm", "sycl", "openvino", "opencl"),  # no CUDA assets
    "macos": ("cpu", "metal"),
}


@dataclass
class Detection:
    os: str  # "win" | "linux" | "macos" | "unknown"
    arch: str  # "x64" | "arm64" | "unknown"
    suggest_cuda: bool = False
    cuda_major_hint: Optional[int] = None  # 12 | 13, from the driver
    gpu_name: Optional[str] = None
    backends: tuple = field(default_factory=tuple)


def _map_os(system: str) -> str:
    s = (system or "").lower()
    if "darwin" in s:  # must precede "win" — 'darwin' contains it
        return "macos"
    if "win" in s:
        return "win"
    if "linux" in s:
        return "linux"
    return "unknown"


def _map_arch(machine: str) -> str:
    m = (machine or "").lower()
    if m in ("x86_64", "amd64", "x64"):
        return "x64"
    if m in ("aarch64", "arm64"):
        return "arm64"
    return "unknown"


def probe_nvidia(timeout_s: float = 3.0) -> Optional[tuple[int, str]]:
    """nvidia-smi probe → (cuda_major_hint, gpu_name) or None.

    Driver → max CUDA major: 580+ → 13, 525+ → 12, older → 12 (safe default).
    Only meaningful on Windows here; Linux CUDA users use Vulkan/ROCm builds
    (no ubuntu-cuda assets exist) so the hint is informational.
    """
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version,name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        if out.returncode != 0:
            return None
        line = out.stdout.strip().splitlines()[0]
        driver, _, name = line.partition(",")
        digits = "".join(c for c in driver.strip() if c.isdigit())
        major = int(digits) if digits else 0
        hint = 13 if major >= 580 else 12
        return (hint, name.strip())
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return None


def detect() -> Detection:
    system = platform.system()
    os_ = _map_os(system)
    arch = _map_arch(platform.machine())

    hint = None
    gpu = None
    if os_ == "win":
        probe = probe_nvidia()
        if probe:
            hint, gpu = probe

    return Detection(
        os=os_,
        arch=arch,
        suggest_cuda=(hint is not None),
        cuda_major_hint=hint,
        gpu_name=gpu,
        backends=BACKENDS_BY_OS.get(os_, ()),
    )
