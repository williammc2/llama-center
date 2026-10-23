"""Tests for the pywebview Api surface (main.py) — the camelCase boundary."""
import hashlib
import io
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
        from llama_center import api as apimod

        calls: list[bool] = []
        monkeypatch.setattr(apimod.autostart, "apply", lambda enabled: calls.append(enabled))
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
        assert set(d) == {"os", "arch", "suggestCuda", "backends"}
        assert isinstance(d["backends"], list)

    def test_key_mapping_includes_llama_swap_installed(self):
        api = Api()
        snake = api._from_camel({"llamaSwapInstalled": 253})
        assert snake["llama_swap_installed"] == 253
        from llama_center.config import parse_config

        cfg = parse_config({"version": 1, "llama_swap_installed": 253})
        assert api._to_camel(cfg)["llamaSwapInstalled"] == 253

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

            url = f"http://127.0.0.1:{port}/llama-swap_999_windows_amd64.zip"
            res = api.download_and_stage("llama-swap", url, sha)
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

    def test_stop_without_process(self, home, monkeypatch):
        # Mock the by-name killer: without it, the real `taskkill /IM
        # llama-swap.exe /F` would murder the developer's own local
        # llama-swap (tests must not touch host state).
        monkeypatch.setattr(
            "llama_center.updater.stop_llama_swap", lambda: False, raising=False
        )
        res = Api().stop_llama_swap()
        assert res["stopped"] is False
        assert res["exitCode"] is None

    def test_restart_not_running(self, home):
        res = Api().restart_llama_swap()
        assert res.get("error") == "not-running"

    def test_restart_stops_then_starts(self, home, monkeypatch):
        """One action: stop the managed process, then start again."""

        class _FakeManaged:
            running = True
            pid = 1234
            stopped = False
            flushed = False

            def stop(self, timeout=10.0):
                self.stopped = True
                return 0

            def flush(self, timeout=2.0):
                self.flushed = True

        fake = _FakeManaged()
        api = Api()
        api._managed = fake
        started = {}

        def fake_start(self):
            started["called"] = True
            return {"pid": 9999}

        monkeypatch.setattr("llama_center.api.ProcessApi.start_llama_swap", fake_start)
        res = api.restart_llama_swap()
        assert res == {"pid": 9999}
        assert fake.stopped and fake.flushed and started["called"]


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
        # and back
        from llama_center.config import parse_config

        cfg = parse_config(snake)
        out = api._to_camel(cfg)
        assert out["cudaMajor"] == 12
        assert out["autoStartLlamaSwap"] is True
        assert out["closeToTray"] is False


class TestModelApi:
    """HF discovery + download + the speed probe."""

    def test_list_hf_files_filters_gguf(self, home, monkeypatch):
        from llama_center import api as apimod

        captured = {}

        class _Resp:
            status_code = 200

            def json(self):
                return [
                    {"type": "file", "path": "model-Q4_K_M.gguf", "size": 100},
                    {"type": "file", "path": "model-Q5_K_M.gguf", "size": 200},
                    {"type": "file", "path": "README.md", "size": 5},
                    {"type": "directory", "path": "sub", "size": 0},
                ]

        def fake_get(url, headers=None, timeout=None):
            captured["url"] = url
            captured["headers"] = headers
            return _Resp()

        monkeypatch.setattr(apimod.requests, "get", fake_get)
        res = Api().list_hf_files("org/model")
        assert captured["url"] == "https://huggingface.co/api/models/org/model/tree/main"
        assert res["files"] == [
            {"name": "model-Q4_K_M.gguf", "size": 100},
            {"name": "model-Q5_K_M.gguf", "size": 200},
        ]

    def test_list_hf_files_marks_downloaded(self, home, monkeypatch):
        """A file already in <install_dir>/models/<repo>/ is flagged, with its path."""
        from llama_center import api as apimod

        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})
        # Simulate a previous download of the Q4 file.
        local = root / "models" / "org" / "model"
        local.mkdir(parents=True)
        (local / "model-Q4_K_M.gguf").write_bytes(b"x")

        class _Resp:
            status_code = 200

            def json(self):
                return [
                    {"type": "file", "path": "model-Q4_K_M.gguf", "size": 100},
                    {"type": "file", "path": "model-Q5_K_M.gguf", "size": 200},
                ]

        monkeypatch.setattr(apimod.requests, "get", lambda *a, **k: _Resp())
        res = Api().list_hf_files("org/model")
        by_name = {f["name"]: f for f in res["files"]}
        assert by_name["model-Q4_K_M.gguf"]["downloaded"] is True
        assert by_name["model-Q4_K_M.gguf"]["localPath"].endswith("model-Q4_K_M.gguf")
        assert "downloaded" not in by_name["model-Q5_K_M.gguf"]

    def test_list_hf_files_sends_token_when_set(self, home, monkeypatch):
        from llama_center import api as apimod

        captured = {}

        class _Resp:
            status_code = 200

            def json(self):
                return []

        def fake_get(url, headers=None, timeout=None):
            captured["headers"] = headers
            return _Resp()

        monkeypatch.setattr(apimod.requests, "get", fake_get)
        Api().save_config({"version": 1, "installDir": str(home / "root"), "hfToken": "hf_abc"})
        Api().list_hf_files("org/model")
        assert captured["headers"] == {"Authorization": "Bearer hf_abc"}

    def test_list_hf_files_404(self, home, monkeypatch):
        from llama_center import api as apimod

        class _Resp:
            status_code = 404

        monkeypatch.setattr(apimod.requests, "get", lambda *a, **k: _Resp())
        res = Api().list_hf_files("org/nope")
        assert "not found" in res["error"]

    def test_download_hf_file_downloads_to_models_dir(self, home, monkeypatch):
        """URL construction + dest dir. Byte-copying is covered by the
        updater tests, so we stub download and assert where it's pointed."""
        from llama_center import api as apimod

        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})

        captured = {}

        def fake_download(url, dest, sha, timeout=60.0, progress=None):
            captured["url"] = url
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"GGUF-BYTES")
            return dest

        monkeypatch.setattr(apimod.updater, "download", fake_download)
        res = Api().download_hf_file("org/model", "model.gguf")
        assert "path" in res, res
        p = Path(res["path"])
        assert p == root / "models" / "org" / "model" / "model.gguf"
        assert captured["url"].endswith("/org/model/resolve/main/model.gguf")
        assert p.read_bytes() == b"GGUF-BYTES"

    def test_list_hf_files_marks_downloaded_in_extra_root(self, home, monkeypatch):
        """A copy in an extra model root (Settings) is flagged too."""
        from llama_center import api as apimod

        root = home / "root"
        extra = home / "extra"
        Api().save_config({"version": 1, "installDir": str(root), "modelDirs": [str(extra)]})
        (extra / "org" / "model").mkdir(parents=True)
        (extra / "org" / "model" / "model-Q4_K_M.gguf").write_bytes(b"x")

        class _Resp:
            status_code = 200

            def json(self):
                return [{"type": "file", "path": "model-Q4_K_M.gguf", "size": 100}]

        monkeypatch.setattr(apimod.requests, "get", lambda *a, **k: _Resp())
        res = Api().list_hf_files("org/model")
        f = res["files"][0]
        assert f["downloaded"] is True
        assert f["localPath"].replace("\\", "/").endswith("extra/org/model/model-Q4_K_M.gguf")

    def test_list_model_files_groups_by_repo(self, home):
        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})
        d = root / "models" / "org" / "model"
        d.mkdir(parents=True)
        (d / "a.gguf").write_bytes(b"1")
        (d / "b.gguf").write_bytes(b"12")
        (root / "models" / "loose.gguf").write_bytes(b"123")
        res = Api().list_model_files()
        assert res["roots"] == [str(root / "models")]
        by_name = {f["name"]: f for f in res["files"]}
        assert set(by_name) == {"a.gguf", "b.gguf", "loose.gguf"}
        assert by_name["a.gguf"]["repo"] == "org/model"
        assert by_name["loose.gguf"]["repo"] == ""
        assert by_name["a.gguf"]["size"] == 1

    def test_list_model_files_includes_extra_roots(self, home):
        root = home / "root"
        extra = home / "extra"
        Api().save_config({"version": 1, "installDir": str(root), "modelDirs": [str(extra)]})
        (extra / "org" / "model").mkdir(parents=True)
        (extra / "org" / "model" / "big.gguf").write_bytes(b"x")
        res = Api().list_model_files()
        assert res["roots"] == [str(root / "models"), str(extra)]
        f = res["files"][0]
        assert f["name"] == "big.gguf"
        assert f["repo"] == "org/model"

    def test_delete_model_file(self, home):
        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})
        d = root / "models" / "org" / "model"
        d.mkdir(parents=True)
        (d / "a.gguf").write_bytes(b"1")
        (d / "b.gguf").write_bytes(b"1")
        res = Api().delete_model_file(str(d / "a.gguf"))
        assert res == {"deleted": 1}
        assert not (d / "a.gguf").exists()
        assert (d / "b.gguf").exists()
        assert "not found" in Api().delete_model_file(str(d / "a.gguf"))["error"]

    def test_delete_model_file_whole_repo(self, home):
        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})
        d = root / "models" / "org" / "model"
        d.mkdir(parents=True)
        (d / "a.gguf").write_bytes(b"1")
        (d / "b.gguf").write_bytes(b"1")
        res = Api().delete_model_file(str(d / "a.gguf"), whole_repo=True)
        assert res == {"deleted": 2}
        assert not d.exists()

    def test_delete_model_file_loose_at_root(self, home):
        # A loose file at the root of the default models dir has no repo folder
        # to wipe — deleting the whole "folder" must not remove the root itself.
        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})
        (root / "models" / "other").mkdir(parents=True)
        (root / "models" / "other" / "x.gguf").write_bytes(b"1")
        (root / "models" / "loose.gguf").write_bytes(b"1")
        res = Api().delete_model_file(str(root / "models" / "loose.gguf"), whole_repo=True)
        assert res["error"].startswith("cannot remove the model root")
        # The file survives — the root is not touched.
        assert (root / "models" / "loose.gguf").exists()
        assert (root / "models" / "other" / "x.gguf").exists()

    def test_export_llama_swap_config(self, home):
        root = home / "root"
        Api().save_config({"version": 1, "installDir": str(root)})
        import os

        (root / "llama-cpp").mkdir(parents=True)
        server = "llama-server.exe" if os.name == "nt" else "llama-server"
        (root / "llama-cpp" / server).write_bytes(b"x")
        Api().save_llama_swap_config(
            [
                {
                    "name": "m1",
                    "model": "C:\\m.gguf",
                    "ctxSize": 4096,
                    "gpuLayers": 999,
                    "extraFlags": "",
                }
            ]
        )
        out = home / "out" / "export.yaml"
        res = Api().export_llama_swap_config(str(out))
        assert "path" in res, res
        assert out.read_text(encoding="utf-8") == (
            root / "llama-swap" / "llama-swap.yaml"
        ).read_text(encoding="utf-8")


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
    import functools
    from http.server import HTTPServer, SimpleHTTPRequestHandler

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(root))
    server = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
