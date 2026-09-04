"""Managed llama-swap process: spawn, piped stdio, ring-buffer logs, stop.

Decoupled from config on purpose — `main.py` resolves the exe path and passes
a ready-to-run command. Tests use a stand-in command (a short-lived python
process), so no real llama-swap binary is needed.

Log destinations:
  - in-memory ring buffer (last `ring_size` lines) — the UI terminal view
  - rotating file at <log_dir>/llama-swap.log (5 MB x 3)
"""
from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path


class ProcessError(Exception):
    """Raised when start/stop fails, with a user-readable message."""


def _no_window_flag() -> int:
    """Windows: no console window popping up for the child process."""
    return 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW


class LlamaSwapProcess:
    """One managed llama-swap subprocess."""

    def __init__(self, command: list[str], workdir: Path, log_dir: Path, ring_size: int = 2000):
        self.command = command
        self.workdir = workdir
        self.log_dir = log_dir
        self._ring: deque[str] = deque(maxlen=ring_size)
        self._proc: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._lock = threading.Lock()
        self._logger = self._make_logger()

    def _make_logger(self) -> logging.Logger:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        logger = logging.getLogger(f"llama-center.llama-swap.{time.time_ns()}")
        logger.setLevel(logging.INFO)
        handler = RotatingFileHandler(
            self.log_dir / "llama-swap.log", maxBytes=5 << 20, backupCount=3, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        logger.propagate = False
        return logger

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self.running else None

    def start(self) -> int:
        """Spawn. Returns the pid. Raises ProcessError when already running."""
        with self._lock:
            if self.running:
                raise ProcessError("start: already running")
            try:
                self._proc = subprocess.Popen(
                    self.command,
                    cwd=str(self.workdir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    creationflags=_no_window_flag(),
                )
            except OSError as e:
                raise ProcessError(f"start: {e}") from e
            self._reader = threading.Thread(target=self._read_loop, daemon=True)
            self._reader.start()
            return self._proc.pid

    def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for raw in iter(self._proc.stdout.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            self._ring.append(line)
            self._logger.info(line)
        try:
            self._proc.stdout.close()
        except Exception:
            pass

    def stop(self, timeout: float = 10.0) -> int | None:
        """Terminate (SIGTERM / TerminateProcess), wait, kill if needed.

        Returns the exit code (None when it was never started). A killed
        process yields a platform-specific code (e.g. -15 / 0xC000013A),
        which the UI surfaces as-is.
        """
        with self._lock:
            if self._proc is None:
                return None
            proc = self._proc
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
            return proc.returncode

    def lines(self, n: int = 200) -> list[str]:
        """The last `n` buffered lines (newest last)."""
        return list(self._ring)[-n:]

    def flush(self, timeout: float = 2.0) -> None:
        """Wait for the reader thread to drain the pipe (call after stop)."""
        if self._reader is not None:
            self._reader.join(timeout=timeout)
