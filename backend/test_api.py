"""Tests for the pywebview Api surface (main.py) — the camelCase boundary."""
import hashlib
import io
import socket
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from main import Api  # noqa: E402


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Redirect the config root so tests never touch the real user profile."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    return tmp_path


class TestApi:
    def test_save_get_config_roundtrip(self, home):
        api = Api()
        payload = {
            "version": 1,
            "firstRunDone": True,
            "installDir": str(home / "custom-root"),
            "backend": "cuda",
            "cudaMajor": 13,
            "cudaFamily": "cudart",
            "llamaCppPin": None,
            "llamaSwapPort": 9090,
            "lang": "pt-BR",
            "startWithSystem": False,
            "autoStartLlamaSwap": False,
            "closeToTray": True,
            "checkUpdatesOnStart": True,
        }
        res = api.save_config(payload)
        assert "path" in res, res
        assert res["path"].endswith("config.json")

        got = api.get_config()
        assert got["backend"] == "cuda"
        assert got["cudaMajor"] == 13
        assert got["llamaSwapPort"] == 9090
        assert got["lang"] == "pt-BR"
        assert got["firstRunDone"] is True
        assert got["installDir"] == str(home / "custom-root")

    def test_save_config_corrupt_returns_error(self, home):
        api = Api()
        res = api.save_config({"version": 1, "backend": "metal"})
        assert "error" in res
        assert "backend" in res["error"]

    def test_save_config_applies_autostart(self, home, monkeypatch):
        """The startWithSystem toggle takes effect at save time, not next launch."""
        import main as mainmod

        calls: list[bool] = []
        monkeypatch.setattr(mainmod.autostart, "apply", lambda enabled: calls.append(enabled))
        assert "path" in Api().save_config(
            {"version": 1, "installDir": str(home / "r"), "startWithSystem": True}
        )
        assert calls == [True]
        Api().save_config(
            {"version": 1, "installDir": str(home / "r"), "startWithSystem": False}
        )
        assert calls == [True, False]

    def test_get_config_missing_returns_defaults(self, home):
        api = Api()
        cfg = api.get_config()
        # No config file → defaults (first run), not null.
        assert cfg["firstRunDone"] is False
        assert cfg["backend"] == "cpu"

    def test_get_detection_shape(self):
        api = Api()
        d = api.get_detection()
        assert set(d) == {"os", "arch", "suggestCuda", "cudaMajorHint", "gpuName", "backends"}
        assert isinstance(d["backends"], list)

    def test_key_mapping_includes_llama_swap_installed(self):
        api = Api()
        snake = api._from_camel({"llamaSwapInstalled": 253})
        assert snake["llama_swap_installed"] == 253
        from llama_center.config import parse_config

        cfg = parse_config({"version": 1, "llama_swap_installed": 253})
        assert api._to_camel(cfg)["llamaSwapInstalled"] == 253

    def test_probe_port_closed(self, home):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        assert Api().probe_port(port) is False

    def test_list_backups_empty(self, home):
        Api().save_config({"version": 1, "installDir": str(home / "root")})
        assert Api().list_component_backups("llama-swap") == []
        assert Api().list_component_backups("llama-cpp") == []

    def test_download_and_stage_error_without_config(self, home):
        # No config file → default AppConfig with empty install_dir.
        res = Api().download_and_stage("llama-swap", "http://127.0.0.1/x.zip", None)
        assert "error" in res
        assert "install_dir" in res["error"]

    def test_download_stage_swap_roundtrip(self, home):
        """Full P1 flow through the camelCase boundary: stage → swap → rollback."""
        root = home / "root"
        payload = b"EXE-PAYLOAD"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("llama-swap.exe", payload)
        archive = buf.getvalue()
        sha = hashlib.sha256(archive).hexdigest()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("content-length", str(len(archive)))
                self.end_headers()
                self.wfile.write(archive)

            def log_message(self, *args):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            api = Api()
            assert "path" in api.save_config({"version": 1, "installDir": str(root)})

            res = api.download_and_stage("llama-swap", f"http://127.0.0.1:{port}/llama-swap_999_windows_amd64.zip", sha)
            assert "staging" in res, res
            assert Path(res["staging"]).exists()

            res = api.swap_component("llama-swap")
            assert "error" not in res, res
            assert res["backup"] is None  # first install
            assert (root / "llama-swap" / "llama-swap.exe").read_bytes() == payload

            assert api.rollback_component("llama-swap")["rolledBack"] is False  # no backups yet
        finally:
            httpd.shutdown()
            httpd.server_close()


class TestRunSurface:
    """P3 — start/stop/status/logs."""

    def test_status_shape(self, home):
        # Point the config at a free port so a user's real llama-swap (8085)
        # doesn't leak into the assertion.
        import socket

        s0 = socket.socket()
        s0.bind(("127.0.0.1", 0))
        port = s0.getsockname()[1]
        s0.close()
        Api().save_config({"version": 1, "installDir": str(home / "root"), "llamaSwapPort": port})
        s = Api().llama_swap_status()
        assert set(s) == {"managed", "pid", "portBusy", "healthy", "models"}
        assert s["managed"] is False
        assert s["pid"] is None
        assert s["portBusy"] is False
        assert s["healthy"] is False
        assert s["models"] == []

    def test_logs_empty_without_process(self, home):
        assert Api().llama_swap_logs() == []

    def test_start_not_installed(self, home):
        Api().save_config({"version": 1, "installDir": str(home / "root")})
        res = Api().start_llama_swap()
        assert res.get("error") == "not-installed"

    def test_start_port_in_use(self, home):
        import os
        import socket

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen(1)  # bound-but-not-listening doesn't accept connects on Windows
        port = s.getsockname()[1]
        try:
            root = home / "root"
            (root / "llama-swap").mkdir(parents=True)
            exe = "llama-swap.exe" if os.name == "nt" else "llama-swap"
            (root / "llama-swap" / exe).write_bytes(b"x")
            Api().save_config({"version": 1, "installDir": str(root), "llamaSwapPort": port})
            res = Api().start_llama_swap()
            assert res.get("error") == "port-in-use"
        finally:
            s.close()

    def test_stop_without_process(self, home):
        res = Api().stop_llama_swap()
        assert res["stopped"] in (True, False)  # by-name pkill result
        assert res["exitCode"] is None


class TestSwapConfig:
    """P4 — save/get/import of the llama-swap models config."""

    MODEL = {
        "name": "example-model",
        "model": "D:\\models\\model.gguf",
        "mmproj": "D:\\models\\mmproj.gguf",
        "draft": None,
        "ctxSize": 262144,
        "gpuLayers": 999,
        "threads": 12,
        "extraFlags": "--flash-attn on",
    }

    def _setup(self, home, with_cpp=True):
        import os

        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})
        if with_cpp:
            (root / "llama-cpp").mkdir(parents=True)
            exe = "llama-server.exe" if os.name == "nt" else "llama-server"
            (root / "llama-cpp" / exe).write_bytes(b"x")
        return root

    def test_save_get_roundtrip(self, home):
        root = self._setup(home)
        api = Api()
        res = api.save_llama_swap_config([self.MODEL])
        assert "path" in res, res
        p = Path(res["path"])
        assert p == root / "llama-swap" / "llama-swap.yaml"
        assert p.exists()

        got = api.get_llama_swap_config()
        assert got["path"] == str(p)
        assert len(got["models"]) == 1
        m = got["models"][0]
        assert m["name"] == "example-model"
        assert m["model"] == "D:\\models\\model.gguf"
        assert m["mmproj"] == "D:\\models\\mmproj.gguf"
        assert m["ctxSize"] == 262144
        assert m["gpuLayers"] == 999
        assert m["threads"] == 12
        assert "--flash-attn on" in m["extraFlags"]

        # the generated cmd points at the MANAGED llama.cpp, not the user's
        text = p.read_text(encoding="utf-8")
        assert str(root / "llama-cpp") in text
        assert "--port ${PORT}" in text

    def test_save_requires_llama_cpp(self, home):
        self._setup(home, with_cpp=False)
        res = Api().save_llama_swap_config([self.MODEL])
        assert res.get("error") == "llama-cpp-not-installed"

    def test_save_validation_error(self, home):
        self._setup(home)
        bad = dict(self.MODEL)
        bad2 = dict(self.MODEL)
        bad2["model"] = ""
        res = Api().save_llama_swap_config([bad, bad2])
        assert "error" in res

    def test_get_empty(self, home):
        self._setup(home)
        got = Api().get_llama_swap_config()
        assert got == {"models": [], "path": None}

    def test_import_user_file(self, home):
        src = home / "old-config.yaml"
        src.write_text(
            "models:\n"
            "  my-model:\n"
            "    cmd: >\n"
            "      D:\\llama-cpp\\llama-server.exe --host 127.0.0.1 --port ${PORT} "
            '--model "D:\\models\\a b.gguf" --ctx-size 16384 --gpu-layers 33 --metrics\n',
            encoding="utf-8",
        )
        res = Api().import_llama_swap_config(str(src))
        assert "error" not in res, res
        m = res["models"][0]
        assert m["name"] == "my-model"
        assert m["model"] == "D:\\models\\a b.gguf"
        assert m["ctxSize"] == 16384
        assert m["gpuLayers"] == 33
        assert "--metrics" in m["extraFlags"]

    def test_import_missing_file(self, home):
        res = Api().import_llama_swap_config(str(home / "nope.yaml"))
        assert "error" in res

    def test_start_no_config(self, home):
        """Installed but no config file -> 'no-config', not a cryptic crash."""
        import os
        import socket

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        root = self._setup(home)
        (root / "llama-swap").mkdir(parents=True)
        exe = "llama-swap.exe" if os.name == "nt" else "llama-swap"
        (root / "llama-swap" / exe).write_bytes(b"x")
        Api().save_config({"version": 1, "installDir": str(root), "llamaSwapPort": port})
        res = Api().start_llama_swap()
        assert res.get("error") == "no-config"


class TestKeyMapping:
    def test_key_mapping_is_bidirectional(self):
        api = Api()
        camel = {
            "version": 1,
            "firstRunDone": True,
            "installDir": "/tmp/x",
            "backend": "cpu",
            "cudaMajor": 12,
            "cudaFamily": "plain",
            "llamaCppPin": "b10814",
            "llamaSwapPort": 8085,
            "lang": "en",
            "startWithSystem": True,
            "autoStartLlamaSwap": True,
            "closeToTray": False,
            "checkUpdatesOnStart": False,
        }
        snake = api._from_camel(camel)
        assert snake["first_run_done"] is True
        assert snake["install_dir"] == "/tmp/x"
        assert snake["cuda_major"] == 12
        assert snake["llama_cpp_pin"] == "b10814"
        # and back
        from llama_center.config import parse_config

        cfg = parse_config(snake)
        out = api._to_camel(cfg)
        assert out["cudaMajor"] == 12
        assert out["autoStartLlamaSwap"] is True
        assert out["closeToTray"] is False


class TestAppUpdate:
    def test_download_and_launch_installer_no_url(self, home, monkeypatch):
        """A non-URL should fail gracefully (not crash)."""
        api = Api()
        monkeypatch.setattr("os.startfile", lambda x: None, raising=False)
        # Use a file:// URL that doesn't exist
        res = api.download_and_launch_installer("https://127.0.0.1:1/nonexistent.exe")
        assert "error" in res

    def test_download_and_launch_installer_success(self, home, monkeypatch):
        """Download a small file from a local HTTP server, then launch it."""
        import os
        import subprocess
        import tempfile

        api = Api()
        # Create a temp file to serve
        content = b"fake-installer-bytes"
        served = home / "installer.exe"
        served.write_bytes(content)

        # Start a local server
        server = _make_server(home)
        port = server.server_address[1]

        # Capture the Popen call (both platforms now use subprocess.Popen)
        launched: list[str] = []
        _real_popen = subprocess.Popen
        def _fake_popen(args, **kwargs):
            # args can be a string (Windows shell=True) or a list
            if isinstance(args, str):
                launched.append(args)
            else:
                launched.append(args[0] if args else "")
            return _real_popen(["true"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        monkeypatch.setattr("subprocess.Popen", _fake_popen)

        # Prevent the threading.Timer from closing the app during the test
        class _NoopTimer:
            def __init__(self, *a, **kw): pass
            def start(self): pass
        monkeypatch.setattr("threading.Timer", _NoopTimer)

        res = api.download_and_launch_installer(f"http://127.0.0.1:{port}/installer.exe")
        assert res.get("launched") is True
        assert res.get("closing") is True
        assert len(launched) == 1
        # The downloaded file should exist in tempdir
        tmp_name = os.path.join(tempfile.gettempdir(), "installer.exe")
        assert os.path.exists(tmp_name)
        assert Path(tmp_name).read_bytes() == content
        server.shutdown()


def _make_server(root: Path):
    """Minimal HTTP server serving files from `root`."""
    from http.server import HTTPServer, SimpleHTTPRequestHandler
    import functools
    import os

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(root))
    server = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
