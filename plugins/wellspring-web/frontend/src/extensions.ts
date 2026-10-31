/*
 * Web 扩展：网页里安装/卸载 .vue 扩展，并把编译后的模块挂载成面板。
 * 扩展代码以页面权限运行（可调用同源 API），只安装可信来源。
 */

import type { Component } from "vue"
import { reactive } from "vue"

import { apiJson } from "./api"
import { bundledExtensions, type ExtensionMeta, type ExtensionModule } from "./bundled"
import { toast } from "./store"

export interface WebExtension {
    id: string
    name: string
    source: "bundled" | "installed"
    size: number
    createdAt: number | null
    moduleUrl: string
    styleUrl: string | null
}

export const extensionState = reactive({
    items: [] as WebExtension[],
    loading: false,
    installing: false,
    /** 被网页「删除」的内置扩展（文件仍在 plugins 目录，仅隐藏） */
    hiddenBundled: [] as string[],
    /** 已加载扩展模块的版本号：Map 本身不是响应式，用它通知插槽重算 */
    modulesVersion: 0,
})

/** 已加载扩展模块（bundled + installed），用于读取 meta / slots / 页面组件 */
const installedModules = new Map<string, ExtensionModule>()

export function extensionModule(id: string): ExtensionModule | null {
    for (const item of bundledExtensions) {
        if (item.id === id) return item.module
    }
    return installedModules.get(id) ?? null
}

export function extensionMeta(item: WebExtension | null): ExtensionMeta {
    if (item === null) return {}
    return extensionModule(item.id)?.meta ?? {}
}

export function isPageExtension(item: WebExtension): boolean {
    return extensionMeta(item).mode === "page"
}

/** 某个挂载点要渲染的扩展组件（内置 + 网页安装） */
export function slotComponents(name: string): Component[] {
    void extensionState.modulesVersion
    const result: Component[] = []
    for (const item of bundledExtensions) {
        if (extensionState.hiddenBundled.includes(item.id)) continue
        const component = item.module.slots?.[name]
        if (component !== undefined) result.push(component)
    }
    for (const [id, module] of installedModules) {
        const item = extensionState.items.find((entry) => entry.id === id)
        if (item === undefined) continue
        const component = module.slots?.[name]
        if (component !== undefined) result.push(component)
    }
    return result
}

async function loadInstalledModules(): Promise<void> {
    installedModules.clear()
    extensionState.modulesVersion += 1
    await Promise.all(
        extensionState.items.map(async (item) => {
            try {
                const module = (await import(/* @vite-ignore */ item.moduleUrl)) as ExtensionModule
                installedModules.set(item.id, module)
            } catch {
                /* 单个扩展加载失败不影响主页 */
            }
        }),
    )
    extensionState.modulesVersion += 1
}

export function extensionList(): WebExtension[] {
    void extensionState.modulesVersion
    return [
        ...bundledExtensions
            .filter((item) => !extensionState.hiddenBundled.includes(item.id))
            .map((item) => ({
            id: item.id,
            name: item.name,
                source: "bundled" as const,
                size: 0,
                createdAt: null,
                moduleUrl: "",
                styleUrl: null,
            })),
        ...extensionState.items.map((item) => {
            const meta = extensionMeta(item)
            return meta.name === undefined ? item : { ...item, name: meta.name }
        }),
    ]
}

/** 被隐藏的内置扩展（用于弹窗里的「恢复」区） */
export function hiddenBuiltinList(): Array<{ id: string; name: string }> {
    return bundledExtensions
        .filter((item) => extensionState.hiddenBundled.includes(item.id))
        .map((item) => ({ id: item.id, name: item.name }))
}

export async function loadExtensions(): Promise<void> {
    extensionState.loading = true
    try {
        const data = await apiJson<{
            extensions: WebExtension[]
            hiddenBundled: string[]
        }>("/api/extensions")
        extensionState.items = Array.isArray(data.extensions) ? data.extensions : []
        extensionState.hiddenBundled = Array.isArray(data.hiddenBundled) ? data.hiddenBundled : []
        await loadInstalledModules()
    } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
        extensionState.loading = false
    }
}

function readBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error("读取文件失败"))
        reader.onload = () => {
            const text = String(reader.result ?? "")
            const index = text.indexOf(",")
            resolve(index === -1 ? text : text.slice(index + 1))
        }
        reader.readAsDataURL(file)
    })
}

export async function installExtensionFile(
    file: File,
): Promise<{ ok: boolean; error?: string }> {
    if (!/\.vue$/i.test(file.name)) {
        return { ok: false, error: "只支持 .vue 单文件组件" }
    }
    if (file.size > 512 * 1024) {
        return { ok: false, error: "扩展文件不能超过 512KB" }
    }
    extensionState.installing = true
    try {
        const dataBase64 = await readBase64(file)
        const result = await apiJson<{ extensions: WebExtension[] }>(
            "/api/extensions/install",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ filename: file.name, dataBase64 }),
            },
        )
        extensionState.items = Array.isArray(result.extensions) ? result.extensions : []
        await loadInstalledModules()
        toast(`已安装扩展 ${file.name.replace(/\.vue$/i, "")}`)
        return { ok: true }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast(message, "error")
        return { ok: false, error: message }
    } finally {
        extensionState.installing = false
    }
}

export async function setBuiltinVisible(id: string, visible: boolean): Promise<void> {
    try {
        const result = await apiJson<{ hiddenBundled: string[] }>(
            visible ? "/api/extensions/show" : "/api/extensions/hide",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id }),
            },
        )
        extensionState.hiddenBundled = Array.isArray(result.hiddenBundled)
            ? result.hiddenBundled
            : []
        toast(visible ? "已恢复内置扩展" : "已删除内置扩展（文件仍在 plugins 目录）")
    } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}

export async function removeExtension(item: WebExtension): Promise<void> {
    if (item.source === "bundled") {
        await setBuiltinVisible(item.id, false)
        return
    }
    try {
        const result = await apiJson<{ extensions: WebExtension[]; hiddenBundled: string[] }>(
            `/api/extensions/${encodeURIComponent(item.id)}`,
            {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: "{}",
            },
        )
        extensionState.items = Array.isArray(result.extensions) ? result.extensions : []
        extensionState.hiddenBundled = Array.isArray(result.hiddenBundled)
            ? result.hiddenBundled
            : []
        await loadInstalledModules()
        toast(`已删除扩展 ${item.name}`)
    } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error")
    }
}
