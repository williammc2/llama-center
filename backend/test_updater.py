"""Tests for llama_center.updater — real archives served by a local HTTP server."""
import hashlib
import io
import socket
import tarfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from llama_center import updater
from llama_center.updater import UpdateError


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def make_tar_gz(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class _Handler(BaseHTTPRequestHandler):
    files: dict[str, bytes] = {}

    def do_GET(self):
        data = self.files.get(self.path.lstrip("/"))
        if data is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    """Local HTTP server with real archives (flat zip, nested tar.gz) + /health."""
    files = {
        "flat.zip": make_zip({"llama-swap.exe": b"EXE-PAYLOAD-V1", "README.txt": b"hello"}),
        "nested.tar.gz": make_tar_gz(
            {"llama-swap/llama-swap": b"BIN-PAYLOAD-V2", "llama-swap/config.yaml": b"port: 8085"}
        ),
        "health": b"OK",
    }
    _Handler.files = files
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield {"port": port, "files": files}
    httpd.shutdown()
    httpd.server_close()


class TestDownload:
    def test_ok_with_matching_checksum(self, server, tmp_path):
        url = f"http://127.0.0.1:{server['port']}/flat.zip"
        dest = tmp_path / "out" / "flat.zip"
        updater.download(url, dest, sha256_bytes(server["files"]["flat.zip"]))
        assert dest.exists()
        assert updater.sha256_file(dest) == sha256_bytes(server["files"]["flat.zip"])
        assert not dest.with_name(dest.name + ".part").exists()

    def test_checksum_mismatch_cleans_up(self, server, tmp_path):
        url = f"http://127.0.0.1:{server['port']}/flat.zip"
        dest = tmp_path / "flat.zip"
        with pytest.raises(UpdateError, match="checksum mismatch"):
            updater.download(url, dest, "0" * 64)
        assert not dest.exists()
        assert not dest.with_name(dest.name + ".part").exists()

    def test_http_error(self, server, tmp_path):
        url = f"http://127.0.0.1:{server['port']}/missing.zip"
        with pytest.raises(UpdateError, match="HTTP 404"):
            updater.download(url, tmp_path / "missing.zip")


class TestExtract:
    def test_flat_zip_returns_dest(self, server, tmp_path):
        archive = tmp_path / "flat.zip"
        archive.write_bytes(server["files"]["flat.zip"])
        out = updater.extract(archive, tmp_path / "staging")
        assert out == tmp_path / "staging"
        assert (out / "llama-swap.exe").read_bytes() == b"EXE-PAYLOAD-V1"

    def test_nested_tar_returns_inner_dir(self, server, tmp_path):
        archive = tmp_path / "nested.tar.gz"
        archive.write_bytes(server["files"]["nested.tar.gz"])
        out = updater.extract(archive, tmp_path / "staging")
        assert out == tmp_path / "staging" / "llama-swap"
        assert (out / "llama-swap").read_bytes() == b"BIN-PAYLOAD-V2"
        assert (out / "config.yaml").read_bytes() == b"port: 8085"

    def test_replaces_previous_staging(self, server, tmp_path):
        archive = tmp_path / "flat.zip"
        archive.write_bytes(server["files"]["flat.zip"])
        dest = tmp_path / "staging"
        dest.mkdir(parents=True)
        (dest / "old.txt").write_text("stale")
        updater.extract(archive, dest)
        assert not (dest / "old.txt").exists()

    def test_unsupported_type(self, tmp_path):
        p = tmp_path / "x.rar"
        p.write_bytes(b"")
        with pytest.raises(UpdateError, match="unsupported"):
            updater.extract(p, tmp_path / "out")


def _stage(root: Path, content: bytes) -> Path:
    staging = root / "downloads" / "staging"
    staging.mkdir(parents=True, exist_ok=True)
    (staging / "llama-swap.exe").write_bytes(content)
    return staging


class TestSwap:

    def test_first_install_creates_live_no_backup(self, tmp_path):
        root = tmp_path / "root"
        d = updater.component_dirs(str(root))
        backup = updater.atomic_swap(d["live"], _stage(root, b"V1"), d["backups"])
        assert backup is None
        assert (d["live"] / "llama-swap.exe").read_bytes() == b"V1"

    def test_update_backs_up_and_prunes_to_keep(self, tmp_path):
        root = tmp_path / "root"
        d = updater.component_dirs(str(root))
        updater.atomic_swap(d["live"], _stage(root, b"V1"), d["backups"], label="v1")
        updater.atomic_swap(d["live"], _stage(root, b"V2"), d["backups"], label="v2")
        updater.atomic_swap(d["live"], _stage(root, b"V3"), d["backups"], label="v3")
        backups = updater.list_backups(d["backups"])
        assert len(backups) == 2  # keep=2
        assert (d["live"] / "llama-swap.exe").read_bytes() == b"V3"
        assert not any(b.startswith("llama-swap-v1-") for b in backups)  # oldest pruned
        assert any(b.startswith("llama-swap-v3-") for b in backups)

    def test_empty_staging_fails(self, tmp_path):
        root = tmp_path / "root"
        d = updater.component_dirs(str(root))
        empty = root / "downloads" / "staging"
        empty.mkdir(parents=True, exist_ok=True)
        with pytest.raises(UpdateError, match="staging"):
            updater.atomic_swap(d["live"], empty, d["backups"])


class TestRollback:
    def test_rollback_restores_newest_backup(self, tmp_path):
        root = tmp_path / "root"
        d = updater.component_dirs(str(root))
        updater.atomic_swap(d["live"], _stage(root, b"V1"), d["backups"], label="v1")
        updater.atomic_swap(d["live"], _stage(root, b"V2"), d["backups"], label="v2")
        assert (d["live"] / "llama-swap.exe").read_bytes() == b"V2"
        assert updater.rollback(d["live"], d["backups"]) is True
        assert (d["live"] / "llama-swap.exe").read_bytes() == b"V1"
        # the failed V2 install is parked, not lost
        parked = [p for p in d["backups"].iterdir() if p.name.endswith(".failed")]
        assert len(parked) == 1
        # parked installs don't show up as rollable backups
        assert not any(n.endswith(".failed") for n in updater.list_backups(d["backups"]))

    def test_rollback_without_backups(self, tmp_path):
        d = updater.component_dirs(str(tmp_path / "root"))
        assert updater.rollback(d["live"], d["backups"]) is False


class TestProbe:
    def test_probe_open_port(self, server):
        assert updater.probe_port(server["port"]) is True

    def test_probe_closed_port(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        assert updater.probe_port(port) is False

    def test_health_ok(self, server):
        assert updater.health_ok(server["port"]) is True

    def test_health_bad_port(self):
        assert updater.health_ok(1) is False


class TestStop:
    def test_windows_command(self, monkeypatch):
        calls = []

        class R:
            returncode = 0

        def run(cmd, **kw):
            calls.append(cmd)
            return R()

        monkeypatch.setattr(updater.subprocess, "run", run)
        monkeypatch.setattr(updater.os, "name", "nt")
        assert updater.stop_llama_swap() is True
        assert calls == [["taskkill", "/IM", "llama-swap.exe", "/F"]]

    def test_posix_command(self, monkeypatch):
        calls = []

        class R:
            returncode = 0

        def run(cmd, **kw):
            calls.append(cmd)
            return R()

        monkeypatch.setattr(updater.subprocess, "run", run)
        monkeypatch.setattr(updater.os, "name", "posix")
        assert updater.stop_llama_swap() is True
        assert calls == [["pkill", "-f", "llama-swap"]]

    def test_no_process_returns_false(self, monkeypatch):
        class R:
            returncode = 1

        monkeypatch.setattr(updater.subprocess, "run", lambda cmd, **kw: R())
        assert updater.stop_llama_swap() is False
