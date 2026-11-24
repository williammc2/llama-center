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
import sys
import tarfile
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import requests

# Download progress callback: (received_bytes, total_bytes_or_None).
ProgressFn = Callable[[int, "int | None"], None]
# Hook that stops the managed llama-swap (used by launch_installer).
StopFn = Callable[[], None]

KEEP_BACKUPS = 2
CHUNK = 1 << 16  # 64 KiB

# User-managed files/dirs that live inside the live dir but are NOT part of
# the release payload — they must survive a swap (and a rollback).
PRESERVED_CONFIGS = {
    "llama-swap": ("llama-swap.yaml", "llama-swap.json"),
    "basalt": ("basalt_config.json", "models"),
}
DEFAULT_PRESERVED = ("llama-swap.yaml", "llama-swap.json")


def _preserve_names(component: str) -> tuple[str, ...]:
    return PRESERVED_CONFIGS.get(component, DEFAULT_PRESERVED)


def _saved_configs(live: Path, component: str) -> dict[str, Path]:
    """Snapshot preserved files/dirs to a temp dir. {name: snapshot_path}."""
    tmp = live.parent / f".preserve-{time.time_ns()}"
    tmp.mkdir(parents=True, exist_ok=True)
    saved: dict[str, Path] = {}
    for name in _preserve_names(component):
        p = live / name
        if p.is_file():
            dest = tmp / name
            dest.write_bytes(p.read_bytes())
            saved[name] = dest
        elif p.is_dir():
            dest = tmp / name
            shutil.copytree(str(p), str(dest))
            saved[name] = dest
    return saved


def _restore_configs(live: Path, saved: dict[str, Path]) -> None:
    for name, src in saved.items():
        dst = live / name
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src), str(dst))
        elif src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(str(src), str(dst))
    if saved:
        tmp = next(iter(saved.values())).parent
        shutil.rmtree(tmp, ignore_errors=True)


class UpdateError(Exception):
    """Anything that aborts an update, with a user-readable message."""


@dataclass(frozen=True)
class ComponentDirs:
    """The managed paths for one install root + component.

    Typed instead of a dict of strings: a typo in a key is a type error,
    not a runtime KeyError.
    """

    live: Path
    downloads: Path
    staging: Path
    backups: Path
    logs: Path


def component_dirs(install_dir: str, component: str = "llama-swap") -> ComponentDirs:
    """The managed paths for one install root + component."""
    root = Path(install_dir)
    return ComponentDirs(
        live=root / component,
        downloads=root / "downloads",
        staging=root / "downloads" / f"staging-{component}",
        backups=root / "backups" / component,
        logs=root / "logs",
    )


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
    progress: ProgressFn | None = None,
) -> Path:
    """Stream `url` to `dest` (via a .part file), verify SHA-256, rename into place.

    A leftover `.part` is resumed (Range request, append mode) — a dropped
    download continues instead of restarting. On network failure the .part
    is kept for the next attempt; on checksum mismatch it is removed.

    `progress(received_bytes, total_bytes_or_None)` is called at most ~4x/s
    (and once on completion) — total is null when the server sends no
    Content-Length.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    # Resume: a leftover .part from a dropped download is continued via a
    # Range request (HF and GitHub releases both support it). A 200 (server
    # ignored Range) restarts from zero; a 206 appends to the partial file.
    # The final SHA-256 check still guards integrity either way.
    resume_from = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={resume_from}-"} if resume_from else {}
    try:
        with requests.get(url, stream=True, timeout=timeout, headers=headers) as r:
            if r.status_code not in (200, 206):
                raise UpdateError(f"download: HTTP {r.status_code} for {url}")
            if resume_from and r.status_code == 200:
                resume_from = 0
            clen = r.headers.get("content-length")
            # `resume_from` is only part of the total when the server honored
            # the Range request (206). A 200 (Range ignored) already ships the
            # full file, so `clen` alone is the total.
            total = (
                int(clen) + resume_from
                if (clen and clen.isdigit() and r.status_code == 206)
                else int(clen) if (clen and clen.isdigit()) else None
            )
            received = resume_from
            last_report = 0.0
            with open(part, "ab" if resume_from else "wb") as f:
                for chunk in r.iter_content(chunk_size=CHUNK):
                    f.write(chunk)
                    received += len(chunk)
                    if progress is not None:
                        now = time.monotonic()
                        if received == total or now - last_report >= 0.25:
                            progress(received, total)
                            last_report = now
    except requests.RequestException as e:
        # Keep the .part: the next attempt resumes from it (Range request).
        raise UpdateError(f"download: {e}") from e
    if expected_sha256:
        actual = sha256_file(part)
        if actual != expected_sha256.lower():
            part.unlink(missing_ok=True)
            raise UpdateError(
                f"checksum mismatch: expected {expected_sha256.lower()}, got {actual}"
            )
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
    dirs: ComponentDirs,
    staging_content: Path,
    keep: int = KEEP_BACKUPS,
    label: str | None = None,
) -> str | None:
    """Move staged content into the live dir; the previous live goes to backups.

    `label` (e.g. "v253" / "b10816") records what is being replaced, so a
    later rollback can restore the version. Returns the backup dir name, or
    None on a first install (nothing to back up). Prunes backups older than
    `keep`.

    The preserved config files (`PRESERVED_CONFIGS`) are snapshotted before
    the move and restored on top of the new install — the user's models
    config survives every update.
    """
    live, backups = dirs.live, dirs.backups
    component = backups.name  # backups live under <root>/backups/<component>
    if not staging_content.is_dir() or not any(staging_content.iterdir()):
        raise UpdateError("swap: staging is missing or empty")
    backups.mkdir(parents=True, exist_ok=True)
    backup_name = None
    saved = _saved_configs(live, component) if live.exists() else {}
    if live.exists():
        backup_name = _backup_name(component, label)
        shutil.move(str(live), str(backups / backup_name))
    live.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(staging_content), str(live))
    _restore_configs(live, saved)
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


def rollback(dirs: ComponentDirs) -> bool:
    """Restore the newest backup into the live dir. False when no backup exists.

    The failed live install is parked next to the backups (`.failed` suffix)
    so nothing is lost.
    """
    live, backups = dirs.live, dirs.backups
    names = list_backups(backups)
    if not names:
        return False
    backup = backups / names[0]
    saved = _saved_configs(live, backups.name) if live.exists() else {}
    if live.exists():
        shutil.move(str(live), str(backups / (names[0] + ".failed")))
    shutil.move(str(backup), str(live))
    _restore_configs(live, saved)
    return True


def sweep_stale_installers() -> int:
    """Delete leftover app installers from %TEMP% (or /tmp on POSIX).

    `download_and_launch_installer` downloads the installer to the system
    temp dir and used to leave it there forever — each self-update
    accumulated ~18 MB. The in-flight installer is protected by age
    (anything younger than 15 minutes is assumed to be the one we just
    launched). Deletion failures are ignored: a locked file means the
    installer is still running and the next boot sweeps it.
    """
    import tempfile

    min_age = 15 * 60  # seconds
    tmp = Path(tempfile.gettempdir())
    now = time.time()
    removed = 0
    for p in tmp.glob("llama-center-setup-*"):
        try:
            if not p.is_file() or now - p.stat().st_mtime < min_age:
                continue
            p.unlink()
            removed += 1
        except OSError:
            pass  # locked / vanished — try again next boot
    return removed


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
        r = requests.get(f"http://{host}:{port}/health", timeout=timeout)
        return r.status_code == 200
    except requests.RequestException:
        return False


def stop_basalt() -> bool:
    """Best-effort stop of a running basalt, by image name.

    Same pattern as stop_llama_swap: Windows taskkill by image name; POSIX
    `pkill -f basalt` (the binary is named basalt). Returns False when nothing
    matched (or the tool is missing).
    """
    cmd = ["taskkill", "/IM", "basalt.exe", "/F"] if os.name == "nt" else ["pkill", "-f", "basalt"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=15)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
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


def launch_installer(
    url: str,
    stop_managed: StopFn | None = None,
    progress: ProgressFn | None = None,
) -> None:
    """Download the app installer to the system temp dir and launch it.

    Windows: launches the Inno Setup .exe after a 2s delay (the running
    exe stays deletable; a failed `del` degrades to a leak that the boot
    sweep picks up). Linux: extracts the .tar.gz and runs a detached
    `_do_update.sh` that swaps the install dir and starts the new instance.

    `stop_managed` is called right after the download completes — the
    caller passes a hook that stops the managed llama-swap so this
    process exits fast (the new instance boots ~2s later and needs the
    lock, WebView2 profile and files released).

    Raises UpdateError / OSError on download or extraction failure.
    """
    import tempfile

    name = url.rsplit("/", 1)[-1].split("?")[0] or "llama-center-setup.exe"
    tmp = Path(tempfile.gettempdir()) / name
    download(url, tmp, None, progress=progress)

    if stop_managed is not None:
        stop_managed()

    if name.endswith(".tar.gz"):
        # Linux: extract tarball and run a background update script
        extract_dir = Path(tempfile.gettempdir()) / "llama-center-update"
        if extract_dir.exists():
            shutil.rmtree(extract_dir)
        extract_dir.mkdir()
        with tarfile.open(tmp) as tar:
            tar.extractall(extract_dir)

        install_dir = Path(sys.executable).parent
        script = extract_dir / "_do_update.sh"
        script.write_text(
            "#!/bin/bash\n"
            "sleep 2\n"
            f"rm -rf \"{install_dir}\"\n"
            f"cp -r \"{extract_dir}/llama-center\" \"{install_dir}\"\n"
            f"\"{install_dir}/llama-center\" &\n"
            # Clean up the tarball + extraction dir once the new
            # instance is up (the script itself lives in
            # extract_dir — delay so bash has read it all).
            f"( sleep 3; rm -rf \"{extract_dir}\" \"{tmp}\" ) &\n",
        )
        script.chmod(0o755)
        subprocess.Popen(
            ["bash", str(script)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    else:
        # Windows: launch the Inno Setup installer after a 2s delay,
        # then delete the installer file (the exe stays deletable
        # while running; if it is locked the del is a no-op and the
        # boot sweep picks it up).
        subprocess.Popen(
            f'cmd /c timeout /t 2 /nobreak >nul && start "" "{tmp}" && del "{tmp}"',
            shell=True,
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
