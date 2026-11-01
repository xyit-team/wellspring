/*
 * 插件前端样式表。
 * 作为静态资源 /assets/app.css 提供，不内联，便于用严格 CSP。
 *
 * 设计系统：中性暖灰底（无边框，靠 1%–3% 明度分层）+ emerald 强调色；
 * 界面与代码统一使用系统等宽字体；深色下字重整体降 40。
 *
 * 十条硬规则落在文件里的位置：
 *   1 去边框 / 微明度分层 ........ 设计令牌「底色」段
 *   2 输入框聚焦双环 ............. .input:focus / .composer:focus-within
 *   3 暗色字重补偿 ............... --fw-* 令牌与 :root[data-theme="dark"]
 *   4 流式逐字入场 ............... .tchar（配 components/MarkdownText.vue）
 *   5 行内图标基线 ............... .icon
 *   6 数字等宽 ................... body 的 font-variant-numeric
 *   7 Grid 折叠 .................. .fold / .proc-fold
 *   8 防孤字 ..................... body / .md 的 text-wrap: pretty
 *   9 弹簧动效 ................... --spring-snap / --spring-pop
 *  10 反馈自熄 ................... [data-copied] 相关规则
 */

export const STYLES = String.raw`
/* ── 设计令牌 ─────────────────────────────────────────────── */

:root {
    color-scheme: light dark;

    /*
     * 全部界面用系统自带等宽字体：Windows Consolas、macOS Menlo/Monaco、
     * Linux DejaVu Sans Mono / Ubuntu Mono、Android Droid Sans Mono；
     * 后面再挂 CJK 回退，保证中文能正常显示（等宽字体栈里没有中文字形）。
     */
    --font-mono: "Consolas", "Cascadia Mono", "Menlo", "Monaco", "JetBrains Mono",
        "DejaVu Sans Mono", "Ubuntu Mono", "Droid Sans Mono", "Liberation Mono",
        "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Noto Sans Mono CJK", "PingFang SC",
        "Microsoft YaHei", monospace;
    --font-ui: var(--font-mono);

    /*
     * 字号阶梯：12 / 13 / 14 / 15 / 16 / 19 / 22 / 26 / 32。
     *
     * 旧阶梯每级只差 0.1rem（16 / 17.6 / 19.2 / 20.8…），相邻两级差不到 2px，
     * 页面标题、正文、元信息在屏幕上几乎同一大小，层级只能靠颜色硬撑；
     * 元信息又落在 11px，中文在这个尺寸下认读吃力，于是手机断点里
     * 单独放大十几个选择器来打补丁。这里把小字拆成 12/13/14 三档，
     * 正文与标题之间也留出看得见的差。
     *
     * 仍用 rem：html 的 --ui-font-size 可以整体缩放。
     */
    --font-size-2xs: 0.75rem; /* 12px 元信息：时间、计数、版本号、kbd */
    --font-size-xs: 0.8125rem; /* 13px 辅助文字：提示、说明、表格 */
    --font-size-sm: 0.875rem; /* 14px 界面文字：按钮、侧栏行、标签 */
    --font-size-base: 0.9375rem; /* 15px 表单值、过程行正文 */
    --font-size-md: 1rem; /* 16px 阅读正文、页面标题 */
    --font-size-lg: 1.1875rem; /* 19px 小节标题、对话框标题 */
    --font-size-xl: 1.375rem; /* 22px 正文 h2、空状态标题 */
    --font-size-2xl: 1.625rem; /* 26px 页面主标题 */
    --font-size-3xl: 2rem; /* 32px */

    /*
     * ── 底色：不用边框，靠 1%–3% 的明度差分层 ──
     *
     * 一屏里最多四层：底色 → 抬升面 → 面板 → 控件面。
     * 每层只比下一层亮 1%–3%，肉眼读到的是“同一张纸上的不同厚度”，
     * 而不是被线框切开的方块。所以整套界面里几乎没有 border：
     * 需要分隔时提高一层底色，需要聚焦时才出现线。
     * 没有纯黑（#000），最暗的一层也是 #0b0b0a。
     */
    --bg: light-dark(#f5f5f3, #0b0b0a);
    --bg-elev: light-dark(#fcfcfb, #111110);
    --surface: light-dark(#fcfcfb, #151515);
    --surface-2: light-dark(#f0f0ed, #1a1a19);
    --surface-3: light-dark(#e9e8e4, #20201e);
    --code-bg: light-dark(#efefec, #0e0e0d);

    /*
     * 线：不是边框，是光。用 6%–22% 的白/黑叠出来，
     * 在深底上像一条反光，在浅底上像一条折痕；比实色 #333 细一档。
     */
    --border-soft: light-dark(rgba(28, 26, 20, 0.06), rgba(255, 255, 255, 0.055));
    --border: light-dark(rgba(28, 26, 20, 0.1), rgba(255, 255, 255, 0.085));
    --border-strong: light-dark(rgba(28, 26, 20, 0.16), rgba(255, 255, 255, 0.14));
    --border-control: light-dark(rgba(28, 26, 20, 0.24), rgba(255, 255, 255, 0.22));
    --code-border: light-dark(rgba(28, 26, 20, 0.08), rgba(255, 255, 255, 0.07));

    /*
     * 三级文字。subtle 那一档是按“最深的底面”定的：
     * 它常常落在 surface-3（选中行、键帽、徽章）上，不是落在底色上，
     * 所以以 surface-3 为基准校到 5:1 以上，底色上自然更宽裕。
     */
    --fg: light-dark(#1b1a19, #eae9e6);
    --fg-muted: light-dark(#56544e, #a5a29c);
    --fg-subtle: light-dark(#64615b, #918e88);

    /* 品牌色不随底色改：绿仍是那个绿，只把压在浅底上的两档压深一档 */
    --accent: light-dark(#067a5b, #3ddc97);
    --accent-strong: light-dark(#04543f, #6ee7b7);
    --accent-ink: light-dark(#056b50, #6ee7b7);
    --accent-fg: light-dark(#fcfcfb, #08120d);
    --accent-soft: light-dark(rgba(6, 122, 91, 0.08), rgba(61, 220, 151, 0.1));
    --accent-line: light-dark(rgba(6, 122, 91, 0.26), rgba(61, 220, 151, 0.32));
    --accent-ring: light-dark(rgba(6, 122, 91, 0.16), rgba(61, 220, 151, 0.18));

    --danger: light-dark(#a8261c, #f9776f);
    --danger-fg: light-dark(#fcfcfb, #1a0806);
    --danger-soft: light-dark(rgba(168, 38, 28, 0.07), rgba(249, 119, 111, 0.1));
    --warn: light-dark(#7d4700, #e8b34a);
    --warn-soft: light-dark(rgba(125, 71, 0, 0.08), rgba(232, 179, 74, 0.1));
    --ok: light-dark(#067a5b, #3ddc97);

    --ring: light-dark(#067a5b, #3ddc97);
    /* 阴影也不用纯黑：一层暖灰 + 一层更深的暖灰，叠出厚度 */
    --shadow-color: light-dark(rgba(60, 56, 44, 0.1), rgba(0, 0, 0, 0.5));
    --shadow-color-deep: light-dark(rgba(60, 56, 44, 0.16), rgba(0, 0, 0, 0.62));
    --scrim: light-dark(rgba(28, 26, 20, 0.32), rgba(6, 6, 5, 0.68));

    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;
    --space-10: 40px;
    --space-12: 48px;

    /* 语义别名：名字说用途，别名词表之外不再出现裸字号 */
    --text-2xs: var(--font-size-2xs);
    --text-xs: var(--font-size-xs);
    --text-sm: var(--font-size-sm);
    --text-base: var(--font-size-base);
    --text-md: var(--font-size-md);
    --text-lg: var(--font-size-lg);
    --text-xl: var(--font-size-xl);
    --text-2xl: var(--font-size-2xl);
    --text-3xl: var(--font-size-3xl);

    --radius-xs: 6px;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-xl: 22px;

    --sidebar-w: 264px;
    /* 正文栏宽：820px 配 19.2px 等宽字约 43 个汉字一行，
       换成 16px 正文后 820px 会到 51 个，太宽；720px 落在 45 左右 */
    --content-w: 720px;
    --topbar-h: 56px;

    /*
     * ── 字重：深色底上整体降 40 ──
     *
     * 同一段白字放在深底上，笔画会被视觉“撑粗”一档，看起来比浅色的同一字重更胖。
     * 所以深色下每一档都减 40：400→360、500→460、550→510、650→610。
     * 变量字体（如 Inter Variable、思源可变体）会精确落到这些值；
     * 等宽静态字体只有 400/700 两档，浏览器会挑最近的一档，视觉上与浅色持平。
     */
    --fw-regular: 400;
    --fw-medium: 500;
    --fw-semibold: 550;
    --fw-strong: 600;
    --fw-bold: 650;

    --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
    --ease-smooth: cubic-bezier(0.215, 0.61, 0.355, 1);
    --dur: 160ms;
    --dur-slow: 260ms;

    /*
     * ── 弹簧 ──
     *
     * 由刚度/阻尼比直接数值积分出来的 easing 曲线，不是手调的 cubic-bezier。
     *
     * 过阻尼 1200/80（ζ=1.16）：冲出去之前就刹住，零回弹。
     * 给抽屉、菜单、折叠这类“位置必须一次到位”的移动用——回弹会让人以为没拖准。
     *
     * 欠阻尼 380/18（ζ=0.46）：冲过头 19%，再落回来。
     * 只给“做成了”这种一瞬间的确认用，比如复制成功的对勾。
     */
    --spring-snap: linear(
        0 0%,
        0.106 4%,
        0.289 8%,
        0.461 12%,
        0.601 15%,
        0.707 19%,
        0.786 23%,
        0.845 27%,
        0.887 31%,
        0.918 35%,
        0.941 38%,
        0.957 42%,
        0.969 46%,
        0.977 50%,
        0.984 54%,
        0.988 58%,
        0.991 62%,
        0.994 65%,
        0.995 69%,
        0.997 73%,
        0.998 77%,
        0.999 85%,
        1 100%
    );
    --spring-pop: linear(
        0 0%,
        0.094 4%,
        0.312 8%,
        0.572 12%,
        0.815 15%,
        1.006 19%,
        1.129 23%,
        1.186 27%,
        1.192 31%,
        1.162 35%,
        1.114 38%,
        1.064 42%,
        1.02 46%,
        0.988 50%,
        0.969 54%,
        0.962 58%,
        0.972 65%,
        0.982 69%,
        0.991 73%,
        0.999 77%,
        1.004 81%,
        1.007 85%,
        1.003 96%,
        1 100%
    );
    --dur-snap: 420ms;
    --dur-pop: 620ms;

    --scrollbar-thumb: var(--border-strong);
    --scrollbar-thumb-hover: var(--fg-subtle);

    --shadow-1: 0 1px 2px var(--shadow-color), 0 1px 1px -1px var(--shadow-color-deep);
    --shadow-2: 0 2px 6px -4px var(--shadow-color-deep), 0 16px 40px -24px var(--shadow-color-deep);
    --shadow-3: 0 4px 12px -8px var(--shadow-color-deep), 0 32px 72px -40px var(--shadow-color-deep);
}

:root[data-theme="light"] {
    color-scheme: light;
}

:root[data-theme="dark"] {
    color-scheme: dark;
}

/* 跟随系统时，若系统是深色，同样要降字重（不能只写在 data-theme="dark" 上） */
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
        --fw-regular: 360;
        --fw-medium: 460;
        --fw-semibold: 510;
        --fw-strong: 560;
        --fw-bold: 610;
    }
}

:root[data-theme="dark"] {
    --fw-regular: 360;
    --fw-medium: 460;
    --fw-semibold: 510;
    --fw-strong: 560;
    --fw-bold: 610;
}

/* ── 基础 ─────────────────────────────────────────────────── */

*,
*::before,
*::after {
    box-sizing: border-box;
}

[hidden] {
    display: none !important;
}

html,
body {
    height: 100%;
}

html {
    /* 与 wellspring-code 一致：根字号默认 1rem，字号 token 本身用 rem，可整体等比缩放 */
    font-size: var(--ui-font-size, 1rem);
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
}

body {
    margin: 0;
    font-family: var(--font-ui);
    font-size: var(--text-base);
    font-weight: var(--fw-regular);
    line-height: 1.6;
    /* 数字锁等宽：计数、token、耗时在刷新时不会左右跳 */
    font-variant-numeric: tabular-nums;
    /* 防孤字：最后一行不留下一个孤零零的字 */
    text-wrap: pretty;
    color: var(--fg);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

h1,
h2,
h3,
h4,
h5,
h6,
p,
ul,
ol,
dl,
dd,
figure {
    margin: 0;
}

button,
input,
textarea,
select {
    font: inherit;
    color: inherit;
}

button {
    cursor: pointer;
}

svg {
    display: block;
    flex: none;
}

a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-thickness: 1px;
}

a:hover {
    color: var(--accent-strong);
}

/* 选中底色：accent-soft 只有 9–12% 不透明度，选中的字几乎看不出被选中 */
::selection {
    background: var(--accent-line);
}

:where(a, button, input, textarea, select, summary, [tabindex]):focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
}

/*
 * 浏览器自带的那几处界面也属于设计：滚动条、输入光标、数字对齐。
 * 默认滚动条是系统灰，在深色底上是一条白边；光标默认是正文色，
 * 在强调色的输入框里对不上。这里统一收到调色板上。
 */

* {
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) transparent;
}

::-webkit-scrollbar {
    width: 10px;
    height: 10px;
}

::-webkit-scrollbar-track {
    background: transparent;
}

::-webkit-scrollbar-thumb {
    border: 3px solid transparent;
    border-radius: 999px;
    background: var(--scrollbar-thumb);
    background-clip: content-box;
}

::-webkit-scrollbar-thumb:hover {
    background: var(--scrollbar-thumb-hover);
    background-clip: content-box;
}

::-webkit-scrollbar-corner {
    background: transparent;
}

textarea,
input {
    caret-color: var(--accent);
}

.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
}

.skip-link {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 100;
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: var(--fw-strong);
    text-decoration: none;
    transform: translateY(-200%);
    transition: transform var(--dur) var(--ease);
}

.skip-link:focus-visible {
    transform: translateY(0);
}

.sprite {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
}

/*
 * 图标默认按 -0.125em 下沉：和同行的字一起读，视觉重心落在小写字母的中心，
 * 而不是浮在字头上。flex 容器里的图标不受影响（flex 项不看 vertical-align）。
 */
.icon {
    display: inline-block;
    width: 18px;
    height: 18px;
    vertical-align: -0.125em;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.icon-sm {
    width: 15px;
    height: 15px;
}

.icon-lg {
    width: 22px;
    height: 22px;
}

/* ── 控件 ─────────────────────────────────────────────────── */

.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 34px;
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg);
    font-size: var(--text-sm);
    font-weight: var(--fw-semibold);
    line-height: 1;
    white-space: nowrap;
    text-decoration: none;
    transition:
        background var(--dur) var(--ease),
        border-color var(--dur) var(--ease),
        color var(--dur) var(--ease),
        opacity var(--dur) var(--ease);
}

.btn:disabled,
.btn[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn:active:not(:disabled) {
    transform: translateY(1px);
}

.btn-primary {
    background: var(--accent);
    color: var(--accent-fg);
    box-shadow: var(--shadow-1);
}

.btn-primary:hover:not(:disabled) {
    background: var(--accent-strong);
}

.btn-outline {
    border-color: transparent;
    background: var(--surface-2);
}

.btn-outline:hover:not(:disabled) {
    background: var(--surface-3);
    border-color: var(--fg-subtle);
}

.btn-ghost {
    color: var(--fg-muted);
}

.btn-ghost:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--fg);
}

.btn-danger {
    background: var(--danger);
    color: var(--danger-fg);
}

.btn-danger-ghost {
    color: var(--danger);
    border-color: var(--danger-soft);
}

.btn-danger-ghost:hover:not(:disabled) {
    background: var(--danger-soft);
}

.btn-icon {
    width: 34px;
    min-height: 34px;
    padding: 0;
}

.btn-block {
    width: 100%;
}

.btn-sm {
    min-height: 28px;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
}

.btn[aria-busy="true"] {
    cursor: progress;
}

.spinner {
    width: 15px;
    height: 15px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
}

@keyframes menu-in {
    from {
        opacity: 0;
        transform: translateX(-50%) scale(0.98);
    }
    to {
        opacity: 1;
        transform: translateX(-50%) scale(1);
    }
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

.field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
}

.field > label {
    font-size: var(--text-sm);
    font-weight: var(--fw-strong);
}

.input,
.textarea {
    width: 100%;
    min-height: 38px;
    padding: 8px var(--space-3);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--fg);
    transition:
        border-color var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
}

.input::placeholder,
.textarea::placeholder {
    color: var(--fg-subtle);
}

/*
 * ── 输入框聚焦：不加 outline，用双环咬合 ──
 *
 * 内环 1px 贴住控件边（强调色），外环 3px 与底面的底色咬在一起，
 * 两环之间留 1px 的空隙，像两个同心的套件卡进底板。
 * 比 outline 柔和，但因为是“实色内环 + 相邻明度外环”，边界比单色描边更清楚，
 * 键盘与鼠标都读得出焦点落在哪个控件上。
 * 无效态只换色，不换结构：环的形状不变，避免输入时轮廓跳动。
 */
.input:focus,
.textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow:
        0 0 0 1px var(--accent),
        0 0 0 4px var(--accent-ring);
}

.input[aria-invalid="true"] {
    border-color: var(--danger);
}

.input[aria-invalid="true"]:focus {
    box-shadow:
        0 0 0 1px var(--danger),
        0 0 0 4px var(--danger-soft);
}

.input-group {
    position: relative;
}

.input-group .input {
    padding-right: 46px;
}

.input-action {
    position: absolute;
    top: 50%;
    right: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--fg-subtle);
    transform: translateY(-50%);
}

.input-action:hover {
    background: var(--surface-3);
    color: var(--fg);
}

.hint {
    font-size: var(--text-xs);
    color: var(--fg-subtle);
    line-height: 1.5;
}

.field-error {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--danger);
}

.error-summary {
    margin-bottom: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
}

.error-summary:focus-visible {
    outline: 2px solid var(--danger);
    outline-offset: 2px;
}

.error-summary-title {
    font-size: var(--text-sm);
    font-weight: var(--fw-bold);
    color: var(--danger);
}

.error-summary ul {
    margin: var(--space-2) 0 0;
    padding-left: var(--space-5);
    font-size: var(--text-sm);
}

.error-summary a {
    color: var(--danger);
}

.badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border: 0;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: var(--fw-semibold);
    line-height: 1.6;
    white-space: nowrap;
}

.badge-ok {
    background: var(--accent-soft);
    color: var(--accent-ink);
}

.badge-warn {
    background: var(--warn-soft);
    color: var(--warn);
}

.badge-error {
    background: var(--danger-soft);
    color: var(--danger);
}

.dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
}

kbd {
    display: inline-block;
    min-width: 18px;
    padding: 1px 5px;
    border: 0;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.5;
    text-align: center;
}

/* ── 品牌 ─────────────────────────────────────────────────── */

.brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    font-size: var(--text-md);
    font-weight: var(--fw-bold);
    letter-spacing: -0.01em;
    color: var(--fg);
}

.mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: linear-gradient(150deg, var(--accent), var(--accent-strong));
    color: var(--accent-fg);
    box-shadow: var(--shadow-1);
}

.mark .icon {
    width: 19px;
    height: 19px;
    stroke-width: 1.9;
}

.mark-lg {
    width: 46px;
    height: 46px;
    border-radius: 14px;
}

.mark-lg .icon {
    width: 28px;
    height: 28px;
}

/* ── 启动态 ───────────────────────────────────────────────── */

.boot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    min-height: 100dvh;
    color: var(--fg-subtle);
    font-size: var(--text-sm);
}

.boot .mark {
    animation: breathe 2.4s var(--ease) infinite;
}

@keyframes breathe {
    0%,
    100% {
        opacity: 1;
        transform: scale(1);
    }
    50% {
        opacity: 0.72;
        transform: scale(0.96);
    }
}

/* ── 认证页 ───────────────────────────────────────────────── */

.auth {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, 520px);
    min-height: 100dvh;
    background:
        radial-gradient(80% 60% at 8% 0%, var(--accent-soft), transparent 62%),
        var(--bg);
}

.auth-aside {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--space-10);
    padding: clamp(32px, 5vw, 64px);
    border-right: 1px solid var(--border-soft);
}

.auth-headline {
    max-width: 15ch;
    margin-top: var(--space-8);
    font-size: clamp(1.875rem, 3.4vw, 2.75rem);
    font-weight: var(--fw-bold);
    line-height: 1.16;
    letter-spacing: -0.025em;
}

.auth-copy {
    max-width: 42ch;
    margin-top: var(--space-4);
    color: var(--fg-muted);
    font-size: var(--text-md);
    line-height: 1.7;
}

.auth-points {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-8);
    padding: 0;
    list-style: none;
    color: var(--fg-muted);
    font-size: var(--text-sm);
}

.auth-points li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}

.auth-points .icon {
    width: 17px;
    height: 17px;
    color: var(--accent);
}

.auth-foot {
    color: var(--fg-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
}

.auth-main {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(24px, 5vw, 48px);
}

.auth-card {
    width: 100%;
    max-width: 400px;
}

.auth-card h1 {
    font-size: var(--text-2xl);
    font-weight: var(--fw-bold);
    letter-spacing: -0.02em;
}

.auth-sub {
    margin: var(--space-2) 0 var(--space-6);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 1.65;
}

.auth-form {
    margin-top: var(--space-2);
}

.auth-caps {
    margin-top: var(--space-2);
    color: var(--warn);
    font-size: var(--text-xs);
}

.auth-mobile-brand {
    display: none;
    margin-bottom: var(--space-6);
}

/* ── 应用外壳 ─────────────────────────────────────────────── */

.app {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    min-height: 100dvh;
    height: 100dvh;
    overflow: hidden;
    background: var(--bg);
}

.sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: var(--space-3) var(--space-3) calc(var(--space-3) + env(safe-area-inset-bottom));
    border-right: 1px solid var(--border-soft);
    background: var(--bg-elev);
}

.sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-1) var(--space-2) var(--space-3);
}

.sidebar-close {
    display: none;
}

.workspace-section {
    margin-bottom: var(--space-2);
}

.workspace-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 38vh;
    margin: 0;
    padding: 0 var(--space-1) var(--space-1);
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
    scrollbar-width: thin;
}

.ws-row {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
}

.ws-row:hover {
    background: var(--surface-2);
}

.ws-row[data-active="true"] {
    background: var(--surface-3);
}

.ws-select {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    padding: 7px var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    text-align: left;
}

.ws-select:hover {
    color: var(--fg);
}

.ws-row[data-active="true"] .ws-select {
    color: var(--fg);
    font-weight: var(--fw-strong);
}

.ws-select .icon {
    color: var(--accent);
}

.ws-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ws-count {
    color: var(--fg-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
}

/* 运行中提示：工作区行是呼吸的小圆点 */
.ws-running {
    flex: none;
    width: 6px;
    height: 6px;
    margin-right: 2px;
    border-radius: 50%;
    background: var(--accent);
    animation: ws-running-pulse 1.6s var(--ease) infinite;
}

/*
 * 会话行是底边滚动的脉冲条
 *
 * 会话行里标题与时间已经把横向位置占满，再塞一个圆点只能挤在中间；
 * 改贴底边一条细脉冲，既有「这一轮在跑」的动势，又不和文字抢位置。
 * 绝对定位相对 .conv（最近的定位祖先），两端留出与圆角半径相当的间距，
 * 不压到标题、时间和删除按钮。
 */
.conv-running {
    position: absolute;
    right: var(--space-3);
    bottom: 0;
    left: var(--space-3);
    height: 2px;
    border-radius: 1px;
    background-image: linear-gradient(
        90deg,
        transparent 0%,
        color-mix(in srgb, var(--accent) 40%, transparent) 35%,
        var(--accent) 50%,
        color-mix(in srgb, var(--accent) 40%, transparent) 65%,
        transparent 100%
    );
    background-repeat: no-repeat;
    background-size: 40% 100%;
    animation: conv-running-sweep 1.7s linear infinite;
}

@keyframes ws-running-pulse {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0.35;
    }
}

/* 从左侧外滚到右侧外：两端 100% 是 background-position 的极值，位移全程可见 */
@keyframes conv-running-sweep {
    from {
        background-position: -100% 0;
    }
    to {
        background-position: 200% 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .ws-running {
        animation: none;
    }
    /* 不滚动：留一条静止的低对比底线，仍然表示「在跑」 */
    .conv-running {
        background-image: none;
        background-color: color-mix(in srgb, var(--accent) 45%, transparent);
        animation: none;
    }
}

.ws-del {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    min-height: 30px;
    margin-right: 2px;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--fg-subtle);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
}

.ws-row:hover .ws-del,
.ws-row:focus-within .ws-del,
.ws-del:focus-visible {
    opacity: 1;
}

.ws-del:hover {
    color: var(--danger);
    background: var(--danger-soft);
}

.workspace-add {
    width: 100%;
    justify-content: flex-start;
    margin-top: var(--space-1);
    color: var(--fg-muted);
}

.workspace-empty {
    padding: 4px var(--space-2) var(--space-2);
    color: var(--fg-subtle);
    font-size: var(--text-xs);
}

.btn-new {
    justify-content: flex-start;
    width: 100%;
    min-height: 40px;
    padding: 0 var(--space-3);
    border-color: var(--border);
    background: var(--surface-2);
    color: var(--fg);
    font-weight: var(--fw-strong);
}

.btn-new:hover:not(:disabled) {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
}

.btn-new .icon {
    color: var(--accent);
}

/*
 * 侧栏分区标签：中文没有大小写，text-transform 是空操作；
 * 0.08em 字距只会把汉字拉散。改成 12px + 半粗 + muted。
 */
.sidebar-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin: var(--space-5) var(--space-2) var(--space-2);
    color: var(--fg-muted);
    font-size: var(--text-2xs);
    font-weight: var(--fw-strong);
}

/* 侧栏中段：工作区、新对话与最近会话共用一个滚动区，底栏固定 */
.sidebar-scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
}

.conv-list {
    flex: 1 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 var(--space-1) var(--space-2);
}

/* 工作区折叠头：整行可点，折叠后右侧显示当前工作区 */
/*
 * 折叠头（侧栏「工作区」与底栏「设置」共用）
 *
 * 必须是 flex 行：图标 18px、文字 12px，按行内基线排版时图标被顶高 3px、
 * 文字压低 2px，看起来就没居中。flex + align-items: center 让两者共用一条中线。
 * 这里不写 justify-content：底栏继承 flex-start（左对齐，与侧栏其它行一致），
 * 分区头由 .sidebar-section 的 space-between 把计数推到右端。
 */
.sidebar-fold {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin: var(--space-1) 0 var(--space-2);
    padding: var(--space-1) var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-2xs);
    font-weight: var(--fw-strong);
    text-align: left;
    cursor: pointer;
}

.sidebar-fold:hover {
    background: var(--surface-2);
    color: var(--fg-muted);
}

.sidebar-fold-caret {
    display: inline-flex;
    flex: none;
    color: var(--fg-subtle);
    transition: transform var(--dur) var(--ease);
}

.sidebar-fold[aria-expanded="false"] .sidebar-fold-caret {
    transform: rotate(-90deg);
}

.sidebar-fold-value {
    margin-left: auto;
    max-width: 9em;
    overflow: hidden;
    color: var(--fg-muted);
    letter-spacing: 0;
    text-transform: none;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.conv-empty {
    padding: var(--space-3) var(--space-2);
    color: var(--fg-subtle);
    font-size: var(--text-xs);
    line-height: 1.6;
}

.conv {
    position: relative;
    display: flex;
    align-items: stretch;
    border-radius: var(--radius-sm);
}

.conv:hover {
    background: var(--surface-2);
}

.conv[data-active="true"] {
    background: var(--surface-3);
}

.conv[data-active="true"]::before {
    content: "";
    position: absolute;
    top: 8px;
    bottom: 8px;
    left: 0;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
}

.conv-select {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 6px var(--space-2) 6px var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    text-align: left;
    text-decoration: none;
}

.conv-select:hover {
    color: var(--fg);
}

.conv[data-active="true"] .conv-select {
    color: var(--fg);
}

.conv-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    line-height: 1.4;
}

.conv-time {
    color: var(--fg-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.35;
}

.conv-del {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    min-height: 100%;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-subtle);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
}

.conv:hover .conv-del,
.conv:focus-within .conv-del,
.conv-del:focus-visible {
    opacity: 1;
}

.conv-del:hover {
    color: var(--danger);
    background: var(--danger-soft);
}

.sidebar-foot {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: var(--space-3);
    box-shadow: inset 0 1px 0 var(--border-soft);
}

.sidebar-foot .btn {
    justify-content: flex-start;
    width: 100%;
}

.sidebar-foot-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

/* 底栏折叠头上的间距比侧栏中段小：它贴着抽屉底边 */
.foot-fold {
    margin: 0 0 var(--space-1);
}

.sidebar-addons {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-1) var(--space-3);
    border-top: 1px solid var(--border-soft);
}

.sidebar-addons[hidden] {
    display: none;
}

.sidebar-addons a {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    font-size: 0.75rem;
    text-decoration: none;
}

.sidebar-addons a:hover {
    background: var(--surface-3);
    color: var(--fg);
}

.host-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2) 0;
    color: var(--fg-subtle);
    font-size: var(--text-2xs);
}

.host-line .version {
    margin-left: auto;
    font-family: var(--font-mono);
}

.host-line[data-state="ok"] .dot {
    background: var(--ok);
}

.host-line[data-state="error"] {
    color: var(--danger);
}

.host-line[data-state="error"] .dot {
    background: var(--danger);
}

.scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    animation: scrim-in var(--dur-snap) var(--spring-snap) both;
}

@keyframes scrim-in {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}

/* ── 主区 ─────────────────────────────────────────────────── */

.main {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100dvh;
}

.topbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
    min-height: var(--topbar-h);
    padding: 0 clamp(16px, 3vw, 28px);
    /* 分隔痕用内阴影画：不是边框，是一层更亮/更暗的边，随底色一起变 */
    box-shadow: inset 0 -1px 0 var(--border-soft);
    background: var(--bg);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
}

.topbar-title {
    min-width: 0;
    flex: 1;
}

.topbar-title h1 {
    text-wrap: balance;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-md);
    font-weight: var(--fw-strong);
    letter-spacing: -0.01em;
    line-height: 1.3;
}

.topbar-title p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
}

.topbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
}

.only-mobile {
    display: none;
}

/* ── 消息 ─────────────────────────────────────────────────── */

.messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scroll-padding-bottom: 24px;
    padding: var(--space-6) clamp(16px, 3vw, 28px) var(--space-4);
}

/*
 * 消息的节奏：一轮之内（用户提问 → 助手回复）挨紧，轮与轮之间放开。
 * 之前所有消息共用 24px 间距，一屏下来像一串等距的卡片，
 * 看不出哪句是新一轮的起点。
 */
.messages-inner {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: min(100%, var(--content-w));
    margin: 0 auto;
}

.msg + .msg-user {
    margin-top: var(--space-4);
}

/* 默认折叠的早期消息：顶部居中一颗胶囊按钮，点一次补一页 */
.load-earlier {
    display: flex;
    justify-content: center;
}

.load-earlier-btn {
    min-height: 28px;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    font-weight: var(--fw-medium);
    transition:
        background var(--dur) var(--ease),
        border-color var(--dur) var(--ease),
        color var(--dur) var(--ease);
}

.load-earlier-btn:hover {
    background: var(--surface-3);
    border-color: var(--border-strong);
    color: var(--fg);
}

.msg {
    display: flex;
    gap: var(--space-3);
    animation: rise 220ms var(--ease-smooth) both;
}

/* 已经结束渲染的消息不重复播放入场动画（流式完成时会替换节点） */
.msg[data-settled="true"] {
    animation: none;
}

@keyframes rise {
    from {
        opacity: 0;
        transform: translateY(6px);
    }
    to {
        opacity: 1;
        transform: none;
    }
}

.msg-user {
    justify-content: flex-end;
}

.msg-avatar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-top: 2px;
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--accent);
}

.msg-avatar .icon {
    width: 16px;
    height: 16px;
}

.msg-assistant .msg-body {
    flex: 1;
    min-width: 0;
}

.msg-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    min-height: 20px;
    margin-bottom: 2px;
    color: var(--fg-subtle);
    font-size: var(--text-xs);
}

.msg-meta .name {
    color: var(--fg-muted);
    font-weight: var(--fw-strong);
}

.msg-meta .model {
    font-family: var(--font-mono);
}

.msg-meta .sep {
    opacity: 0.5;
}

/* 用户消息：气泡按内容自适应宽度，避免中文在收缩的 flex 项里逐字换行 */
.msg-user .msg-body {
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    max-width: min(78%, 62ch);
    min-width: 0;
}

.msg-user .msg-bubble {
    width: fit-content;
    max-width: 100%;
    text-wrap: pretty;
    padding: 10px var(--space-4);
    border: 0;
    border-radius: var(--radius-lg) var(--radius-lg) var(--radius-xs) var(--radius-lg);
    background: var(--accent-soft);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--text-md);
    line-height: 1.65;
}

.msg-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-2);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
}

.msg:hover .msg-actions,
.msg:focus-within .msg-actions,
.msg-actions[data-pinned="true"] {
    opacity: 1;
}

.msg-actions .btn {
    min-height: 28px;
    padding: 0 var(--space-2);
    color: var(--fg-subtle);
    font-size: var(--text-xs);
}

.msg-actions .btn:hover:not(:disabled) {
    color: var(--fg);
}

/* 回复下方的 token 用量与缓存命中：常显、可点开本轮明细 */
.msg-usage {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    max-width: 100%;
    min-height: 26px;
    margin-top: var(--space-1);
    padding: 1px var(--space-2);
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--fg-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.7;
    cursor: pointer;
    transition:
        color var(--dur) var(--ease),
        background var(--dur) var(--ease);
}

.msg-usage:hover {
    background: var(--surface-2);
    color: var(--fg);
}

.msg-stopped,
.msg-error {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--space-2);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: var(--text-xs);
}

.msg-stopped {
    background: var(--warn-soft);
    color: var(--warn);
}

.msg-error {
    background: var(--danger-soft);
    color: var(--danger);
}

.msg-error-box {
    margin-top: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--text-sm);
    line-height: 1.6;
    overflow-wrap: anywhere;
}

/*
 * 流式逐字入场
 *
 * 每个新到的字从 blur(6px) 和 40% 透明度落到清晰，90ms 一个字，
 * 相邻字错开 30ms。合成在一句话里，看起来是一片文字“晕开”而不是整块闪现。
 * 缓动用 cubic-bezier(.215,.61,.355,1)：起步快、收尾长，读起来像笔尖在走。
 */
.tchar {
    animation: tchar-in 90ms cubic-bezier(0.215, 0.61, 0.355, 1) both;
    animation-delay: var(--d, 0ms);
}

@keyframes tchar-in {
    from {
        opacity: 0.4;
        filter: blur(6px);
    }
    to {
        opacity: 1;
        filter: blur(0);
    }
}

/* 流式光标 */
.md.is-streaming > :last-child::after {
    content: "";
    display: inline-block;
    width: 7px;
    height: 1.05em;
    margin-left: 3px;
    border-radius: 2px;
    background: var(--accent);
    vertical-align: text-bottom;
    animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
    50% {
        opacity: 0;
    }
}

/* ── Agent 过程：思考链与工具调用 ────────────────────────── */

.msg-content {
    display: flex;
    flex-direction: column;
}

.msg-content > .md {
    min-width: 0;
}

/* 正文与思考/工具行按发生顺序穿插，行之间留一点呼吸 */
.msg-content > .proc-row {
    margin: 2px 0;
}

.msg-content > .proc-row + .md,
.msg-content > .md + .proc-row {
    margin-top: 2px;
}

.proc-row {
    border-radius: var(--radius-sm);
}

.proc-row[data-open="true"] {
    background: var(--surface-2);
}

.proc-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-height: 30px;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-subtle);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
}

.proc-head:hover {
    background: var(--surface-2);
    color: var(--fg-muted);
}

.proc-row[data-open="true"] .proc-head:hover {
    background: transparent;
}

.proc-icon {
    flex: none;
    display: inline-flex;
    color: var(--fg-subtle);
}

.proc-row[data-state="running"] .proc-icon {
    color: var(--accent);
}

.proc-row[data-state="error"] .proc-icon,
.proc-row[data-state="error"] .proc-status {
    color: var(--danger);
}

/*
 * 插话行：和思考/工具行同一条时间线，用强调色整行区分。
 * 原来靠 inset 2px 强调色左边条，卡片上的彩色竖条是最省事的“提示”做法，
 * 换成整行淡底 + 强调色的行首字（“插话”本身已经是标签）。
 */
.proc-row[data-kind="steer"] {
    margin: 4px 0;
    padding: 0 var(--space-1);
    background: var(--accent-soft);
}

.proc-row[data-kind="steer"] .proc-icon,
.proc-row[data-kind="steer"] .proc-title {
    color: var(--accent-ink);
}

.proc-row[data-kind="steer"] .proc-summary-text,
.proc-row[data-kind="steer"] .proc-body {
    color: var(--fg);
}

.proc-row[data-kind="steer"] .proc-head:hover {
    background: transparent;
}

.proc-row[data-kind="steer"][data-open="true"] {
    background: var(--accent-soft);
}

.proc-title {
    flex: none;
    color: var(--fg-muted);
    font-weight: var(--fw-strong);
}

.proc-summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/*
 * 运行中的那一行：文字在呼吸。
 * 原来是“渐变扫过文字”（background-clip: text + 透明填充），
 * 那是装饰不是信息，而且扫动会一直抢视线；只让透明度轻微起伏，
 * 阅读时不打断，静止时也能看出这一行还在跑。
 */
.proc-summary-text[data-shimmer="true"] {
    color: var(--fg-muted);
    animation: proc-breathe 1.5s var(--ease) infinite;
}

@keyframes proc-breathe {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0.45;
    }
}

.proc-status {
    flex: none;
    color: var(--fg-muted);
    font-size: var(--text-xs);
}

.proc-chevron {
    flex: none;
    display: inline-flex;
    color: var(--fg-subtle);
    transition: transform var(--dur) var(--ease);
}

.proc-row[data-open="true"] .proc-chevron {
    transform: rotate(90deg);
}

/*
 * 折叠：grid-template-rows 从 0fr 到 1fr。
 * 高度由浏览器插值，不用读 scrollHeight，内容在展开过程中变高也不会跳。
 * 收起态给 visibility: hidden（延迟到动画结束）——不可见也不可 Tab，
 * 但保留在布局里，展开时不需要重新挂载。
 */
.fold,
.proc-fold {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--dur-slow) var(--spring-snap);
}

.fold[data-open="true"],
.proc-fold[data-open="true"] {
    grid-template-rows: 1fr;
}

.fold > *,
.proc-fold > * {
    min-height: 0;
    overflow: hidden;
}

/*
 * 收起时纵向内距也要归零：padding 不会随 grid 轨道一起插值到 0，
 * 留着它，收起后的过程行会拖一条 14px 的空带。
 */
.fold[data-open="false"] > *,
.proc-fold[data-open="false"] > * {
    padding-top: 0;
    padding-bottom: 0;
    visibility: hidden;
    transition:
        visibility 0s linear var(--dur-slow),
        padding var(--dur) var(--ease);
}

.proc-fold {
    transition-duration: 200ms;
}

.proc-body {
    padding: 2px var(--space-3) var(--space-3) 30px;
    transition: padding var(--dur) var(--ease);
    color: var(--fg-muted);
    font-size: var(--text-sm);
}

.proc-body .md {
    font-size: var(--text-sm);
    line-height: 1.68;
}

.proc-section + .proc-section {
    margin-top: var(--space-2);
}

.proc-section-title {
    margin-bottom: 4px;
    color: var(--fg-muted);
    font-size: var(--text-xs);
}

.proc-pre {
    max-height: 300px;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    overflow: auto;
    border: 1px solid var(--code-border);
    border-radius: var(--radius-xs);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.proc-empty {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-xs);
}

/* ── Markdown 正文 ────────────────────────────────────────── */

.md {
    font-size: var(--text-md);
    line-height: 1.7;
    text-wrap: pretty;
    overflow-wrap: anywhere;
}

.md > * + * {
    margin-top: 0.85em;
}

.md h2,
.md h3,
.md h4,
.md h5,
.md h6 {
    margin: 1.5em 0 0.55em;
    font-weight: var(--fw-bold);
    line-height: 1.3;
    letter-spacing: -0.015em;
}

.md h2 {
    font-size: var(--text-xl);
}

.md h3 {
    font-size: var(--text-lg);
}

.md h4 {
    font-size: var(--text-md);
}

.md h5,
.md h6 {
    font-size: var(--text-base);
    color: var(--fg-muted);
}

.md p {
    margin: 0.7em 0;
}

.md > p:first-child {
    margin-top: 0;
}

.md ul,
.md ol {
    margin: 0.6em 0;
    padding-left: 1.4em;
}

.md li + li {
    margin-top: 0.32em;
}

.md li > ul,
.md li > ol {
    margin: 0.3em 0 0;
}

.md a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
}

.md strong {
    font-weight: var(--fw-bold);
    color: var(--fg);
}

.md em {
    font-style: italic;
}

.md del {
    color: var(--fg-subtle);
}

.md code {
    padding: 0.12em 0.38em;
    border: 1px solid var(--code-border);
    border-radius: var(--radius-xs);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: 0.875em;
}

.md blockquote {
    margin: 0.9em 0;
    padding: 0.5em var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--fg-muted);
}

.md hr {
    margin: 1.6em 0;
    border: 0;
    border-top: 1px solid var(--border);
}

.md .table-wrap {
    overflow-x: auto;
    margin: 1em 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
}

.md table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
}

.md th,
.md td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-soft);
    text-align: left;
    vertical-align: top;
}

.md th {
    background: var(--surface-2);
    color: var(--fg-muted);
    font-weight: var(--fw-strong);
    white-space: nowrap;
}

.md tr:last-child td {
    border-bottom: 0;
}

.md .task {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}

.md .task input {
    margin: 0;
    accent-color: var(--accent);
}

.code-block {
    margin: 1em 0;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--code-bg);
    overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--code-border);
}

.code-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 5px var(--space-2) 5px var(--space-3);
    border-bottom: 1px solid var(--code-border);
    background: var(--surface-2);
    color: var(--fg-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.03em;
}

.code-copy {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 26px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--fg-subtle);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
}

.code-copy:hover {
    background: var(--surface-3);
    color: var(--fg);
}

/*
 * 复制成功的确认：对勾用欠阻尼弹簧（380/18）弹一下，
 * 2.5 秒后由脚本摘掉 data-copied，靠 opacity 过渡自己淡回去。
 * 只弹一次，不循环——它不是加载指示器。
 */
.code-copy[data-copied="true"],
.msg-actions .btn[data-copied="true"] {
    color: var(--accent);
}

.code-copy[data-copied="true"] .icon,
.msg-actions .btn[data-copied="true"] .icon {
    animation: pop-in var(--dur-pop) var(--spring-pop) both;
}

@keyframes pop-in {
    from {
        opacity: 0;
        transform: scale(0.4);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

/* 恢复时给一点淡出，别硬切回“复制”两个字 */
.code-copy span,
.msg-actions .btn span {
    transition: opacity var(--dur) var(--ease);
}

.code-copy[data-copied="true"] span,
.msg-actions .btn[data-copied="true"] span {
    opacity: 0.9;
}

.code-block pre {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    overflow-x: auto;
}

.code-block pre code {
    padding: 0;
    border: 0;
    background: none;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.65;
    white-space: pre;
    tab-size: 4;
}

/* ── 空状态 ───────────────────────────────────────────────── */

.empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    min-height: 100%;
    padding: var(--space-8) 0 var(--space-12);
    animation: rise 260ms var(--ease) both;
}

.empty-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
}

.empty-title {
    text-wrap: balance;
    font-size: var(--text-2xl);
    font-weight: var(--fw-bold);
    letter-spacing: -0.025em;
    line-height: 1.25;
}

.empty-copy {
    max-width: 52ch;
    color: var(--fg-muted);
    font-size: var(--text-md);
    line-height: 1.7;
}

.suggestions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
    width: 100%;
    margin-top: var(--space-8);
}

.suggestion {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: var(--space-4);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--fg);
    text-align: left;
    text-decoration: none;
    transition:
        border-color var(--dur) var(--ease),
        background var(--dur) var(--ease),
        transform var(--dur) var(--ease);
}

.suggestion:hover {
    border-color: var(--accent-line);
    background: var(--surface-2);
    transform: translateY(-1px);
}

.suggestion .label {
    font-size: var(--text-sm);
    font-weight: var(--fw-strong);
}

.suggestion .desc {
    color: var(--fg-subtle);
    font-size: var(--text-xs);
    line-height: 1.5;
}

.suggestion .icon {
    color: var(--accent);
}

/* ── 输入区 ───────────────────────────────────────────────── */

.composer-wrap {
    position: relative;
    flex: none;
    padding: var(--space-2) clamp(16px, 3vw, 28px) calc(var(--space-4) + env(safe-area-inset-bottom));
    background: linear-gradient(to top, var(--bg) 62%, transparent);
}

.trigger-menu {
    position: absolute;
    left: 50%;
    bottom: calc(100% - var(--space-2));
    z-index: 40;
    transform-origin: bottom center;
    animation: menu-in 180ms var(--spring-snap) both;
    width: min(100%, var(--content-w));
    max-height: min(42dvh, 320px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: translateX(-50%);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-3);
}

.trigger-menu[hidden] {
    display: none;
}

.trigger-title {
    margin: 0;
    padding: var(--space-2) var(--space-3) 4px;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.trigger-list {
    margin: 0;
    padding: 0 var(--space-1) var(--space-1);
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
    scrollbar-width: thin;
}

.trigger-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 7px var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    cursor: pointer;
    font-size: var(--text-sm);
}

.trigger-item[aria-selected="true"],
.trigger-item:hover {
    background: var(--surface-3);
    color: var(--fg);
}

.trigger-item[data-disabled="true"] {
    color: var(--fg-subtle);
    cursor: default;
}

.trigger-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.trigger-body {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    flex: 1;
}

.trigger-name {
    overflow: hidden;
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.trigger-mark {
    border-radius: 2px;
    background: transparent;
    color: var(--accent);
    font-weight: var(--fw-strong);
}

.trigger-desc {
    overflow: hidden;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.trigger-enter {
    color: var(--fg-subtle);
    font-size: var(--text-2xs);
}

.composer {
    position: relative;
    width: min(100%, var(--content-w));
    margin: 0 auto;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-2);
    transition:
        border-color var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
}

.composer:focus-within {
    border-color: var(--accent-line);
    box-shadow:
        0 0 0 1px var(--accent),
        0 0 0 4px var(--accent-ring),
        var(--shadow-2);
}

.composer.is-busy {
    border-color: var(--accent-line);
}

/* ── 输入框 @ 引用高亮 ──────────────────────────────────────
 * 镜像层垫在 textarea 下面，只画引用底纹；正文与输入法组合文字仍由 textarea 原生渲染
 */

.composer-field {
    position: relative;
}

.composer-highlight {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 0;
    overflow: hidden;
    color: transparent;
    pointer-events: none;
    user-select: none;
}

.composer-highlight-inner {
    box-sizing: border-box;
    padding: 10px var(--space-3);
    font: inherit;
    font-size: var(--text-md);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    tab-size: 4;
}

.composer-ref {
    border-radius: var(--radius-xs);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
}

/* 正在补全的那一段（菜单打开时）用更实的底纹 */
.composer-ref.is-active {
    background: var(--accent-line);
}

.composer textarea {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    min-height: 44px;
    max-height: 200px;
    padding: 10px var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg);
    font-size: var(--text-md);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    tab-size: 4;
    resize: none;
    outline: none;
}

.composer textarea::placeholder {
    color: var(--fg-subtle);
}

.composer-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 2px var(--space-1) 0;
}

/*
 * 提示行：一行「按键 + 动作」+（忙时）Esc 停止。
 * 不能 overflow: hidden——里面的发送键菜单要往上弹出去。
 * 截断交给里面的文字节点自己处理。
 */
.composer-hint {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
    white-space: nowrap;
}

.hint-plain {
    overflow: hidden;
    text-overflow: ellipsis;
}

/* ── 发送键选择器（提示行里的一颗按钮 + 上浮菜单） ──────── */

.hint-keys-wrap {
    /* 故意不定位：菜单以整块 .composer 为锚，才能浮到输入框上方而不是压住它 */
    flex: none;
}

.hint-keys {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-height: 22px;
    padding: 0 4px;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
    transition:
        background var(--dur) var(--ease),
        color var(--dur) var(--ease);
}

.hint-keys:hover,
.hint-keys[aria-expanded="true"] {
    background: var(--surface-3);
    color: var(--fg);
}

.hint-plus {
    color: var(--fg-subtle);
}

.hint-action {
    margin-left: 2px;
}

.hint-caret {
    color: var(--fg-subtle);
    transition: transform var(--dur) var(--ease);
}

.hint-keys[aria-expanded="true"] .hint-caret {
    transform: rotate(180deg);
}

/*
 * 菜单往上弹：输入区贴在视口底部，往下弹一定被切掉。
 * 与权限菜单共用 .perm-menu 里那套选项样式，视觉上属于同一族。
 */
.send-key-menu {
    position: absolute;
    left: var(--space-2);
    bottom: calc(100% + 8px);
    z-index: 46;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 268px;
    max-width: calc(100vw - 32px);
    padding: 6px;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-3);
    animation: menu-in 180ms var(--spring-snap) both;
}

.send-key-note {
    margin: 4px 8px 2px;
    color: var(--fg-subtle);
    font-size: var(--text-2xs);
    line-height: 1.5;
    white-space: normal;
}

/* 输入框下方的一行统计：上下文占用 / 会话用量 / 缓存命中率；点开是会话统计 */
.composer-stats {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 6px;
    width: min(100%, var(--content-w));
    min-height: 28px;
    margin: 0.2rem auto 0;
    padding: 2px var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.6;
    text-align: center;
    cursor: pointer;
    transition: color var(--dur) var(--ease);
}

.composer-stats:hover {
    color: var(--fg);
}

.composer-stats-context {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--fg-muted);
}

.composer-stats-sep {
    opacity: 0.5;
}

/*
 * 上下文占用：14px 的进度环换成 18×2 的细横条。
 * 环在 14px 上只剩两像素弧线，读不出比例；旁边的百分数才是信息，
 * 横条只是把比例画出来，粗细与字重一致。
 */
.meter-bar {
    position: relative;
    flex: none;
    width: 18px;
    height: 2px;
    border-radius: 999px;
    background: var(--border-strong);
    overflow: hidden;
}

.meter-bar-fill {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--accent);
    transform-origin: left center;
    transition: transform var(--dur) var(--ease);
}

.composer-stats-context[data-tone="warn"] .meter-bar-fill {
    background: var(--warn);
}

.composer-stats-context[data-tone="danger"] .meter-bar-fill {
    background: var(--danger);
}

/* ── 模型切换与供应商 ─────────────────────────────────────── */

.composer-model {
    position: relative;
    flex: none;
}

/* 关闭服务：侧栏按钮偏危险色，关闭后显示全屏提示 */
.shutdown-btn {
    color: var(--fg-subtle);
}

.shutdown-btn:hover {
    color: var(--danger);
}

.shutdown-screen {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-6);
    background: var(--bg);
    color: var(--fg-muted);
    text-align: center;
}

.shutdown-screen[hidden] {
    display: none;
}

.shutdown-screen h1 {
    margin: 0;
    color: var(--fg);
    font-size: var(--font-size-2xl);
    font-weight: var(--fw-strong);
}

.shutdown-screen p {
    max-width: 28em;
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.8;
}

.shutdown-screen code {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
}

.model-label {
    max-width: 12em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* 聊天栏的模型下拉：按供应商分组，只做切换 */
.model-menu {
    width: 300px;
}

.model-menu-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: min(46dvh, 360px);
    overflow-y: auto;
}

/* 推理等级行：四个档位切换 */
.model-menu-reasoning {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 8px 8px;
    border-bottom: 1px solid var(--border-soft);
    margin-bottom: 4px;
}

.model-menu-reasoning-label {
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    flex: none;
}

.model-menu-reasoning-options {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
}

.model-menu-reasoning-btn {
    padding: 2px 8px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--fg-subtle);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
}

.model-menu-reasoning-btn:hover {
    background: var(--surface-3);
    color: var(--fg);
}

.model-menu-reasoning-btn.is-active {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent-strong);
}

.model-menu-group {
    padding: 2px 0;
}

.model-menu-provider {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 8px 2px;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.model-menu-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
}

.model-menu-item:hover {
    background: var(--surface-3);
    color: var(--fg);
}

.model-menu-item.is-active {
    background: var(--accent-soft);
    color: var(--accent-strong);
}

.model-menu-item.is-active::after {
    content: "✓";
    margin-left: auto;
    font-size: var(--text-xs);
}

.model-menu-empty {
    padding: 6px 10px;
    color: var(--fg-subtle);
    font-size: var(--text-xs);
}

.model-menu-manage {
    margin-top: 4px;
    padding: 8px 10px;
    border: none;
    border-top: 1px solid var(--border-soft);
    background: transparent;
    color: var(--fg-subtle);
    font: inherit;
    font-size: var(--text-xs);
    text-align: left;
    cursor: pointer;
}

.model-menu-manage:hover {
    color: var(--fg);
}

.models-current {
    margin: var(--space-2) 0 var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--fg);
    font-size: var(--text-sm);
    line-height: 1.6;
}

.models-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
}

.models-provider {
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface-2);
}

.models-provider.is-active {
    border-color: var(--accent-line);
}

.models-provider-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
}

.models-provider-name {
    font-weight: var(--fw-strong);
}

.models-provider-meta {
    color: var(--fg-muted);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
}

.models-provider-head .models-remove {
    margin-left: auto;
}

.models-models {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
}

.models-model-btn {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
}

.models-model-btn:hover {
    border-color: var(--accent);
    color: var(--fg);
}

.models-model-btn.is-active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-strong);
}

.models-key-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-2);
}

.models-key-row .input {
    flex: 1;
    min-width: 0;
}

.models-add {
    margin: var(--space-2) 0 var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-soft);
}

.models-add h3 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
}

.models-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2) var(--space-3);
}

.models-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--fg-muted);
    font-size: var(--text-xs);
}

.models-field-wide {
    grid-column: 1 / -1;
}

.models-models-input {
    min-height: 56px;
    resize: vertical;
}

.models-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-2);
}

.models-message {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--fg-muted);
    overflow-wrap: anywhere;
}

.models-message.is-ok {
    color: var(--ok);
}

.models-message.is-error {
    color: var(--danger);
}

.models-note {
    margin: 0;
    color: var(--fg-subtle);
    font-size: var(--text-xs);
    line-height: 1.7;
}

/* ── 插件管理 ─────────────────────────────────────────────── */

.plugins-notice {
    margin: 0 0 var(--space-3);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: 1.7;
}

.plugins-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
}

.plugins-empty {
    margin: 0;
    color: var(--fg-subtle);
    font-size: var(--text-sm);
}

.plugin-row {
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface-2);
}

.plugin-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.plugin-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
    font-size: var(--text-sm);
    font-weight: var(--fw-strong);
}

.plugin-status {
    flex: none;
    margin-left: auto;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: var(--text-xs);
    background: var(--surface-3);
    color: var(--fg-muted);
}

.plugin-status.is-ok {
    background: var(--accent-soft);
    color: var(--accent-strong);
}

.plugin-status.is-failed {
    background: var(--danger-soft);
    color: var(--danger);
}

.plugin-status.is-disabled {
    background: var(--surface-3);
    color: var(--fg-subtle);
}

.plugin-status.is-unknown {
    background: var(--warn-soft);
    color: var(--warn);
}

.plugin-meta,
.plugin-deps {
    margin: 4px 0 0;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
}

.plugin-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
}

.plugins-install {
    margin-top: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-soft);
}

.plugins-install h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
}

.plugins-install-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
}

.plugins-file {
    flex: 1;
    min-width: 12em;
    padding: 6px 8px;
    font-size: var(--text-sm);
}

.plugins-force {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
}

/* 原生复选框架 13px，在 14px 正文旁边偏小 */
.plugins-force input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
}

.plugins-hint {
    margin: 6px 0 0;
    color: var(--fg-subtle);
    font-size: var(--text-xs);
}

.plugins-message {
    margin: 0 0 var(--space-3);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
}

.plugins-message.is-ok {
    color: var(--ok);
}

.plugins-message.is-error {
    color: var(--danger);
}

.models-context {
    margin: var(--space-2) 0 var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-soft);
}

.models-context h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
}

.models-context-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: var(--space-2) 0 var(--space-3);
}

.models-context-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface-2);
}

.models-context-provider {
    font-size: var(--text-sm);
    font-weight: var(--fw-strong);
    color: var(--fg);
}

.models-context-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--fg-muted);
}

.models-context-model {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
}

.models-context-input {
    flex: none;
    width: 120px;
}

.models-context-empty {
    color: var(--fg-subtle);
    font-size: var(--text-xs);
}

.model-menu-context {
    margin-left: auto;
    color: var(--fg-subtle);
    font-size: var(--text-xs);
    font-weight: var(--fw-medium);
}

/* ── Agent 权限切换器 ─────────────────────────────────────── */

.composer-perm {
    position: relative;
    flex: none;
}

.perm-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 9px 0 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: var(--fw-strong);
    cursor: pointer;
    transition:
        border-color var(--dur) var(--ease),
        background var(--dur) var(--ease),
        color var(--dur) var(--ease);
}

.perm-btn:hover {
    border-color: var(--border-strong);
    color: var(--fg);
}

.perm-btn[data-permission="workspace-write"] {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent-strong);
}

.perm-btn[data-permission="danger-full-access"] {
    border-color: var(--danger);
    background: var(--danger-soft);
    color: var(--danger);
}

.perm-caret {
    opacity: 0.6;
    transition: transform var(--dur) var(--ease);
}

.perm-btn[aria-expanded="true"] .perm-caret {
    transform: rotate(180deg);
}

.perm-label {
    max-width: 9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.perm-menu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    z-index: 45;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 6px;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-3);
}

.perm-menu[hidden] {
    display: none;
}

.perm-menu-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    margin: 0;
    padding: 6px 8px 4px;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
}

.perm-menu-title span {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: 0;
    text-transform: none;
}

.perm-option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.perm-option:hover {
    border-color: var(--border-soft);
    background: var(--surface-2);
}

.perm-option[aria-checked="true"] {
    border-color: var(--accent-line);
    background: var(--accent-soft);
}

.perm-option-danger[aria-checked="true"] {
    border-color: var(--danger);
    background: var(--danger-soft);
}

.perm-option-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: var(--fw-strong);
}

.perm-option[aria-checked="true"] .perm-option-head::after {
    content: "✓";
    color: var(--accent);
}

.perm-option-danger[aria-checked="true"] .perm-option-head::after {
    color: var(--danger);
}

.perm-option-desc {
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: 1.45;
}

.perm-option-tag {
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--fg-muted);
    font-size: var(--text-2xs);
    font-weight: var(--fw-strong);
}

.perm-option-tag.is-danger {
    background: var(--danger-soft);
    color: var(--danger);
}

.perm-warning {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: min(100%, var(--content-w));
    margin: 0 auto var(--space-2);
    padding: 8px 12px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--text-xs);
    line-height: 1.45;
}

.perm-warning[hidden] {
    display: none;
}

.perm-warning .icon {
    flex: none;
}


.composer-hint.is-warn {
    color: var(--warn);
}

#hint-count {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
}

#hint-busy kbd {
    margin: 0 2px;
}

.composer-send {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
    margin-left: auto;
}

.btn-send {
    min-height: 34px;
    padding: 0 var(--space-4);
    border-radius: var(--radius-sm);
}

.scroll-bottom {
    position: absolute;
    top: -46px;
    left: 50%;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--border-control);
    border-radius: 50%;
    background: var(--surface);
    color: var(--fg-muted);
    box-shadow: var(--shadow-2);
    transform: translateX(-50%);
}

.scroll-bottom:hover {
    color: var(--fg);
}

/* ── 对话框 ───────────────────────────────────────────────── */

dialog.dialog {
    width: min(460px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-lg);
    background: var(--bg-elev);
    color: var(--fg);
    box-shadow: var(--shadow-3);
}

dialog.dialog-wide {
    width: min(620px, calc(100vw - 32px));
}

dialog.dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
}

.dialog-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-5) var(--space-3);
}

.dialog-head h2 {
    font-size: var(--text-lg);
    font-weight: var(--fw-bold);
    letter-spacing: -0.015em;
}

.dialog-head p {
    margin-top: var(--space-1);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 1.6;
}

/*
 * 审批对话框：完整命令行置顶，参数逐条列在下面。
 * 命令行用等宽字体、保留换行：粘贴进终端就是会执行的那一条。
 */
.approval-command-line {
    margin: 0 0 var(--space-3);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.65;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    user-select: text;
}

.approval-args {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.approval-args li {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
}

/* 参数下标：让人一眼看出这是 argv 的第几项，而不是一条连续命令 */
.approval-arg-index {
    flex: none;
    min-width: 1.6em;
    color: var(--fg-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    text-align: right;
}

.approval-args code {
    min-width: 0;
    padding: 1px 5px;
    border-radius: var(--radius-xs);
    background: var(--code-bg);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    user-select: text;
}

/* 联网 / 后台这类「提权之外再加一项能力」的行：必须比普通字段更显眼 */
.approval-risk {
    color: var(--warn);
    font-weight: var(--fw-strong);
}

.approval-stdin {
    max-height: 160px;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    overflow: auto;
    border-radius: var(--radius-xs);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

.approval-note {
    display: block;
    margin-top: 4px;
    color: var(--fg-subtle);
    font-size: var(--text-2xs);
}

.approval-path {
    overflow-wrap: anywhere;
}

.dialog-body {
    padding: 0 var(--space-5);
    max-height: min(60dvh, 520px);
    overflow-y: auto;
}

.dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5) var(--space-5);
}

/* ── Token 统计弹窗（上下文占用 / 缓存命中） ───────────────── */

.stats-dialog .dialog-body {
    padding-top: var(--space-1);
}

.stats-grid {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
}

.stats-grid dt {
    color: var(--fg-muted);
    white-space: nowrap;
}

.stats-grid dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.7;
}

.stats-grid dd[data-emphasis="true"] {
    color: var(--fg);
    font-weight: var(--fw-strong);
}

.stats-context {
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-soft);
}

.stats-section {
    margin: 0 0 var(--space-2);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: var(--fw-strong);
    letter-spacing: 0.04em;
}

.stats-note {
    margin: var(--space-2) 0 0;
    color: var(--fg-subtle);
    font-size: var(--text-xs);
    line-height: 1.7;
}

.stats-dialog .dialog-foot {
    padding-top: var(--space-3);
}

/* ── Agent 提问卡片（参考 Harness） ──────────────────────── */

.ask-card {
    width: min(100%, var(--content-w));
    margin: 0 auto var(--space-2);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    color: var(--fg);
    box-shadow: var(--shadow-2);
}

.ask-card[hidden] {
    display: none;
}

.ask-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-3) 0 var(--space-5);
}

.ask-heading {
    min-width: 0;
}

.ask-eyebrow {
    margin: 0 0 5px;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: 16px;
}

.ask-question {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--fw-strong);
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
}

.ask-head-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
}

.ask-body {
    padding-top: var(--space-1);
}

.ask-options {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: var(--space-2) 0 0;
    padding: var(--space-1) var(--space-3);
}

.ask-options[hidden] {
    display: none;
}

.ask-option {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    min-height: 40px;
    padding: 8px 12px 8px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
        background-color 120ms var(--ease),
        border-color 120ms var(--ease);
}

.ask-option:hover:not(:disabled),
.ask-option[aria-checked="true"] {
    background: var(--surface-3);
}

.ask-option[aria-checked="true"] {
    border-color: var(--border);
}

.ask-number {
    flex: 0 0 20px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-top: 2px;
    border-radius: var(--radius-xs);
    background: var(--bg-elev);
    color: var(--fg-subtle);
    font-size: var(--text-xs);
    font-weight: var(--fw-strong);
    line-height: 18px;
}

.ask-number .icon {
    width: 12px;
    height: 12px;
}

.ask-option-copy {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 6px;
}

.ask-option-label {
    font-size: var(--text-md);
    font-weight: var(--fw-medium);
    line-height: 24px;
    overflow-wrap: anywhere;
}

.ask-badge {
    padding: 0 4px;
    border-radius: var(--radius-xs);
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: var(--text-xs);
    font-weight: var(--fw-strong);
    line-height: 18px;
}

.ask-custom {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 2px var(--space-3) var(--space-3);
    padding: 8px 12px 8px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    transition:
        background-color 120ms var(--ease),
        border-color 120ms var(--ease);
}

.ask-custom:hover,
.ask-custom:focus-within,
.ask-custom[data-active="true"] {
    background: var(--surface-3);
}

.ask-custom:focus-within {
    border-color: var(--border);
}

.ask-custom.is-block {
    min-height: 64px;
    margin-top: var(--space-2);
    border-color: var(--border);
    background: var(--surface);
}

.ask-input {
    flex: 1;
    min-width: 0;
    max-height: 144px;
    padding: 0;
    overflow-y: auto;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: var(--text-md);
    line-height: 24px;
    resize: none;
}

.ask-input::placeholder {
    color: var(--fg-subtle);
}

.ask-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3) var(--space-3) var(--space-5);
}

.ask-feedback {
    flex: 1;
    min-height: 16px;
    margin: 0;
    color: var(--danger);
    font-size: var(--text-xs);
    line-height: 16px;
}

.ask-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.ask-card.is-minimized .ask-body,
.ask-card.is-minimized .ask-foot {
    display: none;
}

.ask-card.is-minimized .ask-head {
    padding-bottom: var(--space-4);
}

.ask-card.is-minimized #ask-min .icon {
    transform: rotate(180deg);
}

@media (width <= 720px) {
    .ask-head {
        padding: var(--space-3) var(--space-3) 0 var(--space-4);
    }

    .ask-options {
        padding: var(--space-1) var(--space-2);
    }

    .ask-custom {
        margin: 2px var(--space-2) var(--space-3);
        padding: 8px 6px;
    }

    .ask-foot {
        padding: var(--space-2) var(--space-3) var(--space-3);
    }
}

@media (prefers-reduced-motion: reduce) {
    .ask-option,
    .ask-custom {
        transition: none;
    }
}

/* ── 修改密码对话框 ──────────────────────────────────────── */

.form-message {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--fg-muted);
    overflow-wrap: anywhere;
}

.form-message.is-ok {
    color: var(--ok);
}

.form-message.is-error {
    color: var(--danger);
}

.form-message.is-warn {
    color: var(--warn);
}

.form-note {
    margin: 0 0 var(--space-2);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: 1.7;
}

.dialog-loading {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6) 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
}

dl.status-grid {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
    margin: var(--space-2) 0 var(--space-5);
    font-size: var(--text-sm);
}

dl.status-grid dt {
    color: var(--fg-muted);
    white-space: nowrap;
}

dl.status-grid dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.7;
}

.plugin-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: var(--space-2) 0 0;
    padding: 0;
    list-style: none;
}

.plugin-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
}

.plugin-item:hover {
    background: var(--surface-2);
}

.plugin-item .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.plugin-item .ver {
    color: var(--fg-subtle);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
}

.section-label {
    margin: var(--space-4) 0 0;
    color: var(--fg-muted);
    font-size: var(--text-2xs);
    font-weight: var(--fw-strong);
}

/* ── 响应式 ───────────────────────────────────────────────── */

@media (max-width: 1080px) {
    :root {
        --sidebar-w: 248px;
        --content-w: 740px;
    }
}

@media (max-width: 860px) {
    /* 窄屏输入条：.composer-bar 不换行时，模型胶囊（label 上限 12em）+ 权限胶囊
       （9em）+ 发送会超出 composer 宽度；溢出的部分被 .app 的 overflow: hidden 裁掉，
       手机上发送按钮整个看不见。这里让提示独占一行、胶囊可截断、按钮靠右且永不换行 */
    .composer-bar {
        flex-wrap: wrap;
        row-gap: var(--space-2);
    }

    .composer-model,
    .composer-perm {
        flex: 0 1 auto;
        min-width: 0;
    }

    .perm-btn {
        min-width: 0;
        max-width: 100%;
    }

    .model-label {
        max-width: 6em;
    }

    .perm-label {
        max-width: 5em;
    }

    .composer-hint {
        order: 3;
        flex: 1 0 100%;
    }

    .composer-send {
        order: 4;
        margin-left: auto;
    }

    .app {
        grid-template-columns: minmax(0, 1fr);
    }

    .sidebar {
        position: fixed;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 40;
        width: min(320px, 86vw);
        padding-top: calc(var(--space-3) + env(safe-area-inset-top));
        transform: translateX(-102%);
        /* 过阻尼 1200/80：一次到位，零回弹 */
        transition: transform var(--dur-snap) var(--spring-snap);
        box-shadow: var(--shadow-3);
    }

    .app[data-sidebar="open"] .sidebar {
        transform: none;
    }

    /* 抽屉内部自己滚动，别把滚动链传出去（iOS 上会连带滚动背后的列表） */
    .sidebar {
        overscroll-behavior: contain;
    }

    .sidebar-close,
    .only-mobile {
        display: inline-flex;
    }

    /* 抽屉高度有限：工作区列表封顶，滚动交给 .sidebar-scroll */
    .workspace-list {
        max-height: min(28vh, 200px);
    }

    .topbar {
        padding-left: var(--space-2);
    }

    .auth {
        grid-template-columns: minmax(0, 1fr);
    }

    .auth-aside {
        gap: var(--space-4);
        padding: var(--space-6) var(--space-5) 0;
        border-right: 0;
    }

    .auth-headline,
    .auth-copy,
    .auth-points {
        display: none;
    }

    .auth-foot {
        display: none;
    }

    .auth-main {
        align-items: flex-start;
        padding: var(--space-6) var(--space-5) var(--space-12);
    }

    .auth-card {
        max-width: none;
    }

    .messages {
        padding: var(--space-5) var(--space-4) var(--space-2);
    }

    .msg-user .msg-bubble {
        max-width: 88%;
    }

    .composer-wrap {
        position: relative;
        padding: var(--space-1) var(--space-3) calc(var(--space-3) + env(safe-area-inset-bottom));
    }

    .msg-actions,
    .conv-del {
        opacity: 1;
    }

}

@media (max-width: 560px) {
    :root {
        /* 手机上标题收一档；正文不动，收到 16px 以下中文就开始挤 */
        --text-2xl: 1.375rem;
        --text-xl: 1.1875rem;
    }

    .empty-title {
        font-size: var(--text-xl);
    }

    .empty {
        padding-top: var(--space-6);
    }

    .suggestions {
        grid-template-columns: 1fr;
    }

    .composer-hint kbd {
        display: none;
    }

    .msg {
        gap: var(--space-2);
    }

    .msg-avatar {
        width: 26px;
        height: 26px;
    }

    .wd-lg-hide {
        display: none;
    }

    /* 顶栏让出刘海/状态栏高度（viewport-fit=cover 下 env() 才有值） */
    .topbar {
        padding-top: env(safe-area-inset-top);
        min-height: calc(var(--topbar-h) + env(safe-area-inset-top));
    }

    /* 弹窗在手机上贴底做成半屏：内容高、按钮在拇指区 */
    dialog.dialog,
    dialog.dialog-wide {
        width: 100%;
        max-width: none;
        max-height: 88dvh;
        margin: auto auto 0;
        border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    }

    .dialog-head {
        padding: var(--space-4) var(--space-4) var(--space-2);
    }

    .dialog-body {
        padding: 0 var(--space-4);
        max-height: 60dvh;
    }

    .dialog-foot {
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4) calc(var(--space-4) + env(safe-area-inset-bottom));
    }

    .dialog-foot > * {
        flex: 1;
    }
}

/* ── 手机：输入区两行 ──────────────────────────────────────
 * 之前模型胶囊、权限胶囊、提示行、发送键挤在一行里（还要换行），
 * 360×640 上输入区占到 198px（屏幕的 31%），消息区只剩 382px。
 *
 * 现在：第一行放两颗胶囊（左模型、右权限），第二行输入框 + 发送键。
 * - 拇指在右下角，发送/停止不用够；
 * - 输入框和发送键同一行，胶囊再长也不会把发送键挤到下一行；
 * - 软键盘没有 Shift / Esc，键盘提示行在手机上不成立（「先添加工作区」
 *   是操作指引，保留）；
 * - 胶囊 44px 高，满足触摸下限。
 */
@media (max-width: 560px) {
    .composer {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        grid-template-areas:
            "model hint perm"
            "field field send";
        gap: var(--space-2);
        padding: var(--space-2);
    }

    /* 让 bar 里的控件直接参与 composer 的网格，少一层 flex 容器 */
    .composer-bar {
        display: contents;
    }

    .composer-model {
        grid-area: model;
        justify-self: start;
    }

    .composer-perm {
        grid-area: perm;
        justify-self: end;
    }

    .composer-field {
        grid-area: field;
    }

    .composer-send {
        grid-area: send;
        align-self: end;
    }

    .composer-hint {
        grid-area: hint;
        display: none;
        align-self: center;
        text-align: center;
    }

    /* 没有工作区时提示仍然必要：发送键是禁用的，得说明为什么 */
    .composer-hint[data-kind="blocked"] {
        display: flex;
    }

    /* 输入框下方的统计行：手机上用更小的字号，尽量保持一行 */
    .composer-stats {
        padding: 0 var(--space-1);
        font-size: 0.75rem;
        gap: 4px;
    }

    .perm-btn {
        height: 44px;
        padding: 0 var(--space-3) 0 var(--space-2);
    }

    .model-label {
        max-width: 7em;
    }

    .perm-label {
        max-width: 5em;
    }

    /* 右侧胶囊的下拉菜单往左展开，否则会顶出屏幕 */
    .composer-perm .perm-menu {
        left: auto;
        right: 0;
    }

    .btn-send {
        padding: 0 var(--space-3);
    }
}

/* 触摸设备：扩大点击区域并常显操作按钮 */
@media (pointer: coarse) {
    .btn,
    .btn-icon {
        min-height: 44px;
    }

    .btn-icon {
        width: 44px;
    }

    .btn-sm {
        min-height: 36px;
    }

    .conv-del {
        width: 44px;
        opacity: 1;
    }

    .ws-del {
        width: 44px;
        min-height: 44px;
        opacity: 1;
    }

    .code-copy {
        min-height: 44px;
    }

    /* 侧栏的行都是主入口：工作区、会话、折叠标题、添加工作区 */
    .ws-select,
    .conv-select,
    .sidebar-fold,
    .workspace-add {
        min-height: 44px;
    }

    /* 过程行（思考/工具）是密集列表：36 够点，也还留得住一屏看十几行 */
    .proc-head {
        min-height: 36px;
    }

    .perm-btn {
        height: 44px;
    }

    /* 设置页顶栏的刷新按钮是主入口，别停在 36 */
    .topbar-actions .btn {
        min-height: 44px;
    }

    /* 覆盖消息操作按钮的紧凑高度，保证触摸目标 */
    .msg-actions .btn {
        min-height: 44px;
        padding: 0 var(--space-3);
        font-size: var(--text-sm);
    }

    /* 用量胶囊平时是 26px 的发现性元素，手指按不准 */
    .msg-usage {
        min-height: 44px;
        padding: 0 var(--space-3);
    }

    .input-action {
        width: 44px;
        height: 44px;
    }

    .input-group .input {
        padding-right: 54px;
    }

    .scroll-bottom {
        width: 44px;
        height: 44px;
    }
}

/* ── 触摸反馈 ───────────────────────────────────────────────
 * 手机上既没有 hover 也没有鼠标指针：按下必须当场有回应，否则像没点上。
 * - touch-action: manipulation 去掉 300ms 点按延迟；
 * - 去掉 iOS 的灰色高亮块，换成自己的 :active 反馈；
 * - 反馈只用 opacity / transform，不动布局，避免按下时界面抖一下。
 */
button,
a,
[role="button"],
.suggestion,
.proc-head,
.conv-select,
.ws-select,
.input-action,
.code-copy,
.trigger-item,
.ask-option,
.model-menu-item,
.model-menu-reasoning-btn,
.perm-option {
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
}

@media (hover: none) {
    .btn:active,
    .btn-icon:active,
    .perm-btn:active,
    .suggestion:active,
    .proc-head:active,
    .conv-select:active,
    .ws-select:active,
    .ask-option:active,
    .model-menu-item:active,
    .model-menu-reasoning-btn:active,
    .perm-option:active,
    .trigger-item:active,
    .code-copy:active,
    .input-action:active {
        transform: scale(0.98);
    }
}

@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
    }

    .md.is-streaming > :last-child::after {
        animation: none;
        opacity: 0.7;
    }

    .proc-summary-text[data-shimmer="true"] {
        animation: none;
        background: none;
        color: var(--fg-muted);
        -webkit-text-fill-color: currentColor;
    }
}

@media (prefers-contrast: more) {
    :root {
        --border: var(--border-strong);
    }

    .msg-user .msg-bubble {
        border-width: 2px;
    }
}


/* ── Web 扩展 ────────────────────────────────────────────── */

.ext-toolbar {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-2);
}

.ext-hint {
    margin: 0 0 var(--space-3);
    color: var(--fg-subtle);
    font-size: var(--text-xs);
    line-height: 1.6;
}

.ext-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
}

.ext-item {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface-2);
}

.ext-item-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.ext-name {
    color: var(--fg);
    font-weight: var(--fw-strong);
}

.ext-meta {
    color: var(--fg-subtle);
    font-size: var(--text-xs);
}

.ext-actions {
    display: flex;
    gap: var(--space-1);
    flex: none;
}

.ext-panel {
    display: flex;
    flex-direction: column;
    width: min(1080px, 100%);
    max-height: 100%;
    overflow: hidden;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-lg);
    background: var(--bg-elev);
    color: var(--fg);
    box-shadow: var(--shadow-3);
}

.ext-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-soft);
}

.ext-head h2 {
    margin: 2px 0 0;
    font-size: var(--text-lg);
}

.ext-eyebrow {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-2xs);
}

.ext-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-4) var(--space-5);
}

/* ── 路由页面 ────────────────────────────────────────────── */

.view-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-5);
}

.ext-page-body {
    padding: var(--space-5);
}

/* 设置类路由页面的内容宽度：与宽对话框同宽，长表单不跨满宽屏 */
.page-narrow {
    width: min(100%, 720px);
    margin: 0 auto;
}

.password-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-5);
}

/* 侧栏底栏入口指向当前页面时的选中态 */
.sidebar-foot-body .btn[data-active="true"] {
    background: var(--surface-3);
    color: var(--fg);
}

/* ── 动效偏好 ─────────────────────────────────────────────── */

/*
 * 消息入场、呼吸点、闪烁光标、过程行起伏都是装饰性动效。
 * 系统设了「减少动态效果」就整体停下——以前只有运行中的小圆点单独处理过。
 * 旋转的加载指示保留（停住的转圈会被读成卡死），但放慢一半。
 */
@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
    }

    .spinner {
        animation: spin 1.6s linear infinite !important;
    }
}

/* ── 完成后的步骤块 ─────────────────────────────────────────── */

.proc-group {
    border-radius: var(--radius-sm);
}

.proc-group[data-open="true"] {
    background: var(--surface-2);
}

.proc-group-head .proc-title {
    color: var(--fg-muted);
    font-weight: var(--fw-medium);
}

.proc-group-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: var(--space-1);
}

/* ── Agent 提交的文件 ───────────────────────────────────────── */

.submit-files {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-self: stretch;
    max-width: 100%;
    margin-top: var(--space-2);
}

.submit-file {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    min-height: 30px;
    padding: 2px var(--space-1) 2px var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: var(--text-xs);
}

.submit-file-icon {
    flex: none;
    display: inline-flex;
    color: var(--fg-subtle);
}

.submit-file-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--fg);
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.submit-file-size {
    flex: none;
    color: var(--fg-subtle);
    font-variant-numeric: tabular-nums;
}

.submit-file-actions {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 2px;
}

.submit-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 45;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 190px;
    padding: 6px;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-3);
}

.submit-menu-item {
    padding: 6px var(--space-2);
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-xs);
    text-align: left;
    cursor: pointer;
    transition:
        background var(--dur) var(--ease),
        color var(--dur) var(--ease);
}

.submit-menu-item:hover {
    background: var(--surface-2);
    color: var(--fg);
}

/* ── 提问折叠与拖放提示 ─────────────────────────────────────── */

.ask-card[data-minimized="true"] .ask-question {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
}

.drop-hint {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    background: var(--scrim);
    color: var(--fg);
    pointer-events: none;
}

.drop-hint p {
    margin: 0;
    font-size: var(--text-sm);
}
`
