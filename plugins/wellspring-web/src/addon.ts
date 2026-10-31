/*
 * wellspring-web 扩展点。
 *
 * 其它插件通过宿主事件总线注册界面片段：
 *
 *   eventBus.publish("wellspring-web:addon:register", EventEntity.create({
 *       type: "nav-bottom",
 *       meta: { label: "打开 Wellspring Code", to: "http://127.0.0.1:8788" }
 *   }))
 *
 * 当前支持 nav-bottom：在网页侧边栏最下方追加一个 <a>。
 */

import type { EventEntity } from "wellspring/api/host/index.ts"
import { eventBus, onShutdown } from "wellspring/api/host/index.ts"

export type WellspringWebAddonType = "nav-bottom"

export interface WellspringWebAddon {
    readonly type: WellspringWebAddonType
    readonly meta: Record<string, unknown>
}

export interface NavBottomAddon {
    readonly id: string
    readonly label: string
    readonly to: string
    /** 绝对 http(s) 链接由前端用新标签页打开 */
    readonly external: boolean
}

const MAX_NAV_BOTTOM_ADDONS = 8
const MAX_LABEL_CHARS = 80
const MAX_URL_CHARS = 2048
const MAX_ID_CHARS = 128

type NavBottomListener = (addons: readonly NavBottomAddon[]) => void

const navBottomAddons = new Map<string, NavBottomAddon>()
const listeners = new Set<NavBottomListener>()

const ADDON_EVENT = "wellspring-web:addon:register"

/** 只允许站内相对路径与 http(s) 绝对地址，避免 javascript: 等伪协议 */
export function sanitizeAddonLink(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }
    const to = value.trim()
    if (to === "" || to.length > MAX_URL_CHARS) {
        return null
    }
    if (to.startsWith("/")) {
        return to.startsWith("//") ? null : to
    }
    // 允许省略协议写成 host:port（如 127.0.0.1:8788），统一补成 http
    if (/^[A-Za-z0-9.-]+:\d{1,5}(?:[/?#]|$)/.test(to)) {
        try {
            const url = new URL(`http://${to}`)
            if (url.hostname !== "") {
                return url.toString()
            }
        } catch {
            return null
        }
    }
    try {
        const url = new URL(to)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null
        }
        return url.toString()
    } catch {
        return null
    }
}

function sanitizeLabel(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }
    const label = value.trim()
    if (label === "" || label.length > MAX_LABEL_CHARS) {
        return null
    }
    return label
}

function sanitizeId(value: unknown, fallback: string): string {
    if (typeof value === "string") {
        const id = value.trim()
        if (id !== "" && id.length <= MAX_ID_CHARS) {
            return id
        }
    }
    return fallback
}

export function listNavBottomAddons(): readonly NavBottomAddon[] {
    return [...navBottomAddons.values()]
}

/** 订阅侧栏链接变化；返回退订函数 */
export function subscribeNavBottomAddons(listener: NavBottomListener): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

function notify(): void {
    const snapshot = listNavBottomAddons()
    for (const listener of [...listeners]) {
        try {
            listener(snapshot)
        } catch {
            /* 单个订阅者异常不影响其它订阅者 */
        }
    }
}

/** 注册一个侧栏底部链接；返回真正生效的条目，校验失败返回 null */
export function registerNavBottomAddon(meta: Record<string, unknown>): NavBottomAddon | null {
    const label = sanitizeLabel(meta["label"])
    const to = sanitizeAddonLink(meta["to"])
    if (label === null || to === null) {
        return null
    }
    const id = sanitizeId(meta["id"], to)
    const addon: NavBottomAddon = { id, label, to, external: /^https?:\/\//i.test(to) }
    navBottomAddons.set(id, addon)
    while (navBottomAddons.size > MAX_NAV_BOTTOM_ADDONS) {
        const oldest = navBottomAddons.keys().next().value
        if (oldest === undefined) {
            break
        }
        navBottomAddons.delete(oldest)
    }
    notify()
    return addon
}

function handleRegisterAddon(event: EventEntity<WellspringWebAddon>): void {
    const data = event.getData()
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return
    }
    if (data.type !== "nav-bottom") {
        return
    }
    const meta = data.meta
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
        return
    }
    registerNavBottomAddon(meta as Record<string, unknown>)
}

const off = eventBus.subscribe<WellspringWebAddon>(ADDON_EVENT, (event) => {
    handleRegisterAddon(event)
})

onShutdown(() => {
    off()
    listeners.clear()
    navBottomAddons.clear()
})
