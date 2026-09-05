# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — onedir build of llama-center.

Build:  pyinstaller llama-center.spec --noconfirm
Output: dist/llama-center/llama-center.exe (win) | dist/llama-center/llama-center (linux)

The UI (dist/) is bundled as data; main.py resolves it via sys._MEIPASS when
frozen. The tray/exe icon is generated from the same runtime icon (icon.py).
"""
import sys
from pathlib import Path

ROOT = Path(SPECPATH)  # noqa: F821
IS_WIN = sys.platform.startswith("win")

# pystray imports its backend lazily per OS.
hidden = ["pystray._win32", "pystray._gtk", "pystray._xorg", "pystray._appindicator", "pystray._darwin"]
# pywebview imports the GUI backend lazily inside functions — static analysis
# misses them, so list them explicitly.
hidden += [
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
    "webview.platforms.win32",
    "webview.platforms.qt",
    "webview.platforms.gtk",
    "webview.platforms.cocoa",
    "webview.platforms.mshtml",
    "webview.platforms.cef",
]

# Generate the .ico from the same code that draws the tray icon.
icon_path = ROOT / "build" / "icon.ico"
if IS_WIN:
    (ROOT / "build").mkdir(exist_ok=True)
    sys.path.insert(0, str(ROOT / "backend"))
    from llama_center.icon import make_icon  # noqa: E402

    make_icon().save(icon_path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)])

a = Analysis(
    [str(ROOT / "backend" / "main.py")],
    pathex=[str(ROOT / "backend")],
    binaries=[],
    datas=[(str(ROOT / "dist"), "dist")],
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "pytest"],
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="llama-center",
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(icon_path) if IS_WIN else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="llama-center",
)
