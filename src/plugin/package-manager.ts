// 插件依赖安装：插件 package.json 的 packageManager 字段声明包管理器

// 只认白名单命令（npm / pnpm / yarn / bun），字段不会变成任意命令执行
// 版本号只作声明；实际执行 PATH 里的同名命令，不安装新版本，不走 corepack

import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"

export type PluginPackageManagerName = "npm" | "pnpm" | "yarn" | "bun"

export interface PluginPackageManager {
    readonly name: PluginPackageManagerName
    readonly version: string | null
}

export interface PluginPackageJsonLike {
    readonly packageManager?: unknown
    readonly dependencies?: Record<string, unknown> | null
    readonly optionalDependencies?: Record<string, unknown> | null
}

export interface PluginDependencyInstallResult {
    readonly manager: PluginPackageManager | null
    readonly installed: boolean
    readonly reason: string | null
}

interface ManagerCommand {
    readonly binary: string
    readonly args: readonly string[]
}

const MANAGERS: ReadonlyMap<PluginPackageManagerName, ManagerCommand> = new Map([
    ["npm", { binary: "npm", args: ["install", "--no-audit", "--no-fund", "--omit=dev"] }],
    ["pnpm", { binary: "pnpm", args: ["install", "--prod"] }],
    ["yarn", { binary: "yarn", args: ["install", "--production"] }],
    ["bun", { binary: "bun", args: ["install", "--production"] }],
])

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_OUTPUT_CHARS = 4000

function isManagerName(value: string): value is PluginPackageManagerName {
    return MANAGERS.has(value as PluginPackageManagerName)
}

/** 解析 "npm@11.20.0" / "pnpm" 这类声明；不合法返回 null */
export function parsePackageManager(value: unknown): PluginPackageManager | null {
    if (typeof value !== "string") {
        return null
    }
    const trimmed = value.trim()
    const match = /^([A-Za-z][A-Za-z0-9-]*)(?:@(.+))?$/.exec(trimmed)
    if (match === null) {
        return null
    }
    const name = (match[1] ?? "").toLowerCase()
    if (!isManagerName(name)) {
        return null
    }
    const version = match[2] ?? null
    // 允许 corepack 常见的 "pnpm@10.0.0+sha512..." 形式
    if (version !== null && !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
        return null
    }
    return { name, version }
}

/** 没声明 packageManager 时按 lockfile 推断，兼容旧插件 */
export function lockfilePackageManager(files: readonly string[]): PluginPackageManager | null {
    if (files.includes("pnpm-lock.yaml")) {
        return { name: "pnpm", version: null }
    }
    if (files.includes("yarn.lock")) {
        return { name: "yarn", version: null }
    }
    if (files.includes("bun.lockb") || files.includes("bun.lock")) {
        return { name: "bun", version: null }
    }
    if (files.includes("package-lock.json")) {
        return { name: "npm", version: null }
    }
    return null
}

export function hasPluginDependencies(pkg: PluginPackageJsonLike): boolean {
    return (
        Object.keys(pkg.dependencies ?? {}).length > 0 ||
        Object.keys(pkg.optionalDependencies ?? {}).length > 0
    )
}

/** 实际执行的命令；Windows 下 .cmd 需要 shell */
export function pluginInstallCommand(manager: PluginPackageManager): {
    readonly command: string
    readonly args: readonly string[]
} {
    const spec = MANAGERS.get(manager.name)
    if (spec === undefined) {
        throw new Error(`不支持的包管理器：${manager.name}`)
    }
    const command = process.platform === "win32" ? `${spec.binary}.cmd` : spec.binary
    return { command, args: spec.args }
}

export interface RunPackageInstallOptions {
    readonly timeoutMs?: number
}

/** 在插件目录里执行包管理器安装；失败时抛出带输出尾部的错误 */
export async function runPackageInstall(
    directory: string,
    manager: PluginPackageManager,
    options: RunPackageInstallOptions = {},
): Promise<void> {
    const { command, args } = pluginInstallCommand(manager)
    const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
    await new Promise<void>((resolvePromise, rejectPromise) => {
        let output = ""
        let settled = false
        const append = (chunk: Buffer): void => {
            if (output.length >= MAX_OUTPUT_CHARS) {
                return
            }
            output += chunk.toString("utf8")
        }
        const child = spawn(command, [...args], {
            cwd: directory,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            // Windows 的 npm.cmd / pnpm.cmd 必须经 shell 才能启动；args 都是固定白名单
            shell: process.platform === "win32",
        })
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            child.kill("SIGKILL")
            rejectPromise(
                new Error(`${manager.name} 安装依赖超时（${Math.round(timeoutMs / 1000)}s）`),
            )
        }, timeoutMs)
        child.stdout?.on("data", append)
        child.stderr?.on("data", append)
        child.once("error", (error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            rejectPromise(new Error(`无法运行 ${manager.name}：${error.message}`))
        })
        child.once("close", (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (code === 0) {
                resolvePromise()
                return
            }
            const tail = output.trim().slice(-MAX_OUTPUT_CHARS)
            rejectPromise(
                new Error(
                    `${manager.name} 安装依赖失败（退出码 ${String(code)}）` +
                        (tail === "" ? "" : `：${tail}`),
                ),
            )
        })
    })
}

export interface InstallPluginDependenciesOptions {
    /** 插件目录里的文件名；默认读目录，用于 lockfile 推断 */
    readonly files?: readonly string[]
    /** 测试注入；默认 runPackageInstall */
    readonly run?: typeof runPackageInstall
    readonly timeoutMs?: number
}

/**
 * 安装插件依赖
 *
 * 没有 dependencies / optionalDependencies：直接跳过
 * 有依赖但没有 packageManager：先用 lockfile 推断
 * 推断不出时报错，不默认使用 npm
 */
export async function installPluginDependencies(
    directory: string,
    pkg: PluginPackageJsonLike,
    options: InstallPluginDependenciesOptions = {},
): Promise<PluginDependencyInstallResult> {
    if (!hasPluginDependencies(pkg)) {
        return { manager: null, installed: false, reason: null }
    }
    const declared = parsePackageManager(pkg.packageManager)
    if (declared === null && pkg.packageManager !== undefined) {
        throw new Error(
            'package.json 的 packageManager 不合法，支持 "npm@11"、"pnpm@10"、"yarn@1"、"bun@1"',
        )
    }
    const files = options.files ?? (await readdir(directory).catch(() => []))
    const manager = declared ?? lockfilePackageManager(files)
    if (manager === null) {
        throw new Error(
            '插件声明了 dependencies，但 package.json 缺少 packageManager（例如 "npm@11.20.0"）',
        )
    }
    const run = options.run ?? runPackageInstall
    await run(directory, manager, { timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS })
    return { manager, installed: true, reason: null }
}

export function packageManagerLabel(manager: PluginPackageManager): string {
    return manager.version === null ? manager.name : `${manager.name}@${manager.version}`
}
