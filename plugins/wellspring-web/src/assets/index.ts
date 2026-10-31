/*
 * 静态资源注册表：Vue 客户端资源（构建产物）+ 样式 + 图标。
 * 构建：node scripts/build-ui.mjs（frontend/ → src/assets/vue-client.ts）
 */

import { createHash } from "node:crypto"

import { FAVICON_SVG } from "./favicon.ts"
import { STYLES } from "./styles.ts"
import { VUE_CLIENT_CSS, VUE_CLIENT_JS } from "./vue-client.ts"

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
    ["/assets/app-vue.js", asset(VUE_CLIENT_JS, "text/javascript; charset=utf-8")],
    ...(VUE_CLIENT_CSS === ""
        ? []
        : [["/assets/app-vue.css", asset(VUE_CLIENT_CSS, "text/css; charset=utf-8")] as const]),
    ["/favicon.svg", asset(FAVICON_SVG, "image/svg+xml; charset=utf-8")],
])
