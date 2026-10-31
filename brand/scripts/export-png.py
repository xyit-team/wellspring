#!/usr/bin/env python3
"""Rasterise the SVG logo assets to PNG with headless Chrome.

    python3 scripts/export-png.py

Writes brand/png/*.png. Chrome must be on PATH.
"""
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SVG = ROOT / "logo"
PNG = ROOT / "png"
CHROME = "google-chrome"

# (source svg, output png, width, height, background)  background None = transparent
JOBS = [
    ("wellspring-symbol.svg", "wellspring-symbol-ink-512.png", 512, 512, None),
    ("wellspring-symbol-reversed.svg", "wellspring-symbol-spring-512.png", 512, 512, None),
    ("wellspring-symbol-mono.svg", "wellspring-symbol-bone-512.png", 512, 512, None),
    ("wellspring-wordmark.svg", "wellspring-wordmark-1600.png", 1600, 260, None),
    ("wellspring-wordmark-reversed.svg", "wellspring-wordmark-reversed-1600.png", 1600, 260, None),
    ("wellspring-lockup-horizontal.svg", "wellspring-lockup-horizontal-1600.png", 1600, 280, None),
    ("wellspring-lockup-horizontal-reversed.svg", "wellspring-lockup-horizontal-reversed-1600.png", 1600, 280, None),
    ("wellspring-lockup-stacked.svg", "wellspring-lockup-stacked-900.png", 900, 700, None),
    ("wellspring-lockup-stacked-reversed.svg", "wellspring-lockup-stacked-reversed-900.png", 900, 700, None),
    ("wellspring-lockup-bilingual.svg", "wellspring-lockup-bilingual-1800.png", 1800, 300, None),
    ("wellspring-lockup-bilingual-reversed.svg", "wellspring-lockup-bilingual-reversed-1800.png", 1800, 300, None),
    ("wellspring-app-icon.svg", "wellspring-app-icon-1024.png", 1024, 1024, "#0F2F24"),
    ("wellspring-app-icon.svg", "wellspring-app-icon-512.png", 512, 512, "#0F2F24"),
    ("wellspring-app-icon.svg", "wellspring-app-icon-256.png", 256, 256, "#0F2F24"),
    ("wellspring-app-icon.svg", "wellspring-app-icon-128.png", 128, 128, "#0F2F24"),
    ("wellspring-app-icon-alt.svg", "wellspring-app-icon-alt-1024.png", 1024, 1024, "#3DDC97"),
    ("wellspring-favicon.svg", "wellspring-favicon-16.png", 16, 16, None),
    ("wellspring-favicon.svg", "wellspring-favicon-32.png", 32, 32, None),
    ("wellspring-favicon.svg", "wellspring-favicon-48.png", 48, 48, None),
]

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;background:{bg};overflow:hidden}}
img{{display:block;width:{w}px;height:{h}px}}
</style></head><body><img src="file://{src}"></body></html>"""


def aspect(svg_path):
    head = svg_path.read_text()[:400]
    m = re.search(r'viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"', head)
    if not m:
        return 1.0
    vb = [float(v) for v in m.groups()]
    return vb[3] / vb[2]


def main():
    PNG.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / ".export"
    tmp.mkdir(exist_ok=True)
    for src, out, w, h, bg in JOBS:
        bg_css = bg or "transparent"
        html = tmp / "a.html"
        ratio = aspect(SVG / src)
        h = max(1, round(w * ratio)) if bg is None or not (src.startswith("wellspring-app-icon") or src.startswith("wellspring-favicon")) else h
        html.write_text(TEMPLATE.format(bg=bg_css, w=w, h=h, src=SVG / src))
        cmd = [
            CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
            f"--user-data-dir={tmp / 'chrome'}", f"--window-size={w},{h}",
            f"--default-background-color=00000000" if bg is None else "",
            f"--screenshot={PNG / out}", f"file://{html}",
        ]
        cmd = [c for c in cmd if c]
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"  {out:44s} {w}x{h}")
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"  {len(JOBS)} png files → {PNG.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
