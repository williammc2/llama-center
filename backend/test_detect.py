"""Tests for llama_center.detect — same rules as src/lib/detect.ts."""
from llama_center.detect import BACKENDS_BY_OS, _map_arch, _map_os, detect, probe_nvidia


class TestMapOs:
    def test_windows(self):
        assert _map_os("Windows") == "win"

    def test_linux(self):
        assert _map_os("Linux") == "linux"

    def test_darwin(self):
        assert _map_os("Darwin") == "macos"

    def test_unknown(self):
        assert _map_os("FreeBSD") == "unknown"


class TestMapArch:
    def test_x64(self):
        assert _map_arch("x86_64") == "x64"
        assert _map_arch("AMD64") == "x64"

    def test_arm64(self):
        assert _map_arch("aarch64") == "arm64"
        assert _map_arch("arm64") == "arm64"

    def test_unknown(self):
        assert _map_arch("riscv64") == "unknown"


class TestBackendsByOs:
    def test_linux_has_no_cuda(self):
        # The big one: no ubuntu-*-cuda-* assets exist in llama.cpp nightlies.
        assert "cuda" not in BACKENDS_BY_OS["linux"]

    def test_win_has_cuda(self):
        assert "cuda" in BACKENDS_BY_OS["win"]

    def test_every_offered_backend_per_os(self):
        for os_, backends in BACKENDS_BY_OS.items():
            assert len(backends) >= 1, os_


class TestDetect:
    def test_detect_returns_consistent_shape(self):
        d = detect()
        assert d.os in ("win", "linux", "macos", "unknown")
        assert d.arch in ("x64", "arm64", "unknown")
        assert tuple(d.backends) == BACKENDS_BY_OS.get(d.os, ())
        if d.os == "linux":
            assert "cuda" not in d.backends

    def test_probe_nvidia_returns_none_or_tuple(self):
        # No GPU on CI → None; on a dev box → (major, name).
        r = probe_nvidia(timeout_s=2)
        assert r is None or (isinstance(r, tuple) and r[0] in (12, 13))
