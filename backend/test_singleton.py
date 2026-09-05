"""Tests for llama_center.singleton — the single-instance lock + IPC.

Runs the REAL platform primitives (named mutex/event on Windows, flock +
AF_UNIX socket on Linux) with a unique name per test, so they never
collide with a running llama-center app.
"""
import os
import threading
import time
import uuid

import pytest

from llama_center import singleton as S


def _unique_name() -> str:
    return f"lc-test-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def root(tmp_path, monkeypatch):
    """Point the per-user data root at a temp dir (Linux lock + socket live there)."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    return tmp_path


class TestAcquire:
    def test_first_instance_acquires(self, root):
        s = S.Singleton(name=_unique_name())
        try:
            assert s.acquire() is True
        finally:
            s.release()

    def test_second_instance_fails(self, root):
        name = _unique_name()
        a = S.Singleton(name=name)
        b = S.Singleton(name=name)
        try:
            assert a.acquire() is True
            assert b.acquire() is False
        finally:
            a.release()
            b.release()

    def test_release_reopens(self, root):
        name = _unique_name()
        a = S.Singleton(name=name)
        b = S.Singleton(name=name)
        assert a.acquire() is True
        a.release()
        try:
            assert b.acquire() is True
        finally:
            b.release()

    def test_different_names_do_not_collide(self, root):
        a = S.Singleton(name=_unique_name())
        b = S.Singleton(name=_unique_name())
        try:
            assert a.acquire() is True
            assert b.acquire() is True
        finally:
            a.release()
            b.release()


class TestShowSignal:
    def test_signal_shows_first_instance(self, root):
        """Second launch sends 'show' → first instance's callback fires."""
        name = _unique_name()
        got = threading.Event()
        first = S.Singleton(name=name)
        second = S.Singleton(name=name)
        try:
            assert first.acquire() is True
            first.start_listening(lambda cmd: got.set() if cmd == "show" else None)
            time.sleep(0.3)  # let the listener create its event/socket
            assert second.acquire() is False
            assert second.signal("show") is True
            assert got.wait(3.0), "first instance never received the show request"
        finally:
            first.release()
            second.release()

    def test_signal_without_listener_fails(self, root):
        """No one is listening (e.g. stale lock) → signal gives up, no hang."""
        name = _unique_name()
        a = S.Singleton(name=name)
        b = S.Singleton(name=name)
        assert a.acquire() is True  # holds the lock but never start_listening()
        try:
            assert b.acquire() is False
            assert b.signal("show", timeout=0.4) is False
        finally:
            a.release()
            b.release()

    def test_dispatch_swallows_callback_errors(self, root):
        """A broken callback must not kill the listener thread."""
        name = _unique_name()
        first = S.Singleton(name=name)
        second = S.Singleton(name=name)
        try:
            assert first.acquire() is True
            first.start_listening(lambda cmd: (_ for _ in ()).throw(RuntimeError("boom")))
            time.sleep(0.3)
            assert second.acquire() is False
            assert second.signal("show") is True
            time.sleep(0.5)  # listener survives → still able to receive
            got = threading.Event()
            first._on_command = lambda cmd: got.set()
            assert second.signal("show") is True
            assert got.wait(3.0)
        finally:
            first.release()
            second.release()


class TestAcquireOrTakeover:
    def test_free_lock_acquires_immediately(self, root):
        s = S.Singleton(name=_unique_name())
        try:
            assert S.acquire_or_takeover(s) is True
        finally:
            s.release()

    def test_live_instance_refuses(self, root):
        """A first instance that answers 'show' → caller is redundant."""
        name = _unique_name()
        first = S.Singleton(name=name)
        second = S.Singleton(name=name)
        try:
            assert first.acquire() is True
            first.start_listening(lambda cmd: None)  # answers the event
            time.sleep(0.3)
            assert S.acquire_or_takeover(second, timeout=3.0, poll=0.2) is False
        finally:
            first.release()
            second.release()

    def test_dying_instance_is_taken_over(self, root):
        """The update scenario: the old instance holds the lock but dies
        without answering → the new instance takes over."""
        name = _unique_name()
        old = S.Singleton(name=name)
        new = S.Singleton(name=name)
        assert old.acquire() is True  # old holds the lock, no listener
        old.release()  # ...and dies before the first signal lands

        result = {}
        def attempt():
            result["r"] = S.acquire_or_takeover(new, timeout=5.0, poll=0.2)
        t = threading.Thread(target=attempt)
        t.start()
        t.join(6)
        try:
            assert result.get("r") is True
        finally:
            new.release()


class TestWebViewProfile:
    @pytest.fixture
    def profile_root(self, tmp_path, monkeypatch):
        """Point the profile helpers at a temp dir (per-OS env var)."""
        monkeypatch.setenv("APPDATA", str(tmp_path / "roaming"))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
        return tmp_path

    def test_profile_dir_is_dedicated(self, profile_root):
        """Not pywebview's shared %APPDATA%/pywebview — our own folder."""
        d = S.webview_profile_dir()
        assert d.name == "webview2"
        assert d.parent.name == "llama-center"
        # and it is NOT the pywebview default
        assert d.name != "pywebview"

    def test_wipe_removes_profile(self, profile_root):
        d = S.webview_profile_dir()
        (d / "EBWebView").mkdir(parents=True)
        (d / "EBWebView" / "lock.file").write_text("stale")
        S.wipe_webview_profile()
        assert not d.exists()

    def test_wipe_is_noop_when_missing(self, profile_root):
        # Must not raise (or create) when the folder doesn't exist yet.
        S.wipe_webview_profile()
        assert not S.webview_profile_dir().exists()

    def test_wipe_is_best_effort_on_locks(self, profile_root, monkeypatch):
        """A stubborn rmtree (locked file) must not block startup."""
        d = S.webview_profile_dir()
        d.mkdir(parents=True)
        import shutil

        def _boom(*a, **kw):
            raise OSError("locked")

        monkeypatch.setattr(S.shutil, "rmtree", _boom)
        S.wipe_webview_profile()  # must not raise
        assert d.exists()
