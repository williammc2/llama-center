"""llama-swap update mechanics: download, verify, extract, swap, rollback.

Pure fs + HTTP, no app state — the Api layer (main.py) resolves install_dir
from config.json and calls these. Tested against a local HTTP server.

Layout under install_dir (per component — "llama-swap" or "llama-cpp"):
    <component>/                    live install
    downloads/                      archives (staging area, shared)
    downloads/staging-<component>/  extracted content, ready to swap
    backups/<component>/            previous installs, timestamped, last `keep`

The decision side (which asset, expected SHA-256) lives in TS —
src/lib/llamaSwapRelease.ts / llamaCppNightly.ts. Python only does the bytes.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

import requests

KEEP_BACKUPS = 2
CHUNK = 1 << 16  # 64 KiB


class UpdateError(Exception):
    """Anything that aborts an update, with a user-readable message."""


def component_dirs(install_dir: str, component: str = "llama-swap") -> dict[str, Path]:
    """The managed paths for one install root + component."""
    root = Path(install_dir)
    return {
        "live": root / component,
        "downloads": root / "downloads",
        "staging": root / "downloads" / f"staging-{component}",
        "backups": root / "backups" / component,
        "logs": root / "logs",
    }


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(
    url: str,
    dest: Path,
    expected_sha256: str | None = None,
    timeout: float = 60.0,
    progress: "callable | None" = None,
) -> Path:
    """Stream `url` to `dest` (via a .part file), verify SHA-256, rename into place.

    Raises UpdateError on HTTP failure or checksum mismatch (the .part file is
    removed either way, so a retry never sees a half-written archive).

    `progress(received_bytes, total_bytes_or_None)` is called at most ~4x/s
    (and once on completion) — total is null when the server sends no
    Content-Length.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    try:
        with requests.get(url, stream=True, timeout=timeout) as r:
            if r.status_code != 200:
                raise UpdateError(f"download: HTTP {r.status_code} for {url}")
            clen = r.headers.get("content-length")
            total = int(clen) if clen and clen.isdigit() else None
            received = 0
            last_report = 0.0
            with open(part, "wb") as f:
                for chunk in r.iter_content(chunk_size=CHUNK):
                    f.write(chunk)
                    received += len(chunk)
                    if progress is not None:
                        now = time.monotonic()
                        if received == total or now - last_report >= 0.25:
                            progress(received, total)
                            last_report = now
    except requests.RequestException as e:
        part.unlink(missing_ok=True)
        raise UpdateError(f"download: {e}") from e
    if expected_sha256:
        actual = sha256_file(part)
        if actual != expected_sha256.lower():
            part.unlink(missing_ok=True)
            raise UpdateError(f"checksum mismatch: expected {expected_sha256.lower()}, got {actual}")
    if dest.exists():
        dest.unlink()
    part.replace(dest)
    return dest


def _flatten(dest: Path) -> Path:
    """If extraction produced exactly one top-level directory, return it."""
    entries = [p for p in dest.iterdir() if not p.name.startswith(".")]
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return dest


def extract(archive: Path, dest: Path, merge: bool = False) -> Path:
    """Extract a zip / tar.gz into `dest` (replacing any previous staging).

    Returns the directory that holds the payload: `dest` itself for flat
    archives, the single top-level folder when the archive nests one.

    `merge=True` extracts INTO an existing directory without wiping it — used
    to combine a second archive (e.g. the Windows CUDA DLLs zip) with the
    primary payload.
    """
    if not merge and dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    name = archive.name.lower()
    try:
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                z.extractall(dest)
        elif name.endswith(".tar.gz"):
            with tarfile.open(archive, "r:gz") as t:
                t.extractall(dest)
        else:
            raise UpdateError(f"extract: unsupported archive type {archive.name}")
    except (zipfile.BadZipFile, tarfile.TarError, OSError) as e:
        raise UpdateError(f"extract: {e}") from e
    if merge:
        return dest
    return _flatten(dest)


def _backup_name(component: str, label: str | None) -> str:
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    safe = (label or "unknown").replace("/", "-")
    return f"{component}-{safe}-{ts}"


def atomic_swap(
    live: Path,
    staging_content: Path,
    backups: Path,
    keep: int = KEEP_BACKUPS,
    label: str | None = None,
    component: str = "llama-swap",
) -> str | None:
    """Move staged content into `live`; the previous live goes to `backups`.

    `label` (e.g. "v253" / "b10816") records what is being replaced, so a
    later rollback can restore the version. Returns the backup dir name, or
    None on a first install (nothing to back up). Prunes backups older than
    `keep`.
    """
    if not staging_content.is_dir() or not any(staging_content.iterdir()):
        raise UpdateError("swap: staging is missing or empty")
    backups.mkdir(parents=True, exist_ok=True)
    backup_name = None
    if live.exists():
        backup_name = _backup_name(component, label)
        shutil.move(str(live), str(backups / backup_name))
    live.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(staging_content), str(live))
    existing = sorted(
        (p for p in backups.iterdir() if p.is_dir()),
        key=lambda p: p.name,
        reverse=True,
    )
    for old in existing[keep:]:
        shutil.rmtree(old, ignore_errors=True)
    return backup_name


def list_backups(backups: Path) -> list[str]:
    """Backup dir names, newest first (timestamped names sort chronologically)."""
    if not backups.is_dir():
        return []
    return sorted(
        (
            p.name
            for p in backups.iterdir()
            if p.is_dir() and not p.name.startswith(".") and not p.name.endswith(".failed")
        ),
        reverse=True,
    )


def rollback(live: Path, backups: Path) -> bool:
    """Restore the newest backup into `live`. False when no backup exists.

    The failed live install is parked next to the backups (`.failed` suffix)
    so nothing is lost.
    """
    names = list_backups(backups)
    if not names:
        return False
    backup = backups / names[0]
    if live.exists():
        shutil.move(str(live), str(backups / (names[0] + ".failed")))
    shutil.move(str(backup), str(live))
    return True


def probe_port(port: int, host: str = "127.0.0.1", timeout: float = 1.0) -> bool:
    """True when something accepts a TCP connection on host:port."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def health_ok(port: int, host: str = "127.0.0.1", timeout: float = 2.0) -> bool:
    """llama-swap liveness: GET /health returns 200 (it answers "OK")."""
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def stop_llama_swap() -> bool:
    """Best-effort stop of a running llama-swap, by image name.

    True when a process was actually killed. Windows: `taskkill /IM`;
    POSIX: `pkill -f`. Returns False when nothing matched (or the tool is
    missing) — callers treat that as "port still busy, ask the user".
    """
    if os.name == "nt":
        cmd = ["taskkill", "/IM", "llama-swap.exe", "/F"]
    else:
        cmd = ["pkill", "-f", "llama-swap"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=15)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
