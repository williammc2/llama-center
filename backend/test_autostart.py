"""Tests for autostart (HKCU Run on Windows, XDG .desktop on Linux)."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from llama_center import autostart  # noqa: E402


class TestLaunchCmd:
    def test_dev_cmd_points_at_main_py(self):
        cmd = autostart.launch_cmd()
        assert cmd.startswith('"')
        assert "main.py" in cmd
        assert "--minimized" not in cmd  # the setters append it


class TestLinux:
    def test_set_and_unset(self, tmp_path, monkeypatch):
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
        autostart.set_linux(True)
        p = tmp_path / "config" / "autostart" / "llama-center.desktop"
        assert p.exists()
        text = p.read_text(encoding="utf-8")
        assert "Type=Application" in text
        assert "Name=llama-center" in text
        assert "--minimized" in text
        assert "main.py" in text

        autostart.set_linux(False)
        assert not p.exists()

    def test_unset_missing_is_noop(self, tmp_path, monkeypatch):
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
        autostart.set_linux(False)  # no file yet — no raise


@pytest.mark.skipif(os.name != "nt", reason="HKCU Run is Windows-only")
class TestWindows:
    def test_set_and_unset(self):
        import winreg

        autostart.set_windows(True)
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, autostart._RUN_KEY, 0, winreg.KEY_READ) as key:
            val, _ = winreg.QueryValueEx(key, autostart.APP_NAME)
        assert "--minimized" in val
        assert "main.py" in val

        autostart.set_windows(False)
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, autostart._RUN_KEY, 0, winreg.KEY_READ) as key:
            with pytest.raises(FileNotFoundError):
                winreg.QueryValueEx(key, autostart.APP_NAME)
