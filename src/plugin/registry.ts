/*
 * 插件命令注册表。
 * 内置命令保留，插件命令挂在顶级；重名拒绝，别名同样参与冲突检查。
 */

import type { PluginCommand } from "../api/host/plugin.ts"

/** 内置命令名，插件不可占用 */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
    "chat",
    "run",
    "session",
    "config",
    "plugin",
    "doctor",
    "version",
    "help",
])

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/

export interface RegisteredPluginCommand {
    readonly pluginName: string
    readonly command: PluginCommand
}

export class PluginRegistry {
    readonly #reserved: ReadonlySet<string>
    readonly #commands = new Map<string, RegisteredPluginCommand>()
    readonly #aliases = new Map<string, RegisteredPluginCommand>()
    readonly #pluginNames = new Set<string>()

    constructor(reserved: ReadonlySet<string> = RESERVED_COMMANDS) {
        this.#reserved = reserved
    }

    /** 注册插件命令；非法、保留名或重名时抛错 */
    register(pluginName: string, command: PluginCommand): void {
        if (
            !COMMAND_NAME.test(command.name) ||
            command.name.length < 2 ||
            command.name.length > 32
        ) {
            throw new Error(`插件命令名不合法：${command.name}`)
        }
        if (this.#reserved.has(command.name)) {
            throw new Error(`插件不能覆盖内置命令：${command.name}`)
        }
        if (this.#commands.has(command.name) || this.#aliases.has(command.name)) {
            throw new Error(`插件命令重名：${command.name}`)
        }
        if (typeof command.summary !== "string" || command.summary.trim() === "") {
            throw new Error(`插件命令缺少 summary：${command.name}`)
        }
        if (typeof command.run !== "function") {
            throw new Error(`插件命令缺少 run：${command.name}`)
        }

        const record: RegisteredPluginCommand = { pluginName, command }
        this.#commands.set(command.name, record)
        this.#pluginNames.add(pluginName)

        for (const alias of command.aliases ?? []) {
            if (!COMMAND_NAME.test(alias) || alias.length < 2 || alias.length > 32) {
                throw new Error(`插件命令别名不合法：${alias}`)
            }
            if (
                this.#reserved.has(alias) ||
                this.#commands.has(alias) ||
                this.#aliases.has(alias)
            ) {
                throw new Error(`插件命令别名冲突：${alias}`)
            }
            this.#aliases.set(alias, record)
        }
    }

    resolve(name: string): RegisteredPluginCommand | undefined {
        return this.#commands.get(name) ?? this.#aliases.get(name)
    }

    list(): readonly RegisteredPluginCommand[] {
        return [...this.#commands.values()]
    }

    removePlugin(pluginName: string): void {
        for (const [name, record] of this.#commands) {
            if (record.pluginName === pluginName) {
                this.#commands.delete(name)
            }
        }
        for (const [alias, record] of this.#aliases) {
            if (record.pluginName === pluginName) {
                this.#aliases.delete(alias)
            }
        }
        this.#pluginNames.delete(pluginName)
    }

    pluginNames(): readonly string[] {
        return [...this.#pluginNames]
    }
}
