/*
 * 样式表：VS Code 风格的明暗主题、布局、编辑器与浮层。
 * 约束：String.raw 原始字符串，不能出现反引号和美元花括号插值。
 */

export const STYLES = String.raw`
/* ── 令牌 ─────────────────────────────────────────────────── */

:root {
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "PingFang SC",
        "Microsoft YaHei", sans-serif;
    --font-mono: "JetBrains Mono", "Cascadia Code", "Fira Code", "SFMono-Regular", Consolas,
        "Liberation Mono", Menlo, monospace;

    /* UI 字号：沿用 etheros-web frontend/src/assets/styles/global.scss 的定义 */
    --font-size-xs: 1rem;
    --font-size-sm: 1.1rem;
    --font-size-base: 1.2rem;
    --font-size-lg: 1.3rem;
    --font-size-xl: 1.4rem;
    --font-size-2xl: 1.6rem;
    --font-size-3xl: 1.8rem;
    --font-size-4xl: 2rem;
    --font-size-5xl: 2.2rem;
    --font-size-6xl: 2.6rem;
    --font-size-7xl: 3.2rem;
    --font-size-8xl: 3.7rem;

    --code-size: 13px;
    --line-height: 21px;
    --tab-size: 4;
    --sidebar-width: 280px;
    /* 活动栏宽度：移动端会变窄，侧栏定位与收起位移都跟着它走 */
    --activity-width: 3rem;
    /* 移动端键盘弹出时由 visualViewport 写入，避免 100vh 被键盘挡住 */
    --app-height: 100vh;
    --logo-ink: #0f2f24;

    --bg-editor: #1e1e1e;
    --bg-title: #323233;
    --bg-activity: #333333;
    --bg-sidebar: #252526;
    --bg-tab: #2d2d2d;
    --bg-tab-active: #1e1e1e;
    --bg-menu: #252526;
    --bg-input: #3c3c3c;
    --bg-hover: rgba(255, 255, 255, 0.075);
    --bg-selected: rgba(255, 255, 255, 0.1);
    --bg-active-item: #04395e;
    --bg-welcome-card: rgba(255, 255, 255, 0.035);
    --fg: #cccccc;
    --fg-strong: #e7e7e7;
    --fg-muted: #9d9d9d;
    --fg-dim: #6e7681;
    --border: #3c3c3c;
    --border-soft: #2b2b2b;
    --accent: #007acc;
    --accent-hover: #1177bb;
    --accent-fg: #ffffff;
    --focus: #007fd4;
    --danger: #f14c4c;
    --danger-soft: rgba(241, 76, 76, 0.16);
    --warning: #cca700;
    --success: #89d185;
    --selection: rgba(38, 79, 120, 0.85);
    --indent-guide: rgba(255, 255, 255, 0.1);
    --bracket-match: rgba(88, 150, 220, 0.35);
    --bracket-border: rgba(88, 150, 220, 0.85);
    --scroll-thumb: rgba(121, 121, 121, 0.35);
    --scroll-thumb-hover: rgba(150, 150, 150, 0.55);
    --shadow: 0 8px 28px rgba(0, 0, 0, 0.45);

    --tok-keyword: #569cd6;
    --tok-string: #ce9178;
    --tok-number: #b5cea8;
    --tok-comment: #6a9955;
    --tok-type: #4ec9b0;
    --tok-function: #dcdcaa;
    --tok-variable: #9cdcfe;
    --tok-property: #9cdcfe;
    --tok-tag: #569cd6;
    --tok-attr: #9cdcfe;
    --tok-punct: #d4d4d4;
    --tok-literal: #569cd6;
    --tok-operator: #d4d4d4;
    --tok-decorator: #dcdcaa;
    --tok-entity: #f48771;
    --tok-link: #4daafc;
    --tok-inserted: #89d185;
    --tok-deleted: #f48771;
    --tok-fence: #808080;

    /* ANSI 16 色（PTY 终端用） */
    --ansi-0: #1e1e1e;
    --ansi-1: #cd3131;
    --ansi-2: #0dbc79;
    --ansi-3: #e5e510;
    --ansi-4: #2472c8;
    --ansi-5: #bc3fbc;
    --ansi-6: #11a8cd;
    --ansi-7: #e5e5e5;
    --ansi-8: #666666;
    --ansi-9: #f14c4c;
    --ansi-10: #23d18b;
    --ansi-11: #f5f543;
    --ansi-12: #3b8eea;
    --ansi-13: #d670d6;
    --ansi-14: #29b8db;
    --ansi-15: #ffffff;
}

:root[data-theme="light"] {
    --logo-ink: #0f2f24;
    --bg-editor: #ffffff;
    --bg-title: #f3f3f3;
    --bg-activity: #f8f8f8;
    --bg-sidebar: #f3f3f3;
    --bg-tab: #ececec;
    --bg-tab-active: #ffffff;
    --bg-menu: #ffffff;
    --bg-input: #ffffff;
    --bg-hover: rgba(0, 0, 0, 0.055);
    --bg-selected: rgba(0, 0, 0, 0.08);
    --bg-active-item: #e4e6f1;
    --bg-welcome-card: rgba(0, 0, 0, 0.025);
    --fg: #3b3b3b;
    --fg-strong: #1f1f1f;
    --fg-muted: #717171;
    --fg-dim: #8c8c8c;
    --border: #e0e0e0;
    --border-soft: #ececec;
    --focus: #0090f1;
    --danger: #cd3131;
    --danger-soft: rgba(205, 49, 49, 0.12);
    --warning: #bf8803;
    --success: #1a7f37;
    --selection: rgba(173, 214, 255, 0.75);
    --indent-guide: rgba(0, 0, 0, 0.11);
    --bracket-match: rgba(0, 120, 212, 0.22);
    --bracket-border: rgba(0, 120, 212, 0.7);
    --scroll-thumb: rgba(100, 100, 100, 0.25);
    --scroll-thumb-hover: rgba(80, 80, 80, 0.4);
    --shadow: 0 8px 28px rgba(0, 0, 0, 0.16);

    --tok-keyword: #0000ff;
    --tok-string: #a31515;
    --tok-number: #098658;
    --tok-comment: #008000;
    --tok-type: #267f99;
    --tok-function: #795e26;
    --tok-variable: #001080;
    --tok-property: #001080;
    --tok-tag: #800000;
    --tok-attr: #e50000;
    --tok-punct: #3b3b3b;
    --tok-literal: #0000ff;
    --tok-operator: #3b3b3b;
    --tok-decorator: #795e26;
    --tok-entity: #e50000;
    --tok-link: #006ab1;
    --tok-inserted: #098658;
    --tok-deleted: #a31515;
    --tok-fence: #8c8c8c;
}

/* ── 基础 ─────────────────────────────────────────────────── */

* {
    box-sizing: border-box;
}

[hidden] {
    display: none !important;
}

html {
    /* UI 基准字号：默认 1rem，设置面板可覆盖；字号 token 本身用 rem，因此整体等比缩放 */
    font-size: var(--ui-font-size, 1rem);
}

html,
body {
    height: 100%;
    margin: 0;
    overflow: hidden;
    overscroll-behavior: none;
}

body {
    font-family: var(--font-ui);
    font-size: var(--font-size-xs);
    color: var(--fg);
    background: var(--bg-editor);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}

button,
input,
select,
textarea {
    font: inherit;
    color: inherit;
}

button {
    cursor: pointer;
}

a {
    color: var(--tok-link);
}

kbd:empty {
    display: none;
}

kbd {
    font-family: var(--font-mono);
    font-size: 0.75em;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--fg-muted);
    white-space: nowrap;
}

:focus-visible {
    outline: 1px solid var(--focus);
    outline-offset: -1px;
}

.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

.sprite {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
}

.icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.icon-sm {
    width: 14px;
    height: 14px;
}

.icon-xs {
    width: 12px;
    height: 12px;
}

::-webkit-scrollbar {
    width: 10px;
    height: 10px;
}

::-webkit-scrollbar-track {
    background: transparent;
}

::-webkit-scrollbar-thumb {
    background: var(--scroll-thumb);
    border: 2px solid transparent;
    background-clip: content-box;
    border-radius: 6px;
}

::-webkit-scrollbar-thumb:hover {
    background: var(--scroll-thumb-hover);
    background-clip: content-box;
}

::-webkit-scrollbar-corner {
    background: transparent;
}

/* ── 骨架 ─────────────────────────────────────────────────── */

.workbench {
    display: flex;
    flex-direction: column;
    height: var(--app-height, 100vh);
    min-height: 0;
}

.workbench-body {
    display: flex;
    flex: 1;
    min-height: 0;
}

/* ── 标题栏 ───────────────────────────────────────────────── */

.titlebar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 2.25rem;
    padding: 0 8px 0 10px;
    background: var(--bg-title);
    border-bottom: 1px solid var(--border-soft);
    user-select: none;
    flex-shrink: 0;
    position: relative;
    z-index: 30;
}

.titlebar-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.brand {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--fg-strong);
    text-decoration: none;
    font-size: var(--font-size-xs);
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
}

.brand-mark {
    width: 1.25rem;
    height: 1.25rem;
    color: #3ddc97;
    fill: currentColor;
    stroke: none;
}

.brand-name b {
    color: #3ddc97;
    font-weight: 700;
}

.menubar {
    display: flex;
    align-items: center;
    gap: 1px;
    margin-left: 4px;
}

.menubar-item {
    height: 1.5rem;
    padding: 0 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg);
    font-size: var(--font-size-xs);
}

.menubar-item:hover,
.menubar-item[aria-expanded="true"] {
    background: var(--bg-hover);
}

.titlebar-center {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 1.5rem;
    min-width: 160px;
    max-width: 520px;
    width: 38vw;
    margin: 0 auto;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--fg-muted);
    font-size: var(--font-size-xs);
    transition: border-color 120ms ease, background 120ms ease;
}

.titlebar-center:hover {
    border-color: var(--accent);
    color: var(--fg);
}

.titlebar-center span {
    flex: 1;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.titlebar-right {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
}

.icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--fg-muted);
}

.icon-btn:hover {
    background: var(--bg-hover);
    color: var(--fg-strong);
}

.icon-btn.sm {
    width: 1.375rem;
    height: 1.375rem;
}

.text-btn {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: var(--font-size-xs);
    padding: 2px 6px;
    border-radius: 4px;
}

.text-btn:hover {
    background: var(--bg-hover);
}

/* ── 活动栏 ───────────────────────────────────────────────── */

.activitybar {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    width: var(--activity-width);
    flex-shrink: 0;
    padding: 4px 0;
    background: var(--bg-activity);
    border-right: 1px solid var(--border-soft);
}

.activity-group {
    display: flex;
    flex-direction: column;
    width: 100%;
}

.activity {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 2.875rem;
    padding: 0;
    border: none;
    border-left: 2px solid transparent;
    background: transparent;
    color: var(--fg-muted);
}

.activity .icon {
    width: 22px;
    height: 22px;
    stroke-width: 1.5;
}

.activity:hover {
    color: var(--fg-strong);
}

.activity.is-active {
    color: var(--fg-strong);
    border-left-color: var(--accent);
}

.activity.is-on {
    color: var(--fg-strong);
    border-left-color: var(--accent);
}

#problems-badge {
    background: var(--danger);
}

.activity-badge {
    position: absolute;
    right: 10px;
    top: 10px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 0.625em;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
}

/* ── 侧边栏 ───────────────────────────────────────────────── */

.sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    width: var(--sidebar-width);
    min-width: 180px;
    max-width: 520px;
    flex-shrink: 0;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-soft);
    transition: width 120ms ease, transform 120ms ease;
}

.sidebar.is-hidden {
    display: none;
}

.sidebar-resizer {
    position: absolute;
    top: 0;
    right: -3px;
    bottom: 0;
    width: 6px;
    z-index: 6;
    cursor: col-resize;
    background: transparent;
}

.sidebar-resizer:hover {
    background: var(--accent);
    opacity: 0.5;
}

body.is-resizing {
    cursor: col-resize;
    user-select: none;
}

.sidebar-view {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
}

.sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 2.25rem;
    padding: 0 10px 0 14px;
    flex-shrink: 0;
}

.sidebar-head h2 {
    margin: 0;
    font-size: 0.8125em;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--fg-muted);
    white-space: nowrap;
}

.sidebar-actions {
    display: flex;
    align-items: center;
    gap: 1px;
}

.sidebar-hint {
    font-size: 0.8125em;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.workspace-caption {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 10px 8px 14px;
    border: none;
    border-bottom: 1px solid var(--border-soft);
    background: transparent;
    text-align: left;
}

.workspace-caption:hover {
    background: var(--bg-hover);
}

.workspace-caption-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
}

.workspace-chevron {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--fg-dim);
}

.workspace-palette {
    width: min(780px, 94vw);
}

.workspace-palette-head {
    gap: 10px;
}

.workspace-palette-title {
    flex: 1;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--fg-strong);
}

.workspace-item {
    gap: 9px;
}

.workspace-item-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: #dcb67a;
}

.workspace-item-name {
    flex-shrink: 0;
    font-weight: 600;
    white-space: nowrap;
}

.workspace-item-count {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--bg-selected);
    color: var(--fg-muted);
    font-size: 0.75em;
}

.workspace-item-current {
    flex-shrink: 0;
    padding: 1px 6px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    color: var(--accent);
    font-size: 0.75em;
}

.workspace-item-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    color: var(--fg-dim);
    font-size: 0.75em;
}

.workspace-item.is-disabled .workspace-item-icon {
    color: var(--warning);
}

.workspace-item.is-disabled .workspace-item-name {
    color: var(--fg-muted);
}

.workspace-item-note {
    flex-shrink: 1;
    max-width: 46%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--warning);
    font-size: 0.75em;
}

.workspace-name {
    font-size: var(--font-size-xs);
    font-weight: 700;
    color: var(--fg-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.workspace-path {
    font-size: 0.75em;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
}

/* ── 文件树 ───────────────────────────────────────────────── */

.tree {
    flex: 1;
    overflow: auto;
    padding: 4px 0 12px;
    outline: none;
}

.tree-row {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 1.5rem;
    padding-right: 8px;
    color: var(--fg);
    font-size: var(--font-size-xs);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    border: 1px solid transparent;
}

.tree-row:hover {
    background: var(--bg-hover);
}

.tree-row.is-selected {
    background: var(--bg-selected);
}

.tree-row:focus-visible {
    border-color: var(--focus);
    outline: none;
}

.tree-row.is-flash {
    animation: tree-flash 900ms ease;
}

@keyframes tree-flash {
    0% {
        background: var(--bg-active-item);
    }
    100% {
        background: transparent;
    }
}

.tree-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--fg-muted);
}

.tree-icon {
    display: inline-flex;
    align-items: center;
    color: #dcb67a;
    flex-shrink: 0;
}

:root[data-theme="light"] .tree-icon {
    color: #b18046;
}

.tree-name {
    overflow: hidden;
    text-overflow: ellipsis;
}

.tree-dirty {
    width: 6px;
    height: 6px;
    margin-left: 4px;
    border-radius: 50%;
    background: var(--fg-muted);
    flex-shrink: 0;
}

.file-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.0625rem;
    height: 0.875rem;
    padding: 0 3px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.625em;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    flex-shrink: 0;
    background: #6e7681;
    color: #ffffff;
}

.tone-ts { background: #3178c6; }
.tone-js { background: #e8d44d; color: #1e1e1e; }
.tone-json { background: #cbcb41; color: #1e1e1e; }
.tone-md { background: #519aba; }
.tone-css { background: #563d7c; }
.tone-html { background: #e34c26; }
.tone-vue { background: #41b883; color: #10231c; }
.tone-python { background: #3572a5; }
.tone-shell { background: #89e051; color: #12240b; }
.tone-yaml { background: #cb171e; }
.tone-go { background: #00add8; color: #062730; }
.tone-rust { background: #dea584; color: #2b1a10; }
.tone-java { background: #b07219; }
.tone-c { background: #5b6b7c; }
.tone-php { background: #777bb4; }
.tone-ruby { background: #701516; }
.tone-sql { background: #e38c00; color: #241400; }
.tone-docker { background: #2496ed; }
.tone-image { background: #a074c4; }
.tone-archive { background: #8b8b8b; }
.tone-diff { background: #6e7681; }
.tone-plain { background: #6e7681; }

/* ── 搜索 ─────────────────────────────────────────────────── */

.search-form {
    padding: 2px 12px 10px;
    border-bottom: 1px solid var(--border-soft);
}

.field-inline {
    display: flex;
    align-items: center;
    gap: 4px;
}

.input {
    width: 100%;
    height: 1.625rem;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--fg);
    outline: none;
}

.input:focus {
    border-color: var(--accent);
}

.input-sm {
    height: 1.5rem;
    font-size: var(--font-size-xs);
}

.select {
    height: 1.625rem;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--fg);
    outline: none;
}

.toggle-btn {
    height: 1.5rem;
    min-width: 1.5rem;
    padding: 0 5px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.8125em;
}

.toggle-btn:hover {
    background: var(--bg-hover);
}

.toggle-btn.is-active {
    color: var(--fg-strong);
    border-color: var(--accent);
    background: var(--bg-active-item);
}

.search-status {
    margin: 8px 0 0;
    font-size: 0.8125em;
    color: var(--fg-dim);
    line-height: 1.5;
}

.search-status.is-busy {
    color: var(--accent);
}

.search-results {
    flex: 1;
    overflow: auto;
    padding-bottom: 12px;
}

.search-file {
    margin-top: 4px;
}

.search-file-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 12px;
    border: none;
    background: transparent;
    text-align: left;
    color: var(--fg);
}

.search-file-head:hover {
    background: var(--bg-hover);
}

.search-file-name {
    font-size: var(--font-size-xs);
    font-weight: 600;
    white-space: nowrap;
}

.search-file-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75em;
    color: var(--fg-dim);
}

.search-file-count {
    min-width: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--bg-selected);
    color: var(--fg-muted);
    font-size: 0.75em;
    text-align: center;
}

.search-match {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 2px 12px 2px 26px;
    border: none;
    background: transparent;
    text-align: left;
    color: var(--fg-muted);
}

.search-match:hover {
    background: var(--bg-hover);
    color: var(--fg);
}

.search-line {
    width: 30px;
    flex-shrink: 0;
    text-align: right;
    font-family: var(--font-mono);
    font-size: 0.75em;
    color: var(--fg-dim);
}

.search-snippet {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
    font-family: var(--font-mono);
    font-size: 0.8125em;
}

.search-snippet mark {
    background: rgba(237, 185, 75, 0.32);
    color: var(--fg-strong);
    border-radius: 2px;
}

/* ── 大纲 ─────────────────────────────────────────────────── */

.outline-list {
    flex: 1;
    overflow: auto;
    padding: 2px 0 12px;
}

.outline-item {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    height: 1.5rem;
    padding: 0 12px;
    border: none;
    background: transparent;
    color: var(--fg);
    text-align: left;
    font-size: var(--font-size-xs);
}

.outline-item:hover {
    background: var(--bg-hover);
}

.outline-kind {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 14px;
    border-radius: 3px;
    background: var(--bg-selected);
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.625em;
    flex-shrink: 0;
}

.outline-kind-class,
.outline-kind-type {
    background: rgba(78, 201, 176, 0.22);
    color: var(--tok-type);
}

.outline-kind-function {
    background: rgba(220, 220, 170, 0.2);
    color: var(--tok-function);
}

.outline-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.outline-line {
    font-family: var(--font-mono);
    font-size: 0.75em;
    color: var(--fg-dim);
}

.problems {
    flex: 1;
    overflow: auto;
    padding: 2px 0 12px;
}

.problem-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: var(--font-size-xs);
    line-height: 1.5;
    text-align: left;
}

.problem-item:hover {
    background: var(--bg-hover);
}

.problem-severity {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    border-radius: 50%;
    font-size: 0.625em;
    font-weight: 700;
}

.problem-item[data-severity="error"] .problem-severity {
    background: var(--danger-soft);
    color: var(--danger);
}

.problem-item[data-severity="warning"] .problem-severity {
    background: rgba(204, 167, 0, 0.18);
    color: var(--warning);
}

.problem-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
}

.problem-message {
    overflow: hidden;
    text-overflow: ellipsis;
}

.problem-location {
    color: var(--fg-dim);
    font-family: var(--font-mono);
    font-size: 0.75em;
}

.sidebar-empty {
    padding: 8px 14px;
    font-size: var(--font-size-xs);
    line-height: 1.6;
    color: var(--fg-dim);
}

/* ── 设置 ─────────────────────────────────────────────────── */

.settings {
    flex: 1;
    overflow: auto;
    padding: 4px 0 16px;
}

.setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 14px;
    font-size: var(--font-size-xs);
}

.setting > span {
    color: var(--fg);
}

.setting .select,
.setting .input {
    width: 112px;
}

.setting-check {
    justify-content: flex-start;
    gap: 8px;
    cursor: pointer;
}

.setting-check input {
    accent-color: var(--accent);
    margin: 0;
}

.settings-foot {
    padding: 10px 14px 0;
    border-top: 1px solid var(--border-soft);
    margin-top: 8px;
}

/* ── 编辑区 ───────────────────────────────────────────────── */

.editor-area {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: var(--bg-editor);
}

.tabs {
    display: flex;
    align-items: stretch;
    height: 2.25rem;
    flex-shrink: 0;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--bg-tab);
    scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
    display: none;
}

.tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 108px;
    max-width: 220px;
    padding: 0 10px 0 12px;
    border-right: 1px solid var(--border-soft);
    color: var(--fg-muted);
    font-size: var(--font-size-xs);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
}

.tab:hover {
    background: var(--bg-hover);
}

.tab.is-active {
    background: var(--bg-tab-active);
    color: var(--fg-strong);
    box-shadow: inset 0 1px 0 var(--accent);
}

.tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: auto;
    border-radius: 4px;
    color: var(--fg-muted);
    opacity: 0;
    flex-shrink: 0;
}

.tab:hover .tab-close,
.tab.is-active .tab-close,
.tab:focus-within .tab-close {
    opacity: 1;
}

.tab-close:hover {
    background: var(--bg-selected);
    color: var(--fg-strong);
}

.tab.is-dirty .tab-close {
    opacity: 0;
}

.tab.is-dirty:hover .tab-close {
    opacity: 1;
}

.tab.is-dirty::after {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg);
    position: absolute;
    right: 12px;
    top: 14px;
    pointer-events: none;
}

.tab.is-dirty:hover::after {
    display: none;
}

.tab-conflict {
    display: inline-flex;
    align-items: center;
    color: var(--warning);
}

.breadcrumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 1.375rem;
    flex-shrink: 0;
    padding: 0 8px;
    font-size: 0.8125em;
    color: var(--fg-muted);
    background: var(--bg-editor);
    overflow: hidden;
    white-space: nowrap;
}

.crumb {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fg-muted);
    font-size: 0.8125em;
}

.crumb:hover {
    background: var(--bg-hover);
    color: var(--fg);
}

.crumb.is-current {
    color: var(--fg);
}

.crumb-root {
    padding: 1px 3px;
}

.crumb-sep {
    display: inline-flex;
    align-items: center;
    color: var(--fg-dim);
}

.editor-host {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
}

/* ── 欢迎页 ───────────────────────────────────────────────── */

.welcome {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 7vh 24px 40px;
    background:
        radial-gradient(circle at 18% 12%, rgba(61, 220, 151, 0.055), transparent 42%),
        radial-gradient(circle at 82% 8%, rgba(0, 122, 204, 0.07), transparent 40%),
        var(--bg-editor);
}

.welcome-inner {
    width: min(940px, 100%);
}

.welcome-brand {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-bottom: 30px;
}

.welcome-logo {
    width: 54px;
    height: 54px;
    color: #3ddc97;
    fill: currentColor;
    stroke: none;
}

.welcome-brand h1 {
    margin: 0;
    font-size: var(--font-size-3xl);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--fg-strong);
}

.welcome-sub {
    margin: 5px 0 0;
    font-size: var(--font-size-sm);
    color: var(--fg-muted);
}

.welcome-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
}

.welcome-card {
    padding: 16px;
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    background: var(--bg-welcome-card);
}

.welcome-card h2 {
    margin: 0 0 12px;
    font-size: 0.8125em;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
}

.link-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 5px 6px;
    margin: 0 -6px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--fg);
    font-size: var(--font-size-xs);
    text-align: left;
}

.link-row:hover {
    background: var(--bg-hover);
    color: var(--fg-strong);
}

.kv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
    font-size: var(--font-size-xs);
    color: var(--fg-muted);
}

.recent-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.recent-item {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px 6px;
    margin: 0 -6px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--fg);
    text-align: left;
}

.recent-item:hover {
    background: var(--bg-hover);
}

.recent-name {
    font-size: var(--font-size-xs);
    white-space: nowrap;
}

.recent-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75em;
    color: var(--fg-dim);
    text-align: right;
}

.welcome-foot {
    margin: 26px 0 0;
    font-size: 0.8125em;
    color: var(--fg-dim);
    word-break: break-all;
}

/* ── 编辑器 ───────────────────────────────────────────────── */

.editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
}

.find-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
    padding: 5px 10px;
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border-soft);
}

.find-row {
    display: flex;
    align-items: center;
    gap: 6px;
}

.find-input-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--fg-muted);
}

.find-input-wrap .input {
    width: 200px;
    height: 1.5rem;
    padding: 0 2px;
    border: none;
    background: transparent;
}

.find-count {
    min-width: 52px;
    font-size: 0.8125em;
    color: var(--fg-muted);
}

.editor-body {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
}

.gutter {
    width: 58px;
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
    background: var(--bg-editor);
    user-select: none;
}

.gutter-text {
    margin: 0;
    padding: 10px 12px 10px 0;
    font-family: var(--font-mono);
    font-size: var(--code-size);
    line-height: var(--line-height);
    color: var(--fg-dim);
    text-align: right;
    white-space: pre;
    will-change: transform;
}

.code-view {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow: hidden;
}

.active-line {
    /* left 由 renderActiveLine 按文本行首（padding-left 减横向滚动量）逐帧写入，
       这里给同值初值，避免首帧贴到容器最左。right: 0 让高亮条延伸到视口右缘。 */
    position: absolute;
    left: 20px;
    right: 0;
    top: 0;
    height: var(--line-height);
    background: rgba(255, 255, 255, 0.045);
    pointer-events: none;
    display: none;
    z-index: 0;
}

:root[data-theme="light"] .active-line {
    background: rgba(0, 0, 0, 0.035);
}

.active-line.is-visible {
    display: block;
}

.code-layer {
    /*
     * 高亮层只装视口附近的行，由 positionViewLayer 用 transform 平移到「行首 + 行号」
     * 对应的位置：x = padding-left - scrollLeft，y = padding-top + 首行 * 行高 - scrollTop。
     * 所以层自身不能带 padding（padding 会重复计入），裁剪交给 .code-view 的 overflow: hidden；
     * 整篇文档的高度与滚动条归 textarea 管。
     */
    position: absolute;
    top: 0;
    left: 0;
    margin: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--code-size);
    line-height: var(--line-height);
    tab-size: var(--tab-size);
    white-space: pre;
    width: max-content;
    min-width: 100%;
    overflow: visible;
    pointer-events: none;
    color: var(--fg);
    will-change: transform;
    z-index: 1;
}

/*
 * 高亮层必须和 textarea 共用同一套字形度量。
 * 层里任何元素（包括 UA 自带字体的 code/pre/strong 等）都强制继承这些值，
 * 否则行高和字符宽度会出现差异，字号越大，正文与选区/当前行高亮错位越明显。
 */
.code-layer,
.code-layer * {
    font-family: var(--font-mono);
    font-size: var(--code-size);
    font-weight: 400;
    line-height: var(--line-height);
    letter-spacing: normal;
    word-spacing: normal;
}

.code-layer.is-hidden {
    visibility: hidden;
}

/*
 * 行级增量着色的渲染单元：一行一个 block 元素，行内不含换行。
 * 高度取行高（空行靠 min-height 撑住），这样每一行的位置和 textarea 的行盒一一对应；
 * 改一行时只改对应元素的 innerHTML，其余行的 DOM 不动。
 */
.code-layer .view-line {
    display: block;
    min-height: var(--line-height);
}

.code-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 10px 20px;
    border: none;
    outline: none;
    resize: none;
    background: transparent;
    color: transparent;
    -webkit-text-fill-color: transparent;
    caret-color: #aeafad;
    font-family: var(--font-mono);
    font-size: var(--code-size);
    line-height: var(--line-height);
    tab-size: var(--tab-size);
    white-space: pre;
    overflow: auto;
    z-index: 2;
    scrollbar-gutter: stable;
    touch-action: pan-x pan-y;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
}

:root[data-theme="light"] .code-input {
    caret-color: #000000;
}

.code-input::selection {
    background: var(--selection);
    -webkit-text-fill-color: transparent;
}

/* ── 自动补全 ─────────────────────────────────────────────── */

/* 与 textarea 完全同字体的度量探针，用来算光标前的横向像素宽度 */
.completion-probe {
    position: absolute;
    top: 0;
    left: -9999px;
    white-space: pre;
    font-family: var(--font-mono);
    font-size: var(--code-size);
    line-height: var(--line-height);
    tab-size: var(--tab-size);
    letter-spacing: normal;
    visibility: hidden;
    pointer-events: none;
}

.autocomplete {
    position: absolute;
    z-index: 6;
    display: flex;
    flex-direction: column;
    min-width: 220px;
    max-width: 420px;
    max-height: 15rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-menu);
    box-shadow: var(--shadow);
}

.autocomplete[hidden] {
    display: none;
}

.autocomplete-list {
    margin: 0;
    padding: 3px 0;
    overflow-y: auto;
    list-style: none;
    scrollbar-width: thin;
}

.autocomplete-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--code-size);
    line-height: 1.5;
    white-space: nowrap;
    cursor: pointer;
}

.autocomplete-item[aria-selected="true"] {
    background: var(--bg-active-item);
    color: var(--fg-strong);
}

.autocomplete-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.autocomplete-match {
    background: transparent;
    color: var(--tok-keyword);
    font-weight: 600;
}

/* 选中行背景是强调色：前缀改用前景色，避免蓝字压深蓝底 */
.autocomplete-item[aria-selected="true"] .autocomplete-match {
    color: var(--fg-strong);
}

.autocomplete-tag {
    flex: none;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--bg-hover);
    color: var(--fg-muted);
    font-family: var(--font-ui);
    font-size: var(--font-size-xs);
    line-height: 1.4;
}

.autocomplete-foot {
    margin: 0;
    padding: 2px 10px 4px;
    border-top: 1px solid var(--border-soft);
    color: var(--fg-dim);
    font-family: var(--font-ui);
    font-size: var(--font-size-xs);
    white-space: nowrap;
}

/* ── 差异比较窗口 ─────────────────────────────────────────── */

.diff-view {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg-editor);
}

.diff-view-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 2.25rem;
    flex-shrink: 0;
    padding: 0 10px;
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border-soft);
}

.diff-view-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--fg);
}

.diff-view-mode {
    flex: none;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--bg-selected);
    color: var(--fg-muted);
    font-size: 0.72em;
}

.diff-view-actions {
    display: flex;
    align-items: center;
    gap: 4px;
}

.diff-view-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px 0;
    font-family: var(--font-mono);
    font-size: var(--code-size);
    line-height: 1.55;
}

.diff-view-rows {
    min-width: max-content;
}

.diff-view-hunk {
    padding: 2px 10px;
    background: rgba(56, 139, 253, 0.12);
    color: var(--tok-keyword);
    white-space: pre;
}

.diff-view-row {
    display: grid;
    grid-template-columns: 52px max-content 52px max-content;
    align-items: stretch;
}

.diff-view-row:hover {
    background: var(--bg-hover);
}

.diff-no {
    padding: 0 8px 0 0;
    text-align: right;
    color: var(--fg-dim);
    font-size: 0.85em;
    user-select: none;
}

.diff-cell {
    padding: 0 8px;
    white-space: pre;
}

.diff-old.is-del {
    background: rgba(248, 81, 73, 0.16);
    color: var(--danger);
}

.diff-new.is-add {
    background: rgba(46, 160, 67, 0.18);
    color: var(--success);
}

.diff-cell.is-empty {
    background: var(--bg-hover);
}

.diff-view-note {
    margin: 12px 14px;
    color: var(--fg-muted);
    font-size: var(--font-size-xs);
    line-height: 1.6;
}

/* ── 源码管理（只读） ─────────────────────────────────────── */

.scm {
    flex: 1;
    overflow: auto;
    padding: 0 0 12px;
}

.scm-branch {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 14px 8px;
    font-size: var(--font-size-xs);
    color: var(--fg);
}

.scm-branch-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
}

.scm-sync {
    flex: none;
    color: var(--fg-dim);
    font-family: var(--font-mono);
    font-size: 0.75em;
}

.scm-groups {
    display: flex;
    flex-direction: column;
}

.scm-group {
    margin-bottom: 6px;
}

.scm-group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 14px;
    color: var(--fg-muted);
    font-size: 0.75em;
    letter-spacing: 0.05em;
    text-transform: uppercase;
}

.scm-group-count {
    color: var(--fg-dim);
}

.scm-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 2px 8px 2px 14px;
}

.scm-item:hover {
    background: var(--bg-hover);
}

.scm-letter {
    flex: none;
    width: 15px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 0.7em;
    font-weight: 700;
    color: var(--warning);
}

.scm-letter-A {
    color: var(--success);
}

.scm-letter-D,
.scm-letter-U {
    color: var(--danger);
}

.scm-letter-R,
.scm-letter-C {
    color: var(--tok-type);
}

.scm-letter-\? {
    color: var(--fg-dim);
}

.scm-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--fg);
    text-align: left;
    font-size: var(--font-size-xs);
    cursor: pointer;
}

.scm-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scm-dir {
    color: var(--fg-dim);
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scm-diff-btn {
    flex: none;
    padding: 0 4px;
    font-size: 0.72em;
}

.scm-action {
    flex: none;
    padding: 0 2px;
}

.tree-scm {
    margin-left: auto;
    padding: 0 6px;
    font-family: var(--font-mono);
    font-size: 0.68em;
    font-weight: 700;
    color: var(--warning);
}

/* ── 语法诊断标记 ─────────────────────────────────────────── */

.diagnostic-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    z-index: 3;
    pointer-events: none;
}

.diagnostic-mark {
    position: absolute;
    height: var(--line-height);
    pointer-events: none;
}

/* 用两段斜纹拼出波浪线，颜色跟随主题的 danger / warning */
.diagnostic-mark::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 3px;
    height: 2px;
    background-image:
        linear-gradient(135deg, var(--danger) 25%, transparent 25%),
        linear-gradient(225deg, var(--danger) 25%, transparent 25%);
    background-size: 5px 5px;
    opacity: 0.9;
}

.diagnostic-mark[data-severity="warning"]::after {
    background-image:
        linear-gradient(135deg, var(--warning) 25%, transparent 25%),
        linear-gradient(225deg, var(--warning) 25%, transparent 25%);
}

/* ── 缩进参考线与括号配对 ─────────────────────────────────── */

.indent-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    pointer-events: none;
}

.bracket-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    z-index: 1;
    pointer-events: none;
}

.bracket-mark {
    position: absolute;
    height: var(--line-height);
    border-radius: 2px;
    background: var(--bracket-match);
    box-shadow: inset 0 0 0 1px var(--bracket-border);
}

.code-input.is-composing {
    -webkit-text-fill-color: var(--fg);
    color: var(--fg);
}

.code-input.is-composing::selection {
    -webkit-text-fill-color: var(--fg);
}

/*
 * IME 组合期间 textarea 只装光标所在行，贴到该行真实位置（left/top/width 由
 * positionComposition 写入）；高亮层里这一行用同底色的遮罩盖掉，避免重字。
 */
.ime-line-cover {
    position: absolute;
    left: 0;
    right: 0;
    height: var(--line-height);
    background: var(--bg-editor);
    pointer-events: none;
    display: none;
    z-index: 2;
}

.ime-line-cover.is-visible {
    display: block;
}

/* 遮罩在诊断波浪线（z-index 3）之下；组合期间把单行 textarea 抬到它们上面 */
.code-view.is-ime-composing .code-input {
    z-index: 4;
}

.code-input.is-readonly {
    caret-color: transparent;
}

.minimap {
    width: 74px;
    flex-shrink: 0;
    height: 100%;
    display: block;
    cursor: pointer;
    border-left: 1px solid var(--border-soft);
    background: var(--bg-editor);
}

.minimap.is-hidden {
    display: none;
}

/* ── 代码着色 ─────────────────────────────────────────────── */

.tok-comment { color: var(--tok-comment); font-style: italic; }
.tok-string { color: var(--tok-string); }
.tok-number { color: var(--tok-number); }
.tok-keyword { color: var(--tok-keyword); }
.tok-type { color: var(--tok-type); }
.tok-function { color: var(--tok-function); }
.tok-variable { color: var(--tok-variable); }
.tok-property { color: var(--tok-property); }
.tok-tag { color: var(--tok-tag); }
.tok-attr { color: var(--tok-attr); }
.tok-punct { color: var(--tok-punct); }
.tok-literal { color: var(--tok-literal); }
.tok-operator { color: var(--tok-operator); }
.tok-decorator { color: var(--tok-decorator); }
.tok-entity { color: var(--tok-entity); }
.tok-link { color: var(--tok-link); text-decoration: underline; text-underline-offset: 2px; }
.tok-inserted { color: var(--tok-inserted); }
.tok-deleted { color: var(--tok-deleted); }
.tok-fence { color: var(--tok-fence); }

/* ── 终端 ─────────────────────────────────────────────────── */

.terminal {
    display: flex;
    flex-direction: column;
    height: var(--terminal-height, 240px);
    min-height: 96px;
    /* 给上方的编辑器留出空间：即使保存的高度超过窗口，也不会把编辑器挤没 */
    max-height: calc(100% - 11rem);
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--bg-sidebar);
}

/* 终端高度拖拽条：贴在终端顶部，悬停/聚焦/拖动时显示强调线 */
.terminal-resizer {
    position: relative;
    z-index: 5;
    height: 6px;
    flex-shrink: 0;
    margin-bottom: -1px;
    cursor: row-resize;
    touch-action: none;
    background: transparent;
}

.terminal-resizer::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 0;
    right: 0;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
    opacity: 0;
    transition: opacity 120ms ease;
    pointer-events: none;
}

.terminal-resizer:hover::after,
.terminal-resizer:focus-visible::after,
body.is-resizing-terminal .terminal-resizer::after {
    opacity: 0.9;
}

.terminal-resizer:focus-visible {
    outline: none;
}

body.is-resizing-terminal {
    cursor: row-resize;
    user-select: none;
}

.terminal-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 2.125rem;
    flex-shrink: 0;
    padding: 0 6px 0 10px;
    border-bottom: 1px solid var(--border-soft);
}

.terminal-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
}

.terminal-tabs::-webkit-scrollbar {
    display: none;
}

.terminal-tab {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px 0 8px;
    border-radius: 3px;
    background: transparent;
    color: var(--fg-muted);
    font-size: 0.8125em;
    white-space: nowrap;
}

.terminal-tab:hover {
    background: var(--bg-hover);
}

.terminal-tab.is-active {
    background: var(--bg-selected);
    color: var(--fg-strong);
}

.terminal-tab.is-running::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warning);
    flex-shrink: 0;
}

/* 标签里的名称与关闭按钮；名称可点，× 只在悬停 / 激活时出现 */
.terminal-tab-name {
    padding: 2px 2px;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
}

.terminal-tab-name:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 0;
}

.terminal-tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.15em;
    height: 1.15em;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
}

.terminal-tab:hover .terminal-tab-close,
.terminal-tab:focus-within .terminal-tab-close,
.terminal-tab.is-active .terminal-tab-close {
    opacity: 0.75;
}

.terminal-tab-close:hover {
    opacity: 1;
    background: var(--bg-hover);
}

.terminal-empty {
    margin-top: 4px;
    font-family: var(--font-ui);
    font-size: var(--font-size-sm);
    color: var(--fg-dim);
}

.terminal-actions {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
}

.terminal-cwd {
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75em;
    color: var(--fg-dim);
}

.terminal-view {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
}

.terminal-body ::selection {
    background: var(--selection);
}

/* 回看滚动条：默认淡出，悬停终端 / 拖动滑块时显示 */
.terminal-scrollbar {
    position: absolute;
    top: 8px;
    bottom: 8px;
    right: 3px;
    width: 9px;
    z-index: 4;
    opacity: 0;
    transition: opacity 140ms ease;
}

.terminal-view:hover .terminal-scrollbar,
.terminal-scrollbar.is-active {
    opacity: 1;
}

.terminal-scrollbar[hidden] {
    display: none;
}

.terminal-scrollbar-thumb {
    position: absolute;
    left: 2px;
    width: 5px;
    min-height: 18px;
    border-radius: 3px;
    background: var(--fg-dim);
    opacity: 0.55;
    cursor: pointer;
}

.terminal-scrollbar-thumb:hover {
    opacity: 0.9;
}

/* 回看时的“回到底部 / 有新输出”浮动按钮 */
.terminal-jump {
    position: absolute;
    right: 14px;
    bottom: 8px;
    z-index: 5;
    padding: 2px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-sidebar);
    color: var(--fg-muted);
    font-family: var(--font-ui);
    font-size: 0.75em;
    cursor: pointer;
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
}

.terminal-jump:hover {
    color: var(--fg-strong);
    border-color: var(--accent);
}

.terminal-jump[hidden] {
    display: none;
}

.terminal-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: var(--code-size);
    line-height: 1.5;
    color: var(--fg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    cursor: text;
}

.terminal-line-command {
    color: var(--tok-function);
}

.terminal-line-meta {
    color: var(--fg-dim);
}

.terminal-line-error {
    color: var(--danger);
}

/* 移动端软键盘只认可编辑元素：这个看不见的 textarea 负责收字符，再转发给 PTY */
.terminal-capture {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
    resize: none;
    overflow: hidden;
    font-size: 16px;
    line-height: 1;
    pointer-events: none;
    z-index: 1;
}

.terminal-input-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 5px 12px 7px;
    border-top: 1px solid var(--border-soft);
}

.terminal-prompt {
    font-family: var(--font-mono);
    font-size: var(--code-size);
    color: var(--success);
    user-select: none;
}

.terminal-input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--code-size);
}

.terminal-input::placeholder {
    color: var(--fg-dim);
}

/* VT 屏幕：PTY 输出按等宽网格渲染 */

.terminal-body {
    /* 网格渲染不吃父级的换行策略，逐行由 .vt-row 控制 */
    white-space: normal;
    position: relative;
    --terminal-pad-y: 8px;
    --terminal-pad-x: 12px;
}

.vt-row {
    height: var(--vt-row-height, 19px);
    line-height: var(--vt-row-height, 19px);
    white-space: pre;
    font-variant-ligatures: none;
}

.vt-run {
    white-space: pre;
}

.vt-bold { font-weight: 700; }
.vt-dim { opacity: 0.65; }
.vt-italic { font-style: italic; }
.vt-underline { text-decoration: underline; }
.vt-inverse { filter: invert(1); }

/* 块光标：实心 + 反色字符，未聚焦时显示空心框 */
.vt-cursor {
    position: absolute;
    z-index: 2;
    width: var(--vt-char-width, 7.8px);
    height: var(--vt-row-height, 19px);
    background: var(--fg);
    color: var(--bg-sidebar);
    font-family: inherit;
    font-size: inherit;
    line-height: var(--vt-row-height, 19px);
    white-space: pre;
    pointer-events: none;
    animation: vt-cursor-blink 1.1s infinite;
}

.vt-cursor.is-idle {
    background: transparent;
    color: inherit;
    outline: 1px solid var(--fg-dim);
    outline-offset: -1px;
    animation: none;
}

@keyframes vt-cursor-blink {
    0%,
    45% {
        opacity: 1;
    }

    46%,
    100% {
        opacity: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .vt-cursor {
        animation: none;
    }
}

.vt-probe {
    position: absolute;
    visibility: hidden;
    white-space: pre;
    pointer-events: none;
}

.vt-fg-0 { color: var(--ansi-0); }
.vt-fg-1 { color: var(--ansi-1); }
.vt-fg-2 { color: var(--ansi-2); }
.vt-fg-3 { color: var(--ansi-3); }
.vt-fg-4 { color: var(--ansi-4); }
.vt-fg-5 { color: var(--ansi-5); }
.vt-fg-6 { color: var(--ansi-6); }
.vt-fg-7 { color: var(--ansi-7); }
.vt-fg-8 { color: var(--ansi-8); }
.vt-fg-9 { color: var(--ansi-9); }
.vt-fg-10 { color: var(--ansi-10); }
.vt-fg-11 { color: var(--ansi-11); }
.vt-fg-12 { color: var(--ansi-12); }
.vt-fg-13 { color: var(--ansi-13); }
.vt-fg-14 { color: var(--ansi-14); }
.vt-fg-15 { color: var(--ansi-15); }
.vt-bg-0 { background-color: var(--ansi-0); }
.vt-bg-1 { background-color: var(--ansi-1); }
.vt-bg-2 { background-color: var(--ansi-2); }
.vt-bg-3 { background-color: var(--ansi-3); }
.vt-bg-4 { background-color: var(--ansi-4); }
.vt-bg-5 { background-color: var(--ansi-5); }
.vt-bg-6 { background-color: var(--ansi-6); }
.vt-bg-7 { background-color: var(--ansi-7); }
.vt-bg-8 { background-color: var(--ansi-8); }
.vt-bg-9 { background-color: var(--ansi-9); }
.vt-bg-10 { background-color: var(--ansi-10); }
.vt-bg-11 { background-color: var(--ansi-11); }
.vt-bg-12 { background-color: var(--ansi-12); }
.vt-bg-13 { background-color: var(--ansi-13); }
.vt-bg-14 { background-color: var(--ansi-14); }
.vt-bg-15 { background-color: var(--ansi-15); }

/* ── 预览 ─────────────────────────────────────────────────── */

.preview {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
}

.preview-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 36px;
    flex-shrink: 0;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
}

.preview-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-size-xs);
    color: var(--fg-muted);
}

.preview-actions {
    display: flex;
    align-items: center;
    gap: 4px;
}

.preview-body {
    flex: 1;
    overflow: auto;
    padding: 26px 32px 60px;
}

.preview-image {
    display: block;
    max-width: 100%;
    max-height: 72vh;
    margin: 0 auto;
    border-radius: 6px;
    background-image:
        linear-gradient(45deg, rgba(128, 128, 128, 0.16) 25%, transparent 25%),
        linear-gradient(-45deg, rgba(128, 128, 128, 0.16) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.16) 75%),
        linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.16) 75%);
    background-size: 18px 18px;
    background-position: 0 0, 0 9px, 9px -9px, -9px 0;
}

.preview-meta {
    margin: 14px 0 0;
    text-align: center;
    font-size: 0.8125em;
    color: var(--fg-dim);
}

.preview-empty {
    margin: 8vh auto 0;
    max-width: 420px;
    text-align: center;
    font-size: var(--font-size-sm);
    line-height: 1.7;
    color: var(--fg-muted);
}

/* ── Markdown 预览 ────────────────────────────────────────── */

.markdown-body {
    max-width: 840px;
    margin: 0 auto;
    font-size: var(--font-size-base);
    line-height: 1.75;
    color: var(--fg);
    overflow-wrap: break-word;
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
    margin: 1.6em 0 0.6em;
    font-weight: 600;
    line-height: 1.3;
    color: var(--fg-strong);
}

.markdown-body h1 {
    font-size: 1.9em;
    border-bottom: 1px solid var(--border-soft);
    padding-bottom: 0.3em;
}

.markdown-body h2 {
    font-size: 1.45em;
    border-bottom: 1px solid var(--border-soft);
    padding-bottom: 0.25em;
}

.markdown-body h3 { font-size: 1.2em; }
.markdown-body h4 { font-size: 1.05em; }

.markdown-body p {
    margin: 0.7em 0;
}

.markdown-body ul,
.markdown-body ol {
    margin: 0.6em 0;
    padding-left: 1.6em;
}

.markdown-body li {
    margin: 0.25em 0;
}

.markdown-body code {
    font-family: var(--font-mono);
    font-size: 0.88em;
    padding: 0.15em 0.35em;
    border-radius: 4px;
    background: var(--bg-selected);
}

.markdown-body pre.md-code {
    margin: 1em 0;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
    overflow: auto;
    font-size: var(--font-size-xs);
    line-height: 1.55;
}

.markdown-body pre.md-code code {
    padding: 0;
    background: transparent;
    font-size: inherit;
    white-space: pre;
}

.markdown-body blockquote {
    margin: 0.8em 0;
    padding: 0.1em 1em;
    border-left: 3px solid var(--accent);
    color: var(--fg-muted);
}

.markdown-body hr {
    border: none;
    border-top: 1px solid var(--border-soft);
    margin: 1.6em 0;
}

.markdown-body a {
    color: var(--tok-link);
    text-decoration: none;
}

.markdown-body a:hover {
    text-decoration: underline;
}

.markdown-body table {
    border-collapse: collapse;
    margin: 1em 0;
    width: 100%;
    font-size: var(--font-size-sm);
}

.markdown-body th,
.markdown-body td {
    border: 1px solid var(--border);
    padding: 6px 10px;
    text-align: left;
}

.markdown-body th {
    background: var(--bg-sidebar);
    font-weight: 600;
}

.markdown-body .md-table-wrap {
    overflow-x: auto;
}

/* ── 状态栏 ───────────────────────────────────────────────── */

.statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 1.4375rem;
    flex-shrink: 0;
    padding: 0 4px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 0.8125em;
    user-select: none;
}

.status-left,
.status-right {
    display: flex;
    align-items: center;
    gap: 1px;
    min-width: 0;
}

.status-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 1.25rem;
    padding: 0 7px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--accent-fg);
    font-size: 0.8125em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 260px;
}

.status-item:hover {
    background: rgba(255, 255, 255, 0.16);
}

.status-item .icon {
    width: 14px;
    height: 14px;
    stroke-width: 1.7;
}

.status-muted {
    opacity: 0.82;
}

.status-flash {
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    font-size: 0.8125em;
    opacity: 0;
    transition: opacity 160ms ease;
}

.status-flash.is-visible {
    opacity: 1;
}

#status-readonly {
    background: rgba(0, 0, 0, 0.18);
    font-weight: 600;
}

/* ── 浮层与命令面板 ───────────────────────────────────────── */

.overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 11vh;
}

.overlay-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.34);
}

:root[data-theme="light"] .overlay-backdrop {
    background: rgba(0, 0, 0, 0.14);
}

.palette {
    position: relative;
    z-index: 1;
    width: min(680px, 92vw);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-menu);
    box-shadow: var(--shadow);
    overflow: hidden;
}

.palette-input-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-soft);
}

.palette-prefix {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--accent);
    width: 12px;
    text-align: center;
}

.palette-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    color: var(--fg-strong);
    font-size: var(--font-size-base);
}

.palette-input::placeholder {
    color: var(--fg-dim);
}

.palette-list {
    list-style: none;
    margin: 0;
    padding: 6px 0;
    max-height: 46vh;
    overflow: auto;
}

.palette-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 14px;
    border: none;
    background: transparent;
    color: var(--fg);
    text-align: left;
    font-size: var(--font-size-xs);
}

.palette-item.is-active {
    background: var(--bg-active-item);
    color: var(--fg-strong);
}

.palette-category {
    width: 44px;
    flex-shrink: 0;
    font-size: 0.75em;
    letter-spacing: 0.04em;
    color: var(--fg-dim);
}

.palette-item.is-active .palette-category {
    color: var(--fg-muted);
}

.palette-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.palette-foot {
    margin: 0;
    padding: 7px 14px;
    border-top: 1px solid var(--border-soft);
    font-size: 0.8125em;
    color: var(--fg-dim);
}

.quick-item .quick-name {
    flex: 0 1 auto;
    font-size: var(--font-size-xs);
}

.quick-item .quick-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    font-size: 0.75em;
    color: var(--fg-dim);
}

/* ── 菜单与右键菜单 ───────────────────────────────────────── */

.menu-popup {
    position: fixed;
    z-index: 70;
    min-width: 250px;
    padding: 4px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-menu);
    box-shadow: var(--shadow);
}

.context-menu {
    position: fixed;
    z-index: 80;
    min-width: 210px;
    max-width: 320px;
    padding: 4px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-menu);
    box-shadow: var(--shadow);
}

.menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    width: 100%;
    padding: 6px 14px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: var(--font-size-xs);
    text-align: left;
    white-space: nowrap;
}

.menu-item:hover {
    background: var(--bg-active-item);
}

.menu-item.is-disabled {
    color: var(--fg-dim);
    cursor: default;
}

.menu-item.is-disabled:hover {
    background: transparent;
}

.menu-item.is-danger {
    color: var(--danger);
}

.menu-label {
    overflow: hidden;
    text-overflow: ellipsis;
}

.menu-separator {
    height: 1px;
    margin: 4px 0;
    background: var(--border-soft);
}

/* ── 弹窗 ─────────────────────────────────────────────────── */

.modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.42);
}

:root[data-theme="light"] .modal-backdrop {
    background: rgba(0, 0, 0, 0.18);
}

.modal {
    width: min(560px, 92vw);
    max-height: 82vh;
    overflow: auto;
    padding: 18px 20px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--bg-menu);
    box-shadow: var(--shadow);
}

.modal-title {
    margin: 0 0 10px;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--fg-strong);
}

.modal-text {
    margin: 0;
    font-size: var(--font-size-sm);
    line-height: 1.65;
    color: var(--fg-muted);
}

.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
}

.btn {
    height: 28px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--fg);
    font-size: var(--font-size-xs);
}

.btn:hover {
    background: var(--bg-hover);
}

.btn-primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
}

.btn-primary:hover {
    background: var(--accent-hover);
}

.btn-danger {
    border-color: var(--danger);
    background: transparent;
    color: var(--danger);
}

.btn-danger:hover {
    background: var(--danger-soft);
}

.prompt-form {
    display: flex;
    flex-direction: column;
    gap: 7px;
}

.prompt-label {
    font-size: var(--font-size-xs);
    color: var(--fg-muted);
}

.prompt-form .input {
    width: 100%;
}

.field-error {
    margin: 0;
    font-size: 0.8125em;
    color: var(--danger);
}

.shortcut-table {
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border-soft);
    font-size: var(--font-size-xs);
}

.shortcut-row:last-child {
    border-bottom: none;
}

.shortcut-label {
    color: var(--fg-muted);
}

/* ── 关于 ─────────────────────────────────────────────────── */

.about-brand {
    display: flex;
    justify-content: center;
    margin: 2px 0 8px;
}

.about-logo {
    width: 46px;
    height: 46px;
    color: #3ddc97;
    fill: currentColor;
    stroke: none;
}

.about-version {
    margin: 0 0 14px;
    text-align: center;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--fg-strong);
}

.about-table {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 6px 12px;
    margin: 0;
    font-size: var(--font-size-xs);
}

.about-table dt {
    color: var(--fg-muted);
}

.about-table dd {
    margin: 0;
    color: var(--fg);
    overflow-wrap: anywhere;
}

.about-hint {
    margin: 16px 0 0;
    font-size: 0.8125em;
    line-height: 1.6;
    color: var(--fg-dim);
}

/* ── 提示条 ───────────────────────────────────────────────── */

.toasts {
    position: fixed;
    right: 16px;
    bottom: 38px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 340px;
    max-width: calc(100vw - 32px);
    pointer-events: none;
}

.toast {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 10px 10px 10px 12px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    background: var(--bg-menu);
    box-shadow: var(--shadow);
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 160ms ease, transform 160ms ease;
    pointer-events: auto;
}

.toast.is-visible {
    opacity: 1;
    transform: none;
}

.toast-error {
    border-left-color: var(--danger);
}

.toast-warning {
    border-left-color: var(--warning);
}

.toast-icon {
    margin-top: 1px;
    color: var(--fg-muted);
}

.toast-error .toast-icon {
    color: var(--danger);
}

.toast-warning .toast-icon {
    color: var(--warning);
}

.toast-text {
    flex: 1;
    margin: 0;
    font-size: var(--font-size-xs);
    line-height: 1.55;
    color: var(--fg);
    overflow-wrap: anywhere;
}

.toast-close {
    display: inline-flex;
    padding: 2px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fg-dim);
}

.toast-close:hover {
    background: var(--bg-hover);
    color: var(--fg);
}

/* ── 响应式 ───────────────────────────────────────────────── */

@media (max-width: 980px) {
    .welcome-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .welcome-recent {
        grid-column: span 2;
    }

    .titlebar-center {
        width: 30vw;
        min-width: 120px;
    }
}

@media (max-width: 760px) {
    .titlebar-center {
        display: none;
    }

    .sidebar {
        position: absolute;
        top: 2.25rem;
        bottom: auto;
        left: var(--activity-width);
        z-index: 40;
        width: min(300px, calc(100vw - var(--activity-width) - 12px));
        height: calc(var(--app-height, 100vh) - 2.25rem - 1.4375rem);
        box-shadow: var(--shadow);
    }

    /* 收起时整块移出活动栏右侧，避免 100vw 换算后残留一条边 */
    .sidebar.is-hidden,
    .workbench.sidebar-hidden .sidebar {
        display: flex;
        transform: translateX(calc(-100% - var(--activity-width)));
        visibility: hidden;
        pointer-events: none;
    }

    .welcome {
        padding: 5vh 16px 40px;
    }

    .welcome-grid {
        grid-template-columns: minmax(0, 1fr);
    }

    .welcome-recent {
        grid-column: auto;
    }

    .minimap {
        display: none;
    }

    .breadcrumbs {
        display: none;
    }
}

@media (max-width: 560px) {
    .brand-name,
    #status-root,
    #status-indent,
    #status-eol,
    #status-encoding,
    #status-selection {
        display: none;
    }

    .menubar-item {
        padding: 0 6px;
        font-size: 0.8125em;
    }

    :root {
        --activity-width: 2.625rem;
    }

    .gutter {
        width: 44px;
    }

    .preview-body {
        padding: 16px 14px 40px;
    }
}

@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
    }
}

@media (prefers-contrast: more) {
    :root {
        --border: #6b6b6b;
        --border-soft: #555555;
        --fg-muted: #c0c0c0;
        --fg-dim: #a8a8a8;
    }
}

/* ── 登录与访问密码 ───────────────────────────────────────── */

.auth {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg-editor);
}

.auth-card {
    width: 100%;
    max-width: 340px;
    padding: 26px 24px 22px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-sidebar);
    box-shadow: var(--shadow);
}

.auth-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    color: var(--fg-strong);
    font-size: var(--font-size-sm);
}

.auth-brand b {
    color: var(--tok-link);
}

.auth-logo {
    width: 24px;
    height: 24px;
}

.auth-title {
    margin: 0 0 6px;
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--fg-strong);
}

.auth-hint {
    margin: 0 0 16px;
    color: var(--fg-muted);
    font-size: var(--font-size-xs);
    line-height: 1.6;
}

.auth-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.auth-input {
    height: 2rem;
}

.auth-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--font-size-xs);
}

.auth-submit {
    height: 2rem;
}

.settings-group {
    margin-top: 14px;
    border-top: 1px solid var(--border-soft);
    padding-top: 10px;
}

.settings-title {
    margin: 0;
    padding: 0 14px 4px;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--fg-strong);
}

.settings-group .sidebar-hint {
    padding: 0 14px 6px;
    white-space: normal;
    line-height: 1.5;
}

.setting-stack {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
}

.setting-stack .input {
    width: 100%;
}

.settings-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 2px;
}
`
