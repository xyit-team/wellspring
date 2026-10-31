#!/usr/bin/env python3
"""Build the Chorus logo assets.

    pip install fonttools
    python3 scripts/build-logo.py

Writes ../logo/*.svg. Type: Inter SemiBold (outlined), Noto Sans SC Medium
(subset, only 和声), both SIL OFL — see scripts/fonts/.
"""
import math
import pathlib
import re

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "logo"
FONTS = HERE / "fonts"

INK, BRASS, BONE = "#14161B", "#C99357", "#F3EFE6"

# ---------------------------------------------------------------- mark
CX, CY = 16.0, 16.0
RADII = (10.8, 8.0, 5.2)
STROKES = (2.2, 1.8, 1.8)
A0, A1 = 40.0, 320.0


def arc_path(r, a0=A0, a1=A1, cx=CX, cy=CY):
    x0 = cx + r * math.cos(math.radians(a0)); y0 = cy + r * math.sin(math.radians(a0))
    x1 = cx + r * math.cos(math.radians(a1)); y1 = cy + r * math.sin(math.radians(a1))
    large = 1 if abs(a1 - a0) > 180 else 0
    return f"M{x0:.3f},{y0:.3f} A{r:.3f},{r:.3f} 0 {large} 1 {x1:.3f},{y1:.3f}"


MARK = [(arc_path(r), w) for r, w in zip(RADII, STROKES)]
SMALL = [(arc_path(7.8), 4.4)]


def bbox(radii, strokes):
    x0 = CX - radii[0] - strokes[0] / 2
    x1 = CX + radii[0] * math.cos(math.radians(A0)) + strokes[0] / 2
    y0 = CY - radii[0] - strokes[0] / 2
    y1 = CY + radii[0] + strokes[0] / 2
    return x0, y0, x1, y1


MB = bbox(RADII, STROKES)
MW, MH = MB[2] - MB[0], MB[3] - MB[1]


def svg_paths(items, color):
    return "".join(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round"/>'
                   for d, w in items)


def centered(items, color, pad=1.0, width=96):
    radii = [float(re.search(r"A([\d.]+),", d).group(1)) for d, _ in items]
    x0, y0, x1, y1 = bbox(radii, [w for _, w in items])
    w, h = x1 - x0, y1 - y0
    side = max(w, h) + pad * 2
    dx, dy = (side - w) / 2 - x0, (side - h) / 2 - y0
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{width}" '
            f'viewBox="0 0 {side:.3f} {side:.3f}" role="img" aria-label="Chorus">'
            f'<g transform="translate({dx:.4f},{dy:.4f})">{svg_paths(items, color)}</g></svg>')


# ---------------------------------------------------------------- type
def font_paths(font_file, text, tracking_em=0.0):
    f = TTFont(FONTS / font_file)
    gs, cmap = f.getGlyphSet(), f.getBestCmap()
    s = 1000.0 / f["head"].unitsPerEm
    tracking, paths, x = tracking_em * 1000.0, [], 0.0
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[gname].draw(TransformPen(pen, (s, 0, 0, -s, x, 0)))
        paths.append(pen.getCommands())
        x += f["hmtx"][gname][0] * s + tracking
    return paths, x - tracking


def wordmark_svg(color, text="chorus", font="Inter-600.ttf", tracking=-0.02, size=100):
    paths, width = font_paths(font, text, tracking)
    s = size / 1000.0
    cap = 745.0
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width * s:.1f}" height="{cap * s:.1f}" '
            f'viewBox="0 -{cap:.2f} {width:.2f} {cap:.2f}" role="img" aria-label="{text}">'
            f'<g fill="{color}">' + "".join(f'<path d="{p}"/>' for p in paths) + "</g></svg>")


def lockup_h(mark_color, text_color, zh_color=None, size=100):
    paths, width = font_paths("Inter-600.ttf", "chorus", -0.02)
    target = 860.0
    s = target / MH
    mark_w = MW * s
    gap = 300.0
    word_x = mark_w + gap
    zh_paths, zh_w = font_paths("NSC-500.ttf", "和声", 0.12) if zh_color else ([], 0.0)
    zh_x = word_x + width + (260 if zh_color else 0)
    total = zh_x + zh_w if zh_color else word_x + width
    pad = 60.0
    H = target + 240.0
    sc = size / 1000.0
    mark_t = (f'<g transform="translate({pad - MB[0] * s:.3f},{target + 120 - MB[3] * s:.3f}) scale({s:.6f})">'
              + svg_paths(MARK, mark_color) + "</g>")
    word_t = (f'<g transform="translate({pad + word_x:.3f},{target + 120:.3f})"><g fill="{text_color}">'
              + "".join(f'<path d="{p}"/>' for p in paths) + "</g></g>")
    zh_t = ""
    if zh_color:
        zh_t = (f'<g transform="translate({pad + zh_x:.3f},{target + 120:.3f}) scale(0.72)">'
                f'<g fill="{zh_color}">' + "".join(f'<path d="{p}"/>' for p in zh_paths) + "</g></g>")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{(total + pad * 2) * sc:.1f}" '
            f'height="{H * sc:.1f}" viewBox="0 0 {total + pad * 2:.2f} {H:.2f}" role="img" aria-label="Chorus">'
            f'{mark_t}{word_t}{zh_t}</svg>')


def lockup_stacked(mark_color, text_color, size=100):
    paths, width = font_paths("Inter-600.ttf", "chorus", -0.02)
    target = 900.0
    s = target / MH
    mark_w = MW * s
    total = max(width, mark_w)
    pad = 60.0
    mark_x = (total - mark_w) / 2
    word_x = (total - width) / 2
    gap = 220.0
    H = target + gap + 745.0
    sc = size / 1000.0
    mark_t = (f'<g transform="translate({pad + mark_x - MB[0] * s:.3f},{pad + target - MB[3] * s:.3f}) scale({s:.6f})">'
              + svg_paths(MARK, mark_color) + "</g>")
    word_t = (f'<g transform="translate({pad + word_x:.3f},{pad + target + gap + 745.0:.3f})">'
              f'<g fill="{text_color}">' + "".join(f'<path d="{p}"/>' for p in paths) + "</g></g>")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{(total + pad * 2) * sc:.1f}" '
            f'height="{H * sc:.1f}" viewBox="0 0 {total + pad * 2:.2f} {H:.2f}" role="img" aria-label="Chorus">'
            f'{mark_t}{word_t}</svg>')


def app_icon(size=512, bg=INK, fg=BRASS, ratio=0.56, radius=0.225, mark=MARK, mb=MB):
    target = size * ratio
    mw, mh = mb[2] - mb[0], mb[3] - mb[1]
    s = target / mh
    dx = size / 2 - (mb[0] + mw / 2) * s
    dy = size / 2 - (mb[1] + mh / 2) * s
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}" role="img" aria-label="Chorus">'
            f'<rect width="{size}" height="{size}" rx="{size * radius:.1f}" fill="{bg}"/>'
            f'<g transform="translate({dx:.2f},{dy:.2f}) scale({s:.6f})">{svg_paths(mark, fg)}</g></svg>')


ASSETS = {
    "chorus-symbol.svg": lambda: centered(MARK, INK),
    "chorus-symbol-brass.svg": lambda: centered(MARK, BRASS),
    "chorus-symbol-bone.svg": lambda: centered(MARK, BONE),
    "chorus-symbol-mono.svg": lambda: centered(MARK, "currentColor"),
    "chorus-symbol-small.svg": lambda: centered(SMALL, INK, width=64),
    "chorus-wordmark.svg": lambda: wordmark_svg(INK),
    "chorus-wordmark-bone.svg": lambda: wordmark_svg(BONE),
    "chorus-wordmark-mono.svg": lambda: wordmark_svg("currentColor"),
    "chorus-lockup.svg": lambda: lockup_h(INK, INK, INK),
    "chorus-lockup-dark.svg": lambda: lockup_h(BRASS, BONE, BRASS),
    "chorus-lockup-mono.svg": lambda: lockup_h("currentColor", "currentColor", "currentColor"),
    "chorus-lockup-stacked.svg": lambda: lockup_stacked(INK, INK),
    "chorus-lockup-stacked-dark.svg": lambda: lockup_stacked(BRASS, BONE),
    "chorus-app-icon.svg": lambda: app_icon(512, INK, BRASS),
    "chorus-app-icon-alt.svg": lambda: app_icon(512, BRASS, INK, ratio=0.58),
    "chorus-favicon.svg": lambda: app_icon(32, BRASS, INK, ratio=0.74, radius=0.25,
                                           mark=SMALL, mb=bbox([7.8], [4.4])),
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in ASSETS.items():
        svg = fn()
        (OUT / name).write_text(svg + "\n")
        print(f"  {name:34s} {len(svg):6d} B")
    print(f"  {len(ASSETS)} assets → {OUT.relative_to(OUT.parent.parent)}")


if __name__ == "__main__":
    main()
