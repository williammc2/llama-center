"""Singleton — exactly one llama-center process at a time.

Why: with close-to-tray the app keeps running hidden in the tray. Launching it
again from the desktop/Start shortcut used to spawn a *second* process (two
apps). Now the first instance owns a lock; a second launch asks it to surface
its window, then exits.

Mechanism (per OS):
  Windows  named mutex  "llama-center-<user>"      → ownership = "I'm first"
           named event  "llama-center-show-<user>" → IPC: "show"
  Linux    flock on     <root>/.llama-center.lock  → ownership = "I'm first"
           unix socket  <root>/.llama-center.sock  → IPC: "show"

The lock is released automatically when the process dies (mutex handle closed /
flock fd closed), so a crash can't leave a stale lock behind.

The 'show' command needs no payload: the event *is* the command. The first
instance blocks on the event; the second instance sets it and exits.
"""
from __future__ import annotations

import os
import socket
import threading
import time
from pathlib import Path

if os.name == "nt":
    import ctypes
    import ctypes.wintypes
else:
    import fcntl

# A stable per-user port is not needed: named pipes (win) / unix sockets (linux)
# are already namespaced by the scope string below.


def _scope() -> str:
    """Per-user scope so per-user installs don't collide across users."""
    if os.name == "nt":
        import getpass

        return getpass.getuser()
    return str(os.getuid())


def _root() -> Path:
    """Per-user data root (same place config.json lives)."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "llama-center"


class Singleton:
    """Owns the single-instance lock + the IPC channel for the 'show' command.

    Usage (first instance, in main()):
        s = Singleton()
        if not s.acquire():
            s.signal("show")   # ask the existing instance to surface
            return 0
        ... create window ...
        s.start_listening(lambda cmd: window.show() if cmd == "show" else None)
        ... webview.start() ...
        s.release()

    `name` is the base name of the mutex/event/lock/socket (tests use a
    unique one so they never collide with a running app).
    """

    def __init__(self, name: str = "llama-center") -> None:
        self._name = name
        self._scope = _scope()
        self._mutex = None  # Windows mutex handle
        self._lock_file = None  # Linux lock file handle
        self._listener: threading.Thread | None = None
        self._stop = threading.Event()
        self._on_command: "callable | None" = None

    # ------------------------------------------------------------------ acquire
    def acquire(self) -> bool:
        """True → we are the first instance (lock now held). False → one is running."""
        if os.name == "nt":
            name = f"{self._name}-{self._scope}"
            k32 = ctypes.windll.kernel32
            k32.CreateMutexW.restype = ctypes.c_void_p
            h = k32.CreateMutexW(None, False, name)
            if k32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
                k32.CloseHandle(h)
                return False
            self._mutex = h
            return True
        path = _root() / f".{self._name}.lock"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock_file = open(path, "a+")
        try:
            fcntl.flock(self._lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            self._lock_file.close()
            self._lock_file = None
            return False
        return True

    # ------------------------------------------------------------------ signal
    def signal(self, cmd: str, timeout: float = 2.0) -> bool:
        """Ask the running instance to run `cmd`. True if it answered.

        Retries briefly: the first instance may not have created the pipe/socket
        yet (it starts listening right after the window is created).
        """
        deadline = time.monotonic() + timeout
        while True:
            if os.name == "nt":
                if self._signal_windows(cmd):
                    return True
            else:
                if self._signal_unix(cmd):
                    return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)

    def _signal_windows(self, cmd: str) -> bool:
        """Set the named event the first instance is waiting on. True if it
        existed (so someone is listening)."""
        if cmd != "show":
            return False
        k32 = ctypes.windll.kernel32
        k32.OpenEventW.restype = ctypes.c_void_p
        EVENT_MODIFY_STATE = 0x0002
        h = k32.OpenEventW(EVENT_MODIFY_STATE, False, self._event_name())
        if h is None:
            return False
        try:
            return bool(k32.SetEvent(h))
        finally:
            k32.CloseHandle(h)

    def _event_name(self) -> str:
        return f"{self._name}-show-{self._scope}"

    def _signal_unix(self, cmd: str) -> bool:
        sock_path = _root() / f".{self._name}.sock"
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(1.0)
            s.connect(str(sock_path))
            s.sendall(cmd.encode("ascii"))
            s.close()
            return True
        except OSError:
            return False

    # ------------------------------------------------------------------ listen
    def start_listening(self, on_command: "callable") -> None:
        """Run the IPC listener in a daemon thread (first instance only)."""
        self._on_command = on_command
        self._listener = threading.Thread(target=self._run, daemon=True)
        self._listener.start()

    def _run(self) -> None:
        if os.name == "nt":
            self._listen_windows()
        else:
            self._listen_unix()

    def _listen_windows(self) -> None:
        """Block on the named event; each time it's set, dispatch 'show'."""
        k32 = ctypes.windll.kernel32
        k32.CreateEventW.restype = ctypes.c_void_p
        EVENT_ALL_ACCESS = 0x1F0000
        # CreateEventW(name, bManualReset, bInitialState, name): auto-reset,
        # initially non-signalled.
        h = k32.CreateEventW(None, False, False, self._event_name())
        if h is None:
            return
        try:
            # WAIT_OBJECT_0 = 0. Poll against self._stop so release() can wake us.
            while not self._stop.is_set():
                r = k32.WaitForSingleObject(h, 500)  # 500ms so we can check _stop
                if r == 0:  # signalled by a second instance
                    self._dispatch("show")
        finally:
            k32.CloseHandle(h)

    def _listen_unix(self) -> None:
        sock_path = _root() / f".{self._name}.sock"
        try:
            sock_path.unlink()
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(str(sock_path))
            server.listen(4)
            server.settimeout(1.0)
            while not self._stop.is_set():
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                try:
                    data = conn.recv(64)
                    self._dispatch(data.decode("ascii", "ignore").strip())
                finally:
                    conn.close()
        finally:
            server.close()
            try:
                sock_path.unlink()
            except FileNotFoundError:
                pass

    def _dispatch(self, cmd: str) -> None:
        if self._on_command and cmd:
            try:
                self._on_command(cmd)
            except Exception:
                pass  # never let the listener die on a bad callback

    # ------------------------------------------------------------------ release
    def release(self) -> None:
        self._stop.set()
        if self._mutex is not None:
            try:
                ctypes.windll.kernel32.CloseHandle(self._mutex)
            except Exception:
                pass
            self._mutex = None
        if self._lock_file is not None:
            try:
                fcntl.flock(self._lock_file, fcntl.LOCK_UN)
                self._lock_file.close()
            except Exception:
                pass
            self._lock_file = None
