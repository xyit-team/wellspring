/*
 * 页面外壳：Vue 前端由 /assets/app-vue.js 挂载，HTML 仅保留 SPRITE、主题属性与同源资源引用，
 * 便于服务端下发严格 CSP（无内联 script/style）。
 */

import type { ThemeName } from "./theme.ts"

const SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
<symbol id="i-spring" viewBox="0 0 24 24"><path d="M12 3.4c3.3 3.5 5.6 6.4 5.6 9.2a5.6 5.6 0 1 1-11.2 0c0-2.8 2.3-5.7 5.6-9.2Z"/><path d="M9.4 12.7c1.6 1.5 3.6 1.5 5.2 0"/></symbol>
<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-send" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></symbol>
<symbol id="i-stop" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19.5 7"/></symbol>
<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></symbol>
<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v6M14 11v6"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
<symbol id="i-logout" viewBox="0 0 24 24"><path d="M14 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7M17 8l4 4-4 4M11 12h10"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4.5 21 19H3l9-14.5Z"/><path d="M12 10v4M12 16.6v.4"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/></symbol>
<symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-eye-off" viewBox="0 0 24 24"><path d="M4 4l16 16"/><path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.4 7.7A16.8 16.8 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.4 9.4 0 0 0 3.7-.8"/><path d="M9.9 10.2a3 3 0 0 0 4.2 4.2"/></symbol>
<symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6V3Z"/><path d="M13 3v5h5M9 13h6M9 17h6"/></symbol>
<symbol id="i-code" viewBox="0 0 24 24"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></symbol>
<symbol id="i-power" viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/></symbol>
<symbol id="i-cpu" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/></symbol>
<symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="15.5" r="3.5"/><path d="m10.6 13.4 8.9-8.9M16.8 7.2l2 2M14.4 9.6l2 2"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3.5 19 6v6c0 4.4-3 7.6-7 8.5-4-.9-7-4.1-7-8.5V6l7-2.5Z"/><path d="m9 12 2 2 4-4"/></symbol>
<symbol id="i-archive" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="4" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l1.9 2h7.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z"/></symbol>
<symbol id="i-server" viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.5M7 16.5h.5"/></symbol>
<symbol id="i-think" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5.9 1.2.9 2V17h5.4v-1.2c0-.8.3-1.5.9-2A6 6 0 0 0 12 3Z"/><path d="M9 17h6M10 20h4"/></symbol>
<symbol id="i-tool" viewBox="0 0 24 24"><path d="M15.2 3.4a4.7 4.7 0 0 0-4.6 8.1l-6.9 6.9a1.7 1.7 0 0 0 2.4 2.4l6.9-6.9a4.7 4.7 0 0 0 6.7-5.6l-2.5 2.5-2.6-.7-.7-2.6 2.5-2.5a4.7 4.7 0 0 0-1.2-1.6Z"/></symbol>
<symbol id="i-chevron" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
<symbol id="i-chevron-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
<symbol id="i-edit" viewBox="0 0 24 24"><path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5v3Z"/><path d="m13.5 6.5 4 4"/></symbol>
<symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20v-8M10 20V4M16 20v-6M21 20H3"/></symbol>
<symbol id="i-network" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.7 5.4 3.7 8.5s-1.3 6.1-3.7 8.5c-2.4-2.4-3.7-5.4-3.7-8.5s1.3-6.1 3.7-8.5Z"/></symbol>
</svg>`

/** system 主题不写 data-theme，交给 prefers-color-scheme */
export function themeAttribute(theme: ThemeName): string {
    return theme === "system" ? "" : ` data-theme="${theme}"`
}

/** Vue 前端的页面外壳：SPRITE 供组件里的 <use href="#i-…"> 使用 */
export interface VueHomeOptions {
    /** 前端构建产物里带 CSS 时再加一条同源样式表 */
    readonly styles: boolean
}

export function renderVueHome(
    theme: ThemeName,
    options: VueHomeOptions = { styles: false },
): string {
    return `<!doctype html>
<html lang="zh-CN"${themeAttribute(theme)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0a1119" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f5f7fa" media="(prefers-color-scheme: light)">
<meta name="description" content="Wellspring Agent 的网页聊天界面">
<meta name="robots" content="noindex, nofollow">
<title>Wellspring</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/assets/app.css">
${options.styles ? '<link rel="stylesheet" href="/assets/app-vue.css">' : ""}
</head>
<body>
<a class="skip-link" href="#composer-input" hidden>跳到输入框</a>
${SPRITE}
<noscript>
  <div class="boot"><p>这个界面需要 JavaScript。</p></div>
</noscript>
<div id="vue-app"></div>
<script type="module" src="/assets/app-vue.js"></script>
</body>
</html>`
}
