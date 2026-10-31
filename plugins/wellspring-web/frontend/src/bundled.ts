/*
 * 内置 Web 扩展：构建期扫描 plugins/wellspring-web/plugins/*.vue 并打包。
 * 扩展可以通过命名导出修改主界面：
 *   export const meta  = { name, mode: "panel" | "page" }
 *   export const slots = { "sidebar.footer": Component, ... }
 */

import type { Component } from "vue"

export interface ExtensionMeta {
    readonly name?: string
    readonly mode?: "panel" | "page"
}

export interface ExtensionModule {
    readonly default?: Component
    readonly meta?: ExtensionMeta
    readonly slots?: Record<string, Component>
}

const modules = import.meta.glob("../../plugins/*.vue", { eager: true }) as Record<
    string,
    ExtensionModule
>

export interface BundledExtension {
    readonly id: string
    readonly name: string
    readonly module: ExtensionModule
    readonly component: Component
}

function slugOf(name: string): string {
    return name
        .toLowerCase()
        .replace(/\.vue$/, "")
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
}

export const bundledExtensions: BundledExtension[] = Object.entries(modules).map(
    ([path, module]) => {
        const name = (path.split("/").pop() ?? "extension").replace(/\.vue$/, "")
        return {
            id: `bundled-${slugOf(name)}`,
            name: module.meta?.name ?? name,
            module,
            component: module.default as Component,
        }
    },
)
