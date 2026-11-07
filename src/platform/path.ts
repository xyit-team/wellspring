/*
 * 目录解析
 *
 * 根目录：config（配置与凭据）、data（持久数据）、cache（可再生成）、log（日志）
 * 优先级：initPaths 显式覆盖 > WELLSPRING_*_DIR > WELLSPRING_HOME 便携模式 > 平台默认
 * 仅解析路径，不创建目录；创建见 file.ts 的 ensureDirs
 */

import { isAbsolute, join, normalize } from "node:path"

import { homeDir, platform, readEnv, type PlatformName } from "./os.ts"

/** 各平台统一使用的目录名 */
export const APP_DIR_NAME = "wellspring"

/** 四个根目录 */
export interface PathRoots {
    readonly configDir: string
    readonly dataDir: string
    readonly cacheDir: string
    readonly logDir: string
}

/** 显式覆盖，通常来自 CLI 参数；相对路径按当前工作目录解析 */
export interface PathOverrides {
    readonly configDir?: string
    readonly dataDir?: string
    readonly cacheDir?: string
    readonly logDir?: string
}

/** 取值来源，用于诊断 */
export type PathSource = "override" | "env" | "portable-home" | "os-default"

export interface ResolvedPaths extends PathRoots {
    readonly sources: Readonly<Record<keyof PathRoots, PathSource>>
}

const ROOT_KEYS = ["configDir", "dataDir", "cacheDir", "logDir"] as const
type RootKey = (typeof ROOT_KEYS)[number]

const ENV_NAMES: Readonly<Record<RootKey, string>> = {
    configDir: "WELLSPRING_CONFIG_DIR",
    dataDir: "WELLSPRING_DATA_DIR",
    cacheDir: "WELLSPRING_CACHE_DIR",
    logDir: "WELLSPRING_LOG_DIR",
}

const ROOT_LABELS: Readonly<Record<RootKey, string>> = {
    configDir: "config",
    dataDir: "data",
    cacheDir: "cache",
    logDir: "log",
}

// 是否 Termux 用户态：目录沿用 XDG，HOME 可用
function isTermuxEnv(env: NodeJS.ProcessEnv): boolean {
    return (
        readEnv("TERMUX_VERSION", env) !== undefined ||
        (readEnv("PREFIX", env)?.includes("com.termux") ?? false)
    )
}

function xdgRoots(env: NodeJS.ProcessEnv, home: string): PathRoots {
    return {
        configDir: join(readEnv("XDG_CONFIG_HOME", env) ?? join(home, ".config"), APP_DIR_NAME),
        dataDir: join(readEnv("XDG_DATA_HOME", env) ?? join(home, ".local", "share"), APP_DIR_NAME),
        cacheDir: join(readEnv("XDG_CACHE_HOME", env) ?? join(home, ".cache"), APP_DIR_NAME),
        logDir: join(
            readEnv("XDG_STATE_HOME", env) ?? join(home, ".local", "state"),
            APP_DIR_NAME,
            "logs",
        ),
    }
}

/*
 * Android 应用沙箱：HOME 通常指向应用私有 files 目录
 * 未设置 HOME 时依赖 WELLSPRING_HOME；两者皆无则使用系统用户目录
 */
function androidAppRoots(env: NodeJS.ProcessEnv, home: string): PathRoots {
    const base = readEnv("HOME", env) ?? home
    return {
        configDir: join(base, "config"),
        dataDir: join(base, "data"),
        cacheDir: join(base, "cache"),
        logDir: join(base, "logs"),
    }
}

/** 平台默认根目录；参数可注入，供测试覆盖各平台 */
export function defaultRoots(
    platformName: PlatformName,
    env: NodeJS.ProcessEnv,
    home: string,
): PathRoots {
    switch (platformName) {
        case "windows": {
            const roaming = readEnv("APPDATA", env) ?? join(home, "AppData", "Roaming")
            const local = readEnv("LOCALAPPDATA", env) ?? join(home, "AppData", "Local")
            return {
                configDir: join(roaming, APP_DIR_NAME),
                dataDir: join(local, APP_DIR_NAME),
                // Windows 无独立缓存目录约定，缓存与日志置于 data 下
                cacheDir: join(local, APP_DIR_NAME, "cache"),
                logDir: join(local, APP_DIR_NAME, "logs"),
            }
        }
        case "macos": {
            // macOS 惯例：配置与数据同放 Application Support，缓存与日志各自独立
            const support = join(home, "Library", "Application Support", APP_DIR_NAME)
            return {
                configDir: support,
                dataDir: support,
                cacheDir: join(home, "Library", "Caches", APP_DIR_NAME),
                logDir: join(home, "Library", "Logs", APP_DIR_NAME),
            }
        }
        case "android":
            return isTermuxEnv(env) ? xdgRoots(env, home) : androidAppRoots(env, home)
        default:
            return xdgRoots(env, home)
    }
}

// 便携模式：所有数据落在同一个根下
function portableRoots(home: string): PathRoots {
    return {
        configDir: join(home, "config"),
        dataDir: join(home, "data"),
        cacheDir: join(home, "cache"),
        logDir: join(home, "logs"),
    }
}

function expandTilde(input: string, env: NodeJS.ProcessEnv): string {
    if (input === "~") {
        return homeDir(env)
    }
    if (input.startsWith("~/") || input.startsWith("~\\")) {
        return join(homeDir(env), input.slice(2))
    }
    return input
}

function toAbsolute(input: string, env: NodeJS.ProcessEnv): string {
    const expanded = expandTilde(input, env)
    return normalize(isAbsolute(expanded) ? expanded : join(process.cwd(), expanded))
}

let cached: ResolvedPaths | null = null

/** 解析并缓存；重复调用会按最新参数与环境变量重新解析 */
export function initPaths(
    overrides: PathOverrides = {},
    env: NodeJS.ProcessEnv = process.env,
): ResolvedPaths {
    const home = homeDir(env)
    const portableHome = readEnv("WELLSPRING_HOME", env)
    const defaults =
        portableHome === undefined
            ? defaultRoots(platform, env, home)
            : portableRoots(toAbsolute(portableHome, env))
    const baseSource: PathSource = portableHome === undefined ? "os-default" : "portable-home"

    const roots: Record<RootKey, string> = {
        configDir: "",
        dataDir: "",
        cacheDir: "",
        logDir: "",
    }
    const sources: Record<RootKey, PathSource> = {
        configDir: baseSource,
        dataDir: baseSource,
        cacheDir: baseSource,
        logDir: baseSource,
    }

    for (const key of ROOT_KEYS) {
        const override = overrides[key]
        if (override !== undefined && override.trim() !== "") {
            roots[key] = toAbsolute(override, env)
            sources[key] = "override"
            continue
        }
        const fromEnv = readEnv(ENV_NAMES[key], env)
        if (fromEnv !== undefined) {
            roots[key] = toAbsolute(fromEnv, env)
            sources[key] = "env"
            continue
        }
        roots[key] = defaults[key]
    }

    const resolved: ResolvedPaths = { ...roots, sources }
    cached = resolved
    return resolved
}

/** 取缓存结果，未解析时先解析一次 */
export function getPaths(): ResolvedPaths {
    return cached ?? initPaths()
}

/** 清空缓存，供测试使用；下次 getPaths 重新读取环境变量 */
export function resetPaths(): void {
    cached = null
}

/** 打印四个根目录及其来源，用于诊断 */
export function describePaths(roots: ResolvedPaths = getPaths()): string {
    return ROOT_KEYS.map(
        (key) => `${ROOT_LABELS[key].padEnd(7)} ${roots[key]}  (${roots.sources[key]})`,
    ).join("\n")
}
