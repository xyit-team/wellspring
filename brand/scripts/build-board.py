#!/usr/bin/env python3
"""Build the Wellspring brand board (self-contained HTML + PNG).

    python3 scripts/build-board.py

The HTML embeds subsets of JetBrains Mono and Noto Sans SC, so it renders the
same everywhere. Needs the full Noto Sans SC TTFs in .fontcache/ (see README).
"""
import base64
import io
import math
import pathlib
import re
import subprocess

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
LOGO = ROOT / "logo"
FONTS = HERE / "fonts"
CACHE = ROOT / ".fontcache"
OUT = ROOT / "brand-board.html"

INK, SPRING, DEEP, BONE = "#0F2F24", "#3DDC97", "#067A5B", "#F4F3EF"


def asset(name, width=None, height=None, cls=""):
    s = (LOGO / name).read_text().replace("\n", "")
    if width or height:
        s = re.sub(r'\swidth="[^"]*"', "", s, count=1)
        s = re.sub(r'\sheight="[^"]*"', "", s, count=1)
    attrs = ""
    if width:
        attrs += f' width="{width}"'
    if height:
        attrs += f' height="{height}"'
    if cls:
        attrs += f' class="{cls}"'
    return s.replace("<svg ", f"<svg{attrs} ", 1)


# ---------------------------------------------------------------- diagrams
def construction_svg():
    cx, y0, y1, r = 16, 3.4, 27.8, 8.6
    cy = y1 - r
    d = cy - y0
    sq = math.sqrt(1 - (r / d) ** 2)
    tx, ty = r * sq, d - r * r / d
    grid = "".join(
        f'<line x1="{x}" y1="0" x2="{x}" y2="32" stroke="{INK}" stroke-opacity=".06" stroke-width=".12"/>'
        for x in range(0, 33, 2)
    ) + "".join(
        f'<line x1="0" y1="{y}" x2="32" y2="{y}" stroke="{INK}" stroke-opacity=".06" stroke-width=".12"/>'
        for y in range(0, 33, 2)
    )
    drop = re.search(r'd="([^"]+)"', (LOGO / "wellspring-symbol.svg").read_text()).group(1)
    return f'''<svg viewBox="-3.6 -4.6 44 45.4" xmlns="http://www.w3.org/2000/svg">
<rect x="-3.6" y="-4.6" width="44" height="45.4" fill="#FBFAF7"/>
{grid}
<path d="{drop}" fill="{SPRING}" fill-opacity=".16" stroke="{INK}" stroke-opacity=".32" stroke-width=".22"/>
<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{DEEP}" stroke-width=".26" stroke-dasharray="1.1 .9"/>
<line x1="{cx}" y1="{cy}" x2="{cx + r:.4f}" y2="{cy}" stroke="{DEEP}" stroke-width=".16"/>
<circle cx="{cx}" cy="{cy}" r=".4" fill="{DEEP}"/>
<line x1="{cx}" y1="{y0}" x2="{cx + tx:.4f}" y2="{y0 + ty:.4f}" stroke="{DEEP}" stroke-width=".13" stroke-opacity=".8"/>
<line x1="{cx}" y1="{y0}" x2="{cx - tx:.4f}" y2="{y0 + ty:.4f}" stroke="{DEEP}" stroke-width=".13" stroke-opacity=".8"/>
<circle cx="{cx + tx:.4f}" cy="{y0 + ty:.4f}" r=".34" fill="{DEEP}"/>
<circle cx="{cx - tx:.4f}" cy="{y0 + ty:.4f}" r=".34" fill="{DEEP}"/>
<line x1="16" y1="-2.4" x2="16" y2="30.6" stroke="{DEEP}" stroke-width=".11" stroke-dasharray=".8 .8" stroke-opacity=".5"/>
<line x1="{cx - r:.4f}" y1="29.9" x2="{cx + r:.4f}" y2="29.9" stroke="{DEEP}" stroke-width=".16" stroke-opacity=".65"/>
<line x1="{cx - r:.4f}" y1="29.3" x2="{cx - r:.4f}" y2="30.5" stroke="{DEEP}" stroke-width=".16" stroke-opacity=".65"/>
<line x1="{cx + r:.4f}" y1="29.3" x2="{cx + r:.4f}" y2="30.5" stroke="{DEEP}" stroke-width=".16" stroke-opacity=".65"/>
<line x1="27.1" y1="{y0}" x2="27.1" y2="{y1}" stroke="{DEEP}" stroke-width=".16" stroke-opacity=".65"/>
<line x1="26.5" y1="{y0}" x2="27.7" y2="{y0}" stroke="{DEEP}" stroke-width=".16" stroke-opacity=".65"/>
<line x1="26.5" y1="{y1}" x2="27.7" y2="{y1}" stroke="{DEEP}" stroke-width=".16" stroke-opacity=".65"/>
<g font-family="JBM" font-size="1.3" fill="{DEEP}">
  <text x="{cx + r / 2:.2f}" y="{cy - .8:.2f}" text-anchor="middle">r 8.6</text>
  <text x="27.9" y="15.2" text-anchor="start">h 24.4</text>
  <text x="{cx}" y="33.2" text-anchor="middle">w 17.2</text>
  <text x="17.4" y="5.6" text-anchor="start">tip 1.6</text>
  <text x="-2.2" y="-2.6" text-anchor="start">32 × 32 grid</text>
</g></svg>'''


def clearspace_svg():
    drop = re.search(r'd="([^"]+)"', (LOGO / "wellspring-symbol.svg").read_text()).group(1)
    # symbol box: x 7.4..24.6, y 3.4..27.8; clear space x = 12.2 (half the height)
    return f'''<svg viewBox="-18 -18 68 68" xmlns="http://www.w3.org/2000/svg">
<path d="{drop}" fill="{INK}"/>
<rect x="-4.8" y="-8.8" width="41.6" height="41.6" fill="none" stroke="{DEEP}" stroke-width=".5" stroke-dasharray="2 1.6"/>
<g font-family="JBM" font-size="2.6" fill="{DEEP}">
  <text x="16" y="-11.4" text-anchor="middle">x</text>
  <text x="16" y="42.2" text-anchor="middle">x</text>
  <text x="-13.2" y="17.4" text-anchor="middle">x</text>
  <text x="45.2" y="17.4" text-anchor="middle">x</text>
</g></svg>'''


def misuse(kind):
    drop = re.search(r'd="([^"]+)"', (LOGO / "wellspring-symbol.svg").read_text()).group(1)
    if kind == "stretch":
        return f'<svg viewBox="0 0 32 32" preserveAspectRatio="none" width="120" height="56"><path d="{drop}" fill="{INK}" transform="translate(16,16) scale(1.5,.78) translate(-16,-16)"/></svg>'
    if kind == "recolour":
        return f'<svg viewBox="0 0 32 32" width="72"><path d="{drop}" fill="#E0533D"/></svg>'
    if kind == "rotate":
        return f'<svg viewBox="0 0 32 32" width="72"><path d="{drop}" fill="{INK}" transform="rotate(38 16 16)"/></svg>'
    if kind == "shadow":
        return f'<svg viewBox="0 0 32 32" width="72"><defs><filter id="m-shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="1.4" dy="2" stdDeviation="1.2" flood-color="#3DDC97" flood-opacity=".9"/></filter></defs><path d="{drop}" fill="{INK}" filter="url(#m-shadow)"/></svg>'
    if kind == "outline":
        return f'<svg viewBox="0 0 32 32" width="72"><path d="{drop}" fill="none" stroke="{INK}" stroke-width="1"/></svg>'
    if kind == "contrast":
        return f'<svg viewBox="0 0 32 32" width="72"><rect width="32" height="32" fill="#0F2F24"/><path d="{drop}" fill="#1B3A2F"/></svg>'
    return ""


# ---------------------------------------------------------------- page
def build():
    wm = asset("wellspring-wordmark.svg", 520)
    lock_h = asset("wellspring-lockup-horizontal.svg", 780)
    lock_hr = asset("wellspring-lockup-horizontal-reversed.svg", 780)
    lock_s = asset("wellspring-lockup-stacked.svg", 380)
    lock_sr = asset("wellspring-lockup-stacked-reversed.svg", 380)
    lock_b = asset("wellspring-lockup-bilingual.svg", 900)
    lock_br = asset("wellspring-lockup-bilingual-reversed.svg", 900)
    symbol_ink = asset("wellspring-symbol.svg", 96)
    symbol_spring = asset("wellspring-symbol-reversed.svg", 96)
    symbol_bone = asset("wellspring-symbol-mono.svg", 96)
    icon = asset("wellspring-app-icon.svg", 120)
    icon_alt = asset("wellspring-app-icon-alt.svg", 120)
    fav = asset("wellspring-favicon.svg", 32)

    ripple = "".join(
        f'<circle cx="1290" cy="170" r="{140 + i * 96}" fill="none" stroke="{SPRING}" stroke-opacity="{0.055 - i * 0.008:.3f}" stroke-width="1"/>'
        for i in range(5)
    )

    html = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Wellspring · 品牌标志</title>
<style>
@font-face{{font-family:'JBM';src:url(data:font/ttf;base64,__JBM500__) format('truetype');font-weight:500}}
@font-face{{font-family:'JBM';src:url(data:font/ttf;base64,__JBM600__) format('truetype');font-weight:600}}
@font-face{{font-family:'NSC';src:url(data:font/ttf;base64,__NSC400__) format('truetype');font-weight:400}}
@font-face{{font-family:'NSC';src:url(data:font/ttf;base64,__NSC500__) format('truetype');font-weight:500}}
@font-face{{font-family:'NSC';src:url(data:font/ttf;base64,__NSC700__) format('truetype');font-weight:700}}
:root{{--ink:{INK};--spring:{SPRING};--deep:{DEEP};--bone:{BONE};--paper:#FBFAF7;--line:rgba(15,47,36,.14);--muted:#5E6F67}}
*{{box-sizing:border-box;margin:0;padding:0}}
html{{background:#E7E5DF}}
body{{width:1600px;font-family:'NSC','JBM',sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}}
section{{position:relative;padding:104px 112px;overflow:hidden}}
.dark{{background:var(--ink);color:var(--bone)}}
.paper{{background:var(--paper)}}
.bone{{background:var(--bone)}}
.eyebrow{{font-family:'JBM';font-size:12px;font-weight:500;letter-spacing:.22em;color:var(--deep);text-transform:uppercase}}
.dark .eyebrow{{color:var(--spring)}}
h2{{font-weight:500;font-size:46px;letter-spacing:.01em;margin:14px 0 0}}
.lead{{font-size:19px;line-height:1.85;font-weight:400;max-width:640px}}
.rule{{height:1px;background:var(--line);width:100%}}
.dark .rule{{background:rgba(244,243,239,.16)}}
.mono{{font-family:'JBM';font-weight:500}}
section svg{{display:block}}
.tile svg,.figure svg,.clear svg,.ui-logo svg{{max-width:100%;height:auto}}
.num{{font-family:'JBM';font-size:13px;color:var(--muted);letter-spacing:.04em}}
.dark .num{{color:rgba(244,243,239,.55)}}

/* cover */
.cover{{height:1040px;padding:72px 112px 84px;display:flex;flex-direction:column;justify-content:space-between;
background:radial-gradient(1200px 700px at 78% -10%, #16402F 0%, #0C261D 45%, #081A14 100%)}}
.cover svg{{display:block}}
.cover-top{{display:flex;justify-content:space-between;align-items:baseline;font-family:'JBM';font-size:12px;letter-spacing:.2em;color:rgba(244,243,239,.62);text-transform:uppercase}}
.cover-mid{{display:flex;align-items:center;gap:0;margin-top:40px}}
.cover-tagline{{margin-top:34px;font-size:21px;font-weight:400;letter-spacing:.12em;color:rgba(244,243,239,.8)}}
.cover-tagline b{{color:var(--spring);font-weight:500;letter-spacing:.2em}}
.cover-bottom{{display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid rgba(244,243,239,.14);padding-top:26px;
font-family:'JBM';font-size:12px;letter-spacing:.12em;color:rgba(244,243,239,.5)}}
.cover-ripple{{position:absolute;right:-160px;top:-260px;width:900px;height:900px}}
.cover-mark{{position:absolute;right:112px;bottom:210px;opacity:.1}}

/* concept */
.split{{display:grid;grid-template-columns:1fr 1fr;gap:88px;align-items:center}}
.split>*{{min-width:0}}
.kw{{display:grid;grid-template-columns:repeat(3,1fr);gap:36px;margin-top:56px}}
.kw h3{{font-family:'JBM';font-size:15px;letter-spacing:.12em;color:var(--deep);margin-bottom:10px}}
.kw p{{font-size:15px;line-height:1.8;color:var(--muted)}}
.figure{{background:#fff;border:1px solid var(--line);border-radius:16px;padding:44px 46px}}
.figure-cap{{font-family:'JBM';font-size:11px;letter-spacing:.14em;color:var(--muted);margin-top:22px;text-transform:uppercase}}

/* construction */
.specs{{border-top:1px solid var(--line)}}
.spec{{padding:20px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline}}
.spec dt{{font-size:15px;color:var(--muted)}}
.spec dd{{font-family:'JBM';font-size:15px}}

/* colour */
.swatches{{display:grid;grid-template-columns:repeat(4,1fr);gap:22px;margin-top:44px}}
.sw{{border-radius:14px;overflow:hidden;background:#fff;border:1px solid var(--line)}}
.sw-chip{{height:190px}}
.sw-body{{padding:20px 22px 24px}}
.sw-name{{font-size:16px;font-weight:500}}
.sw-hex{{font-family:'JBM';font-size:12px;letter-spacing:.08em;color:var(--muted);margin-top:5px}}
.sw-use{{font-size:13px;line-height:1.7;color:var(--muted);margin-top:14px}}
.ratio{{display:flex;height:12px;border-radius:6px;overflow:hidden;margin-top:34px}}
.ratio span{{display:block}}
.legend{{display:flex;gap:28px;margin-top:16px;font-family:'JBM';font-size:11px;letter-spacing:.06em;color:var(--muted)}}

/* type */
.typegrid{{display:grid;grid-template-columns:1fr 1fr;gap:72px;margin-top:48px}}
.specimen{{border-top:1px solid var(--line);padding-top:26px}}
.specimen .big{{font-size:72px;line-height:1.1;font-weight:500;letter-spacing:-.03em}}
.specimen .big.zh{{font-size:76px;letter-spacing:.12em}}
.spec-row{{display:flex;gap:24px;margin-top:28px;align-items:baseline}}
.spec-row b{{font-family:'JBM';font-weight:500}}
.codebox{{margin-top:28px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 24px;font-family:'JBM';font-size:13px;line-height:1.9;color:var(--muted)}}
.codebox i{{font-style:normal;color:var(--deep)}}

/* lockups */
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:44px}}
.tile{{border-radius:16px;padding:46px 40px;display:flex;align-items:center;justify-content:center;min-height:220px}}
.tile.light{{background:#fff;border:1px solid var(--line)}}
.tile.dark{{background:var(--ink)}}
.tile-cap{{position:absolute;font-family:'JBM';font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.45}}
.clear-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:22px}}
.clear{{background:#fff;border:1px solid var(--line);border-radius:16px;padding:30px;text-align:center}}
.clear .art{{height:210px;display:flex;align-items:center;justify-content:center;overflow:hidden}}
.clear .art svg{{max-height:210px;width:auto;max-width:100%}}
.clear b{{display:block;font-family:'JBM';font-size:12px;letter-spacing:.1em;margin-top:10px;font-weight:500}}
.clear span{{font-size:13px;color:var(--muted)}}

/* applications */
.apps{{display:grid;grid-template-columns:1.15fr .85fr;gap:56px;margin-top:48px}}
.approw{{display:flex;align-items:center;gap:26px;flex-wrap:wrap}}
.approw .item{{text-align:center}}
.approw .item span{{display:block;font-family:'JBM';font-size:10px;letter-spacing:.1em;color:rgba(244,243,239,.45);margin-top:12px;text-transform:uppercase}}
.ui{{border-radius:14px;overflow:hidden;display:flex;background:#0B1F18;border:1px solid rgba(244,243,239,.12)}}
.ui-side{{width:250px;background:#0C241B;border-right:1px solid rgba(244,243,239,.08);padding:18px 16px}}
.ui-logo{{display:flex;align-items:center;gap:9px;padding:4px 6px 18px;border-bottom:1px solid rgba(244,243,239,.08)}}
.ui-logo span{{font-family:'JBM';font-size:14px;color:#EAE9E6;letter-spacing:-.02em}}
.ui-nav{{margin-top:14px;font-family:'JBM';font-size:12px;color:rgba(234,233,230,.6)}}
.ui-nav div{{padding:7px 8px;border-radius:6px}}
.ui-nav div.on{{background:rgba(61,220,151,.1);color:#3DDC97}}
.ui-main{{flex:1;padding:20px 22px;font-family:'JBM';font-size:12px;color:#C9CFCB}}
.ui-msg{{line-height:1.75}}
.ui-user{{color:#EAE9E6;margin-bottom:10px}}
.ui-tool{{margin:10px 0;padding:8px 10px;border:1px solid rgba(244,243,239,.1);border-radius:6px;color:rgba(201,207,203,.8)}}
.ui-tool i{{font-style:normal;color:#3DDC97}}
.tab{{display:flex;align-items:center;background:#20241F;border-radius:9px 9px 0 0;padding:9px 14px;width:220px;gap:9px;font-family:'JBM';font-size:12px;color:#D6D4CE}}
.tab .x{{margin-left:auto;opacity:.45}}
.tabbar{{background:#20241F;border-radius:9px 9px 0 0;padding:6px 10px 0;width:100%;display:flex}}
.term{{background:#08130E;border:1px solid rgba(244,243,239,.1);border-radius:12px;padding:18px 20px;font-family:'JBM';font-size:12.5px;line-height:1.95;color:#9FB3AA}}
.term i{{font-style:normal;color:#3DDC97}}
.term b{{font-weight:500;color:#EAE9E6}}

/* misuse */
.misuse{{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:44px}}
.mis{{background:#fff;border:1px solid var(--line);border-radius:16px;padding:26px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:190px;position:relative}}
.mis .bad{{position:absolute;top:14px;right:16px;font-family:'JBM';font-size:14px;color:#B44A3A}}
.mis .lab{{margin-top:18px;font-family:'JBM';font-size:11px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase}}

footer{{background:var(--paper);padding:56px 112px 64px;display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid var(--line)}}
footer .f-l{{font-size:13px;line-height:2;color:var(--muted)}}
footer .f-r{{font-family:'JBM';font-size:11px;letter-spacing:.1em;color:var(--muted);text-align:right;line-height:2}}
</style></head>
<body>

<section class="cover">
  <svg class="cover-ripple" viewBox="0 0 600 600">{ripple}</svg>
  <div style="position:absolute;right:-60px;bottom:120px;opacity:.055">{asset("wellspring-symbol-reversed.svg", 620)}</div>
  <div class="cover-top"><span>Wellspring · 源泉</span><span>Visual identity · 2026</span></div>
  <div>
    <div class="cover-mid">{asset("wellspring-lockup-horizontal-reversed.svg", 920)}</div>
    <div class="cover-tagline">聚合式 Agent 平台 · <b>AGGREGATED AGENT PLATFORM</b></div>
  </div>
  <div class="cover-bottom"><span>MARK / WORDMARK / APP ICON</span><span>V1.0 · 2026.10</span></div>
</section>

<section class="bone">
  <div class="eyebrow">01 / 概念</div>
  <h2>泉眼：名字里的那一滴水</h2>
  <div class="split" style="margin-top:64px">
    <div>
      <p class="lead">wellspring 是「井」，也是不断涌出的「泉」。平台叫源泉：所有能力从一个源头涌出，又汇回同一个入口。</p>
      <p class="lead" style="margin-top:26px">标志取这一滴水。它与文字共用一条基线；在单字标里，它就是 <span class="mono">i</span> 上的那一点——<b>泉眼，既是泉水流出的地方，也是字符的眼睛</b>。</p>
      <div class="kw">
        <div><h3>深</h3><p>深林色是水的深度，也是界面的底色。</p></div>
        <div><h3>涌</h3><p>春绿只给涌出的部分：强调、焦点、光标。</p></div>
        <div><h3>汇</h3><p>一条基线，把插件、模型、会话收进同一个字。</p></div>
      </div>
    </div>
    <div class="figure">
      {wm}
      <div class="figure-cap">wellspring · the i's dot is the source drop</div>
    </div>
  </div>
</section>

<section class="paper">
  <div class="eyebrow">02 / 构成</div>
  <h2>一滴水的几何</h2>
  <div class="split" style="margin-top:52px;align-items:start">
    <div class="figure" style="padding:34px">{construction_svg()}</div>
    <div>
      <dl class="specs">
        <div class="spec"><dt>画布</dt><dd>32 × 32 grid</dd></div>
        <div class="spec"><dt>水滴高度</dt><dd>24.4</dd></div>
        <div class="spec"><dt>水滴宽度</dt><dd>17.2</dd></div>
        <div class="spec"><dt>圆身半径</dt><dd>r = 8.6</dd></div>
        <div class="spec"><dt>尖端圆角</dt><dd>1.6</dd></div>
        <div class="spec"><dt>与文字关系</dt><dd>i 点 = 0.155 em</dd></div>
        <div class="spec"><dt>单字标最小尺寸</dt><dd>16 px</dd></div>
      </dl>
      <p style="font-size:15px;line-height:1.9;color:var(--muted);margin-top:26px">
        圆身是正圆，两侧为圆的切线，所以尖端角度可以按尺寸整除；尖端留 1.6 的小圆角，
        16 px 时不会糊成一个锐点。字标里的 i 点是同一路径缩放到 0.155 em，因此标志与文字
        永远同形。
      </p>
    </div>
  </div>
</section>

<section class="paper">
  <div class="eyebrow">03 / 色彩</div>
  <h2>深林与泉</h2>
  <div class="swatches">
    <div class="sw"><div class="sw-chip" style="background:{INK}"></div><div class="sw-body"><div class="sw-name">深林</div><div class="sw-hex">#0F2F24</div><div class="sw-use">主色。深色界面、图标底、正文标题。</div></div></div>
    <div class="sw"><div class="sw-chip" style="background:{SPRING}"></div><div class="sw-body"><div class="sw-name">泉</div><div class="sw-hex">#3DDC97</div><div class="sw-use">强调色。深底上的标志、焦点、光标。</div></div></div>
    <div class="sw"><div class="sw-chip" style="background:{DEEP}"></div><div class="sw-body"><div class="sw-name">深泉</div><div class="sw-hex">#067A5B</div><div class="sw-use">浅底上的强调色。与 #F4F3EF 对比 7.1:1。</div></div></div>
    <div class="sw"><div class="sw-chip" style="background:{BONE};border-bottom:1px solid var(--line)"></div><div class="sw-body"><div class="sw-name">骨</div><div class="sw-hex">#F4F3EF</div><div class="sw-use">浅底与深底上的文字。不用纯白。</div></div></div>
  </div>
  <div class="ratio"><span style="flex:56;background:{INK}"></span><span style="flex:26;background:{SPRING}"></span><span style="flex:12;background:{DEEP}"></span><span style="flex:6;background:{BONE}"></span></div>
  <div class="legend"><span>56 深林</span><span>26 泉</span><span>12 深泉</span><span>6 骨</span></div>
</section>

<section class="bone">
  <div class="eyebrow">04 / 字体</div>
  <h2>等宽，是产品的语气</h2>
  <p class="lead" style="margin-top:20px">界面全部用等宽字体。字标沿用同一语气：JetBrains Mono，字距 <span style="white-space:nowrap">−0.032 em</span>，i 点换成标志。</p>
  <div class="typegrid">
    <div class="specimen">
      <div class="big mono">wellspring</div>
      <div class="spec-row"><b>JetBrains Mono</b><span style="color:var(--muted);font-size:14px">Medium 500 · 字距 −0.032 em · i 点 = 标志</span></div>
      <div class="spec-row"><b style="font-size:28px">0123 4567890</b></div>
      <div class="codebox"><i>wellspring</i> start<br><i>wellspring</i> run "读取 package.json"<br><i>wellspring</i> plugin list</div>
    </div>
    <div class="specimen">
      <div class="big zh">源泉</div>
      <div class="spec-row"><b>Noto Sans SC</b><span style="color:var(--muted);font-size:14px">500 · 中文标题与正文</span></div>
      <div class="spec-row"><b style="font-size:28px">聚合式 Agent 平台</b></div>
      <div class="codebox" style="font-family:'NSC'">所有能力从一个源头涌出，又汇回同一个入口。<br>插件、模型、会话，共用一条基线。</div>
    </div>
  </div>
</section>

<section class="paper">
  <div class="eyebrow">05 / 组合</div>
  <h2>四种组合与留白</h2>
  <div class="grid2">
    <div class="tile light">{lock_h}</div>
    <div class="tile dark">{lock_hr}</div>
    <div class="tile light">{lock_s}</div>
    <div class="tile dark">{lock_sr}</div>
  </div>
  <div class="tile light" style="margin-top:22px;min-height:150px">{lock_b}</div>
  <div class="clear-grid">
    <div class="clear"><div class="art">{clearspace_svg()}</div><b>留白 = 0.5 x</b><span>四周最小留白为标志高度的 1/2</span></div>
    <div class="clear"><div class="art">{asset("wellspring-symbol.svg", 68)}</div><b>单字标 ≥ 16 px</b><span>更小时用反白图标</span></div>
    <div class="clear"><div class="art">{asset("wellspring-lockup-horizontal.svg", 280)}</div><b>横排 ≥ 120 px 宽</b><span>再窄改用堆叠或单字标</span></div>
  </div>
</section>

<section class="dark">
  <div class="eyebrow">06 / 应用</div>
  <h2>在界面里</h2>
  <div class="apps">
    <div>
      <div class="ui">
        <div class="ui-side">
          <div class="ui-logo">{asset("wellspring-symbol-reversed.svg", 18)}<span>wellspring</span></div>
          <div class="ui-nav">
            <div class="on">对话</div><div>扩展</div><div>模型与供应商</div><div>系统状态</div>
          </div>
        </div>
        <div class="ui-main">
          <div class="ui-user">读取 package.json 并总结依赖</div>
          <div class="ui-tool"><i>读取文件</i> package.json</div>
          <div class="ui-msg">依赖集中在运行时：openai、pino、undici、ws。<br>node-pty 是可选依赖，装不上时终端自动退回 python3 pty。</div>
        </div>
      </div>
      <div class="approw" style="margin-top:38px;gap:30px">
        <div class="item">{icon}<span>APP ICON</span></div>
        <div class="item" style="margin-left:8px">{asset("wellspring-favicon.svg", 48)}<span>FAVICON</span></div>
        <div class="item">{asset("wellspring-favicon.svg", 32)}<span>32</span></div>
        <div class="item">{asset("wellspring-favicon.svg", 16)}<span>16</span></div>
        <div class="item" style="margin-left:8px">{icon_alt}<span>ALT · SPRING</span></div>
      </div>
    </div>
    <div>
      <div class="tabbar"><div class="tab">{fav}<span>Wellspring</span><span class="x">×</span></div></div>
      <div class="term" style="border-radius:0 0 12px 12px;border-top:0">
        <i>❯</i> <b>wellspring</b> run "doctor"<br>
        <span style="color:#5E7A6E">宿主 running · 3 个插件 · node 24.3</span><br>
        <i>❯</i> <b>wellspring</b> start<br>
        <span style="color:#5E7A6E">listening on http://127.0.0.1:7788</span>
      </div>
      <p style="font-family:'JBM';font-size:11px;letter-spacing:.1em;color:rgba(244,243,239,.4);margin-top:16px;text-transform:uppercase">favicon / terminal banner</p>
    </div>
  </div>
</section>

<section class="bone">
  <div class="eyebrow">07 / 误用</div>
  <h2>不要这样用</h2>
  <div class="misuse">
    <div class="mis"><span class="bad">×</span>{misuse("stretch")}<span class="lab">拉伸变形</span></div>
    <div class="mis"><span class="bad">×</span>{misuse("recolour")}<span class="lab">换色 / 渐变</span></div>
    <div class="mis"><span class="bad">×</span>{misuse("rotate")}<span class="lab">旋转</span></div>
    <div class="mis"><span class="bad">×</span>{misuse("shadow")}<span class="lab">加阴影 / 发光</span></div>
    <div class="mis"><span class="bad">×</span>{misuse("outline")}<span class="lab">描边空心</span></div>
    <div class="mis"><span class="bad">×</span>{misuse("contrast")}<span class="lab">低对比底色</span></div>
  </div>
</section>

<footer>
  <div class="f-l">Wellspring 源泉 · 品牌标志 v1.0<br>logo/*.svg · png/*.png · brand-board.html</div>
  <div class="f-r">JETBRAINS MONO · SIL OFL 1.1<br>NOTO SANS SC · SIL OFL 1.1<br>© 2026 WELLSPRING</div>
</footer>

</body></html>'''
    return html


def embed_fonts(html):
    """Subset Noto Sans SC to the board's characters, base64 every face."""
    chars = set(html)
    text = "".join(sorted(chars))
    faces = {}
    for w, name in ((400, "NSC400"), (500, "NSC500"), (700, "NSC700")):
        src = pathlib.Path(FONTS / f"NotoSansSC-{w}.ttf")
        if not src.exists():
            src = CACHE / f"NotoSansSC-{w}.ttf"
        opts = subset.Options()
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        font = subset.load_font(str(src), opts)
        sub = subset.Subsetter(options=opts)
        sub.populate(text=text)
        sub.subset(font)
        buf = io.BytesIO()
        font.save(buf)
        faces[name] = base64.b64encode(buf.getvalue()).decode()
        print(f"    {name}: {len(buf.getvalue()) / 1024:.1f} KB subset, {len(text)} chars")
    faces["JBM500"] = base64.b64encode((FONTS / "JetBrainsMono-2.ttf").read_bytes()).decode()
    faces["JBM600"] = base64.b64encode((FONTS / "JetBrainsMono-3.ttf").read_bytes()).decode()
    for k, v in faces.items():
        html = html.replace(f"__{k}__", v)
    return html


def main():
    CACHE.mkdir(exist_ok=True)
    print("building brand board")
    html = build()
    html = embed_fonts(html)
    OUT.write_text(html)
    print(f"  {OUT.name}: {len(html) / 1024:.0f} KB")

    # render a long PNG and trim the trailing flat background
    tmp = ROOT / ".export" / "board.html"
    tmp.parent.mkdir(exist_ok=True)
    tmp.write_text(html)
    png = ROOT / "brand-board.png"
    cmd = [
        "google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
        f"--user-data-dir={ROOT / '.export' / 'chrome'}", "--window-size=1600,7600",
        f"--screenshot={png}", f"file://{tmp}",
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    try:
        from PIL import Image
        im = Image.open(png).convert("RGB")
        w, h = im.size
        bg = im.getpixel((4, h - 4))
        bottom = h
        px = im.load()
        while bottom > 0 and all(px[x, bottom - 1] == bg for x in range(0, w, 40)):
            bottom -= 1
        im.crop((0, 0, w, min(h, bottom + 1))).save(png)
        print(f"  {png.name}: {w}×{bottom + 1}")
    except ImportError:
        print("  (install pillow to trim)")
    finally:
        import shutil
        shutil.rmtree(ROOT / ".export", ignore_errors=True)


if __name__ == "__main__":
    main()
