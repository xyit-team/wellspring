/*
 * 静态资源注册表。
 * 前端脚本拼进同一个 IIFE：语法高亮、终端屏幕模型、编辑器与 UI 逻辑共享作用域。
 */

import { createHash } from "node:crypto"

import { ANALYSIS_JS } from "./analysis.ts"
import { ANSI_JS } from "./ansi.ts"
import { APP_JS } from "./app.ts"
import { EDITOR_JS } from "./editor.ts"
import { FAVICON_SVG } from "./favicon.ts"
import { HIGHLIGHT_JS } from "./highlight.ts"
import { STYLES } from "./styles.ts"

const CLIENT_JS = `(function () {
"use strict";
${HIGHLIGHT_JS}
${ANALYSIS_JS}
${ANSI_JS}
${EDITOR_JS}
${APP_JS}
})()
`

export interface StaticAsset {
    readonly body: string
    readonly contentType: string
    /** 强校验用的内容 ETag */
    readonly etag: string
}

function asset(body: string, contentType: string): StaticAsset {
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 16)
    return { body, contentType, etag: `"${digest}"` }
}

export const STATIC_ASSETS: ReadonlyMap<string, StaticAsset> = new Map([
    ["/assets/app.css", asset(STYLES, "text/css; charset=utf-8")],
    ["/assets/app.js", asset(CLIENT_JS, "text/javascript; charset=utf-8")],
    ["/favicon.svg", asset(FAVICON_SVG, "image/svg+xml; charset=utf-8")],
])

/** 供测试断言客户端代码可解析 */
export const CLIENT_SCRIPT = CLIENT_JS

/** 供测试检查样式表结构 */
export const CLIENT_STYLES = STYLES
