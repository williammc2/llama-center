"""OS launch helpers — open a URL or path with the default handler.

Not part of any API mixin's concern (the llama-swap models config never
cared about the file explorer); this is where "let the OS deal with it"
lives.
"""
from __future__ import annotations

import os
import subprocess


def open_target(target: str) -> dict:
    """Open a URL or path with the OS default handler. {opened} | {error}."""
    try:
        if os.name == "nt":
            os.startfile(target)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(
                ["xdg-open", target],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        return {"opened": True}
    except Exception as e:
        return {"error": str(e)}
