"""Autostart — per-user, no admin.

Windows: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run ("llama-center")
Linux:   ~/.config/autostart/llama-center.desktop

The launch command always carries `--minimized` so a login start goes
straight to the tray (PLAN: "start with system" = L1).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "llama-center"
_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_DESKTOP_TMPL = """\
[Desktop Entry]
Type=Application
Name=llama-center
Comment=llama-center — llama.cpp + llama-swap manager
Exec={cmd} --minimized
Terminal=false
Hidden=false
"""


def launch_cmd() -> str:
    """How the OS should start us. Frozen → the exe; dev → python + main.py."""
    if getattr(sys, "frozen", False):  # PyInstaller
        return f'"{sys.executable}"'
    main_py = Path(__file__).resolve().parent.parent / "main.py"
    return f'"{sys.executable}" "{main_py}"'


def set_windows(enabled: bool) -> None:
    import winreg

    cmd = launch_cmd() + " --minimized"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, cmd)
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass


def set_linux(enabled: bool) -> None:
    xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    path = Path(xdg) / "autostart" / f"{APP_NAME}.desktop"
    if enabled:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_DESKTOP_TMPL.format(cmd=launch_cmd()), encoding="utf-8")
    else:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def apply(enabled: bool) -> None:
    """Create/remove the autostart entry for this OS."""
    if os.name == "nt":
        set_windows(enabled)
    else:
        set_linux(enabled)
