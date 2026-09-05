"""llama-center — the pywebview shell.

Run:  python backend/main.py  (from the repo root, after `pnpm build`)
Build: pyinstaller llama-center.spec

Loads the built UI from dist/index.html and exposes `window.pywebview.api`
to the React app (see src/lib/bridge.ts for the client side).

The API surface lives in llama_center.api (five focused mixins, composed
into one flat `Api` below). This file owns only the shell: the single-
instance lock, the window, the tray, the WebView2 profile, and the
auto-start. The P0–P5 surface the UI calls is unchanged from before.
"""
from __future__ import annotations

import atexit
import sys
import threading
import time
from pathlib import Path

# Make `llama_center` importable regardless of CWD (dev mode only — when
# frozen, PyInstaller has already bundled the package into sys.path).
REPO_ROOT = Path(__file__).resolve().parent.parent
FROZEN = getattr(sys, "frozen", False)
if not FROZEN:
    sys.path.insert(0, str(REPO_ROOT / "backend"))


def dist_dir() -> Path:
    """Where the built UI lives: repo dist/ in dev, _MEIPASS/dist when frozen."""
    if FROZEN:
        return Path(sys._MEIPASS) / "dist"
    return REPO_ROOT / "dist"


import webview  # noqa: E402

from llama_center import singleton as single  # noqa: E402
from llama_center import updater  # noqa: E402
from llama_center.config import ConfigError, load_config  # noqa: E402
from llama_center.api import (  # noqa: E402
    AppUpdateApi,
    ComponentApi,
    ConfigApi,
    ProcessApi,
    SwapConfigApi,
)

# Tray state (module-level: one icon per app run).
_tray_icon: "pystray.Icon | None" = None
_force_quit = False


class Api(ConfigApi, ComponentApi, ProcessApi, SwapConfigApi, AppUpdateApi):
    """The surface exposed to the UI as window.pywebview.api.

    Composed from the mixins in llama_center.api — the UI sees one flat
    object; the Python side is organized by responsibility. The one piece of
    live process state (``self._managed``) and the self-update close hook
    (``self._force_close``) are initialized here.
    """

    def __init__(self) -> None:
        self._managed = None
        self._force_close = _force_close_app


def _shutdown_managed(api: "Api") -> None:
    """atexit hook — no orphan llama-swap on a graceful app exit."""
    m = api._managed
    if m is not None and m.running:
        m.stop(timeout=5)
        m.flush()


def _tray_quit(window) -> None:
    global _force_quit
    _force_quit = True
    window.destroy()


def _force_close_app() -> None:
    """Force-quit the app (used after launching the update installer)."""
    global _force_quit
    _force_quit = True
    for w in webview.windows:
        w.destroy()


def _tray_check_updates(window) -> None:
    window.show()
    try:
        window.evaluate_js("window.__lcCheckUpdates && window.__lcCheckUpdates()")
    except Exception:
        pass


def start_tray(window, api: "Api") -> None:
    """Run the tray icon in a daemon thread (pystray blocks).

    pystray is imported lazily: its __init__ resolves the OS backend at
    import time, and the Linux Xorg backend opens an X display — which
    doesn't exist in headless contexts (CI).
    """
    global _tray_icon

    def run() -> None:
        import pystray  # noqa: PLC0415

        from llama_center.icon import make_icon  # noqa: PLC0415

        menu = pystray.Menu(
            pystray.MenuItem("Show", window.show, default=True),
            pystray.MenuItem("Start llama-swap", lambda icon, item: api.start_llama_swap()),
            pystray.MenuItem("Stop llama-swap", lambda icon, item: api.stop_llama_swap()),
            pystray.MenuItem("Check for updates", lambda icon, item: _tray_check_updates(window)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", lambda icon, item: _tray_quit(window)),
        )
        icon = pystray.Icon("llama-center", make_icon(), "llama-center")
        icon.menu = menu
        _tray_icon = icon
        icon.run()

    threading.Thread(target=run, daemon=True).start()


def _maybe_autostart_swap(api: "Api") -> None:
    """autoStartLlamaSwap: start the server with the app (only when the port
    is free — an external llama-swap is adopted by the UI, not killed here)."""
    time.sleep(2)  # let the window + API come up
    try:
        cfg = load_config()
        if not cfg.auto_start_llama_swap:
            return
        if not updater.probe_port(cfg.llama_swap_port):
            api.start_llama_swap()
    except ConfigError:
        pass


def main() -> int:
    dist = dist_dir() / "index.html"
    if not dist.exists():
        print(f"UI not built — run `pnpm build` first (expected {dist}).", file=sys.stderr)
        return 1

    # Single-instance guard. The first process owns the lock and stays alive in
    # the tray (close-to-tray). A second launch — e.g. clicking the desktop or
    # Start shortcut while the app is hidden — fails to acquire, asks the first
    # instance to surface its window, and exits.
    #
    # acquire_or_takeover tolerates a *dying* previous instance: after an app
    # self-update the old process may still be shutting down (stopping
    # llama-swap) when the installer launches the new one. If it dies without
    # answering, we take over its lock instead of exiting into nothing.
    lock = single.Singleton()
    if not single.acquire_or_takeover(lock):
        time.sleep(0.3)  # let the first instance process the show before we exit
        return 0

    # Wipe the WebView2 profile before the window exists. Normally a no-op
    # (the previous instance tore it down on exit); after a self-update it
    # removes the profile the dying instance left half-closed — the cause of
    # the black first window. Must run only when we own the lock (above).
    single.wipe_webview_profile()

    api = Api()
    atexit.register(_shutdown_managed, api)

    # Sweep installers left in %TEMP% by previous self-updates (each one
    # ~18 MB). Runs off the boot path; the in-flight installer is protected
    # by age inside the sweep.
    threading.Thread(target=updater.sweep_stale_installers, daemon=True).start()

    window = webview.create_window(
        "llama-center",
        str(dist),
        width=1080,
        height=760,
        min_size=(880, 600),
        background_color="#0a0a0a",
        js_api=api,
        hidden="--minimized" in sys.argv,  # login start → straight to the tray
    )

    def on_closing(window) -> bool:
        """Close-to-tray: return False to cancel the close (hide instead).

        pywebview 6.x: window.events.closing — set() returns False when any
        handler returns False, which the GUI backend uses to cancel.
        """
        try:
            cfg = load_config()
            if cfg.close_to_tray and not _force_quit:
                window.hide()
                return False
        except ConfigError:
            pass
        return True

    window.events.closing += on_closing

    # IPC listener: a second launch sends "show" → surface this window.
    # window.show() marshals to the GUI thread in each backend, so calling it
    # from the listener thread is safe.
    lock.start_listening(lambda cmd: window.show() if cmd == "show" else None)

    start_tray(window, api)
    threading.Thread(target=_maybe_autostart_swap, args=(api,), daemon=True).start()

    webview.start(storage_path=str(single.webview_profile_dir()))

    if _tray_icon is not None:
        try:
            _tray_icon.stop()
        except Exception:
            pass
    lock.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
