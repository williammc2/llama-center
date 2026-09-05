"""Tray icon — generated at runtime (no image asset in the repo).

A dark rounded square with three sky bars: the "server" glyph. 64x64 RGBA.
"""
from __future__ import annotations

from PIL import Image, ImageDraw

BG = (23, 23, 23, 255)  # neutral-950
BAR = (14, 165, 233, 255)  # sky-500
SIZE = 64
RADIUS = 14


def make_icon() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, SIZE - 3, SIZE - 3], radius=RADIUS, fill=BG)
    bar_h = 8
    gap = 10
    top = 14
    for i in range(3):
        y = top + i * (bar_h + gap)
        d.rounded_rectangle([14, y, SIZE - 15, y + bar_h - 1], radius=4, fill=BAR)
    return img
