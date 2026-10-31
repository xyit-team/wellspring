#!/usr/bin/env python3
"""Wellspring logo builder.

Every asset is generated from two primitives:
  * the source drop      — a geometric teardrop drawn on a 32-unit grid
  * the wordmark         — JetBrains Mono outlines, the i's dot replaced by that drop

Requires: fontTools, JetBrains Mono TTFs in scripts/fonts/.

    python3 scripts/build-logo.py
"""
import math
import pathlib

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
FONT_DIR = HERE / "fonts"
OUT_SVG = ROOT / "logo"

# ---------------------------------------------------------------- palette
INK = "#0F2F24"       # 深林 forest ink
SPRING = "#3DDC97"    # 泉 spring green
DEEP = "#067A5B"      # 深泉 deep spring — accent on light
BONE = "#F4F3EF"      # 骨 bone — ink on dark

# ---------------------------------------------------------------- drop geometry
DROP = dict(cx=16.0, y0=3.4, y1=27.8, r=8.6, tip=1.6)
DROP_H = DROP["y1"] - DROP["y0"]          # 24.4
DROP_W = DROP["r"] * 2                    # 17.2


def drop_path():
    """Teardrop: a circle of radius r at the bottom, straight flanks tangent to it,
    closing at (cx, y0) with a quadratic fillet."""
    cx, y0, y1, r, tip = DROP["cx"], DROP["y0"], DROP["y1"], DROP["r"], DROP["tip"]
    cy = y1 - r
    d = cy - y0
    s = math.sqrt(max(0.0, 1 - (r / d) ** 2))
    tx, ty = r * s, d - r * r / d
    L = math.hypot(tx, ty)
    ax, ay = cx + tx / L * tip, y0 + ty / L * tip
    return (
        f"M{ax:.3f},{ay:.3f} L{cx + tx:.3f},{y0 + ty:.3f} "
        f"A{r:.3f},{r:.3f} 0 1 1 {cx - tx:.3f},{y0 + ty:.3f} "
        f"L{cx - tx / L * tip:.3f},{ay:.3f} Q{cx:.3f},{y0:.3f} {ax:.3f},{ay:.3f} Z"
    )


DROP_D = drop_path()

# ---------------------------------------------------------------- wordmark
UPEM = 1000
TRACK = -32            # tracking, font units
TEXT = "wellspring"
DOT_H = 155.0          # i-dot drop height, font units
DOT_BOTTOM = 660.0     # i-dot bottom, font units above baseline
ASC = 730.0            # 'l' top
DESC = -180.0          # 'p'/'g' bottom
WEIGHT = 2             # JetBrains Mono Medium


def _glyph_path(gs, name, dx):
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (1, 0, 0, -1, dx, ASC)))
    return pen.getCommands()


def _glyph_bounds(gs, name):
    pen = BoundsPen(gs)
    gs[name].draw(pen)
    return pen.bounds


class Wordmark:
    def __init__(self, weight=WEIGHT):
        self.font = TTFont(FONT_DIR / f"JetBrainsMono-{weight}.ttf")
        self.gs = self.font.getGlyphSet()
        cmap = self.font.getBestCmap()
        self.dotless = cmap[ord("\u0131")]
        x = 0.0
        self.parts = []
        for ch in TEXT:
            name = self.dotless if ch == "i" else cmap[ord(ch)]
            self.parts.append((name, x))
            x += self.font["hmtx"][name][0] + TRACK

        i_dx = next(dx for n, dx in self.parts if n == self.dotless)
        ib = _glyph_bounds(self.gs, self.dotless)
        self.dot_cx = (ib[0] + ib[2]) / 2 + i_dx

        xs, ys = [], []
        for name, dx in self.parts:
            b = _glyph_bounds(self.gs, name)
            xs += [b[0] + dx, b[2] + dx]
            ys += [b[1], b[3]]
        xs += [self.dot_cx - DROP_W / 2, self.dot_cx + DROP_W / 2]
        ys += [DOT_BOTTOM + DOT_H, DOT_BOTTOM]
        self.x0, self.x1 = min(xs), max(xs)
        self.y0, self.y1 = min(ys), max(ys)

        # SVG space: y down, baseline at ASC, viewBox top at ASC - y1
        self.top = ASC - self.y1
        self.width = self.x1 - self.x0
        self.height = self.y1 - self.y0

        s = DOT_H / DROP_H
        self.dot_s = s
        self.dot_dx = self.dot_cx - self.x0 - DROP["cx"] * s
        self.dot_dy = ASC - (DOT_BOTTOM + DOT_H) - DROP["y0"] * s

    def paths(self, text_color, dot_color=None):
        s = self.dot_s
        word = "".join(f'<path d="{_glyph_path(self.gs, n, dx - self.x0)}"/>' for n, dx in self.parts)
        dot = (f'<path d="{DROP_D}" transform="translate({self.dot_dx:.3f},{self.dot_dy:.3f}) '
               f'scale({s:.5f})" fill="{dot_color or text_color}"/>')
        return word, dot

    def svg(self, text_color, dot_color=None, pad=0.0):
        word, dot = self.paths(text_color, dot_color)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{(self.width + pad * 2) / 6:.0f}" '
            f'height="{(self.height + pad * 2) / 6:.0f}" viewBox="{-pad:.2f} {self.top - pad:.2f} '
            f'{self.width + pad * 2:.2f} {self.height + pad * 2:.2f}" role="img" aria-label="wellspring">'
            f'<g fill="{text_color}">{word}</g>{dot}</svg>'
        )


# ---------------------------------------------------------------- Chinese
ZH_FONT = "NotoSansSC-500-subset.ttf"


def zh_paths(text, size, color, x, baseline=ASC, tracking=60.0):
    """Lay out Chinese glyphs from the subset font; returns (markup, advance)."""
    font = TTFont(FONT_DIR / ZH_FONT)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    s = size / font["head"].unitsPerEm
    cx = x
    out = []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(TransformPen(pen, (s, 0, 0, -s, cx, baseline)))
        out.append(f'<path d="{pen.getCommands()}"/>')
        cx += font["hmtx"][name][0] * s + tracking
    return f'<g fill="{color}">{"".join(out)}</g>', cx - x


# ---------------------------------------------------------------- assets
PAD = 24.0


def _svg_open(viewbox, intrinsic_w, extra=""):
    w, h = intrinsic_w
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" '
            f'viewBox="{viewbox}"{extra}')


def symbol_svg(color):
    """Square canvas: the drop's height becomes the drawing area, the drop centred."""
    side = DROP_H
    x = DROP["cx"] - side / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" '
        f'viewBox="{x:.3f} {DROP["y0"]:.3f} {side:.3f} {side:.3f}" role="img" aria-label="Wellspring">'
        f'<path d="{DROP_D}" fill="{color}"/></svg>'
    )


def lockup_horizontal(text_color, dot_color, mark_color=None):
    """Drop + wordmark. Mark stands on the baseline, 0.78 em tall; 0.42 em gap."""
    wm = Wordmark()
    mark_h = 770.0
    s = mark_h / DROP_H
    mark_w = DROP_W * s
    gap = 380.0
    word, dot = wm.paths(text_color, dot_color)
    word_x = mark_w + gap
    w = word_x + wm.width
    # viewBox includes the mark and the wordmark, plus optical padding
    top = min(wm.top, ASC - mark_h)
    bottom = ASC - DESC
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{(w + PAD * 2) / 7:.0f}" '
        f'height="{(bottom - top + PAD * 2) / 7:.0f}" viewBox="{-PAD:.0f} {top - PAD:.2f} '
        f'{w + PAD * 2:.2f} {bottom - top + PAD * 2:.2f}" role="img" aria-label="Wellspring">'
        f'<path d="{DROP_D}" transform="translate({-PAD + PAD:.3f},{ASC - mark_h - DROP["y0"] * s:.3f}) '
        f'scale({s:.5f})" fill="{mark_color or dot_color}"/>'
        f'<g transform="translate({word_x:.3f},0)"><g fill="{text_color}">{word}</g>{dot}</g>'
        f'</svg>'
    )


def lockup_stacked(text_color, dot_color, mark_color=None):
    wm = Wordmark()
    mark_h = 900.0
    s = mark_h / DROP_H
    mark_w = DROP_W * s
    gap = 300.0
    word, dot = wm.paths(text_color, dot_color)
    w = max(wm.width, mark_w)
    top = 0.0
    mark_x = (w - mark_w) / 2
    mark_y = 0.0
    word_y = mark_h + gap
    word_x = (w - wm.width) / 2
    h = word_y + wm.height
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{(w + PAD * 2) / 6:.0f}" '
        f'height="{(h + PAD * 2) / 6:.0f}" viewBox="{-PAD:.0f} {-PAD:.0f} {w + PAD * 2:.2f} '
        f'{h + PAD * 2:.2f}" role="img" aria-label="Wellspring">'
        f'<path d="{DROP_D}" transform="translate({mark_x - DROP["cx"] * s + 0:.3f},'
        f'{-DROP["y0"] * s + mark_y:.3f}) scale({s:.5f})" fill="{mark_color or dot_color}"/>'
        f'<g transform="translate({word_x:.3f},{word_y + (ASC - wm.y1) * 0:.3f})">'
        f'<g fill="{text_color}">{word}</g>{dot}</g>'
        f'</svg>'
    )


def lockup_bilingual(text_color, dot_color, zh_color):
    """Drop + wellspring + 源泉, one baseline."""
    wm = Wordmark()
    mark_h = 770.0
    s = mark_h / DROP_H
    mark_w = DROP_W * s
    word, dot = wm.paths(text_color, dot_color)
    word_x = mark_w + 380.0
    zh_size = 690.0
    zh_x = word_x + wm.width + 300.0
    zh_markup, zh_w = zh_paths("源泉", zh_size, zh_color, zh_x, ASC, tracking=70.0)
    w = zh_x + zh_w - 70.0
    top = min(wm.top, ASC - mark_h)
    bottom = ASC - DESC
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{(w + PAD * 2) / 8:.0f}" '
        f'height="{(bottom - top + PAD * 2) / 8:.0f}" viewBox="{-PAD:.0f} {top - PAD:.2f} '
        f'{w + PAD * 2:.2f} {bottom - top + PAD * 2:.2f}" role="img" aria-label="Wellspring 源泉">'
        f'<path d="{DROP_D}" transform="translate({-PAD + PAD:.3f},{ASC - mark_h - DROP["y0"] * s:.3f}) '
        f'scale({s:.5f})" fill="{dot_color}"/>'
        f'<g transform="translate({word_x:.3f},0)"><g fill="{text_color}">{word}</g>{dot}</g>'
        f'{zh_markup}</svg>'
    )


def app_icon_svg(size=512, bg=INK, fg=SPRING, gradient=False, drop_ratio=0.52, radius_ratio=0.225):
    r = size * radius_ratio
    drop_h = size * drop_ratio
    s = drop_h / DROP_H
    dx = size / 2 - DROP["cx"] * s
    dy = size / 2 - (DROP["y0"] + DROP_H / 2) * s
    if gradient:
        head = ('<defs><radialGradient id="ws-bg" cx="34%" cy="26%" r="92%">'
                '<stop offset="0" stop-color="#1B4A37"/><stop offset="1" stop-color="#0B241B"/>'
                '</radialGradient></defs>')
        fill = "url(#ws-bg)"
    else:
        head, fill = "", bg
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}" role="img" aria-label="Wellspring">'
        f'{head}<rect width="{size}" height="{size}" rx="{r:.2f}" fill="{fill}"/>'
        f'<path d="{DROP_D}" transform="translate({dx:.3f},{dy:.3f}) scale({s:.5f})" fill="{fg}"/></svg>'
    )


def favicon_svg():
    """16–32 px: bigger drop, tighter tile."""
    return app_icon_svg(size=32, bg=SPRING, fg=INK, drop_ratio=0.68, radius_ratio=0.25)


ASSETS = {
    "wellspring-symbol.svg": lambda: symbol_svg(INK),
    "wellspring-symbol-reversed.svg": lambda: symbol_svg(SPRING),
    "wellspring-symbol-mono.svg": lambda: symbol_svg("currentColor"),
    "wellspring-wordmark.svg": lambda: Wordmark().svg(INK, DEEP),
    "wellspring-wordmark-reversed.svg": lambda: Wordmark().svg(BONE, SPRING),
    "wellspring-wordmark-mono.svg": lambda: Wordmark().svg("currentColor"),
    "wellspring-lockup-horizontal.svg": lambda: lockup_horizontal(INK, DEEP, DEEP),
    "wellspring-lockup-horizontal-reversed.svg": lambda: lockup_horizontal(BONE, SPRING, SPRING),
    "wellspring-lockup-stacked.svg": lambda: lockup_stacked(INK, DEEP, DEEP),
    "wellspring-lockup-stacked-reversed.svg": lambda: lockup_stacked(BONE, SPRING, SPRING),
    "wellspring-lockup-horizontal-mono.svg": lambda: lockup_horizontal("currentColor", "currentColor"),
    "wellspring-lockup-bilingual.svg": lambda: lockup_bilingual(INK, DEEP, DEEP),
    "wellspring-lockup-bilingual-reversed.svg": lambda: lockup_bilingual(BONE, SPRING, SPRING),
    "wellspring-lockup-stacked-mono.svg": lambda: lockup_stacked("currentColor", "currentColor"),
    "wellspring-app-icon.svg": lambda: app_icon_svg(gradient=True),
    "wellspring-app-icon-alt.svg": lambda: app_icon_svg(bg=SPRING, fg=INK, drop_ratio=0.54),
    "wellspring-favicon.svg": favicon_svg,
}


def main():
    OUT_SVG.mkdir(parents=True, exist_ok=True)
    print("building Wellspring logo →", OUT_SVG.relative_to(ROOT))
    for name, fn in ASSETS.items():
        svg = fn()
        (OUT_SVG / name).write_text(svg + "\n")
        print(f"  {name:44s} {len(svg):6d} B")
    print(f"  {len(ASSETS)} assets")


if __name__ == "__main__":
    main()
