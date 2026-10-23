// 插件数据访问：依赖关系链上的插件可互访 data 目录

import type { HostFileApi } from "../api/host/fs.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import { createPluginFileApi } from "./fs.ts"
import { ensurePluginDataDir } from "./runtime.ts"

interface PluginNode {
    readonly id: string
    readonly deps: readonly string[]
}

export class PluginDataService {
    readonly #paths: ResolvedPaths
    readonly #edges = new Map<string, Set<string>>()

    constructor(paths: ResolvedPaths) {
        this.#paths = paths
    }

    /** 建立无向依赖图；A 依赖 B 后双方都可访问对方 data */
    setPlugins(plugins: readonly PluginNode[]): void {
        this.#edges.clear()
        for (const plugin of plugins) {
            this.#edges.set(plugin.id, this.#edges.get(plugin.id) ?? new Set())
            for (const dep of plugin.deps) {
                this.#link(plugin.id, dep)
                this.#link(dep, plugin.id)
            }
        }
    }

    #link(left: string, right: string): void {
        const set = this.#edges.get(left) ?? new Set<string>()
        set.add(right)
        this.#edges.set(left, set)
    }

    canAccess(from: string, to: string): boolean {
        if (from === to) {
            return true
        }
        const seen = new Set<string>([from])
        const queue = [from]
        while (queue.length > 0) {
            const current = queue.shift()
            if (current === undefined) {
                break
            }
            for (const next of this.#edges.get(current) ?? []) {
                if (next === to) {
                    return true
                }
                if (!seen.has(next)) {
                    seen.add(next)
                    queue.push(next)
                }
            }
        }
        return false
    }

    async open(from: string, to: string): Promise<HostFileApi | null> {
        if (!this.canAccess(from, to)) {
            return null
        }
        const root = await ensurePluginDataDir(to, this.#paths)
        return createPluginFileApi(root)
    }
}
