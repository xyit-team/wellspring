/*
 * 平台识别
 *
 * 本模块是唯一读取 process.platform 的位置
 */

import { homedir } from "node:os"

/** 业务侧平台名，不使用 Node 的 win32 / darwin / linux 原始值 */
export type PlatformName = "windows" | "macos" | "linux" | "android"

// Termux 等 Android 用户态 Node 报告 linux，用 Android 环境变量识别
function isAndroidEnv(env: NodeJS.ProcessEnv): boolean {
    const has = (name: string): boolean => {
        const value = env[name]
        return value !== undefined && value.trim() !== ""
    }
    return has("ANDROID_ROOT") || has("ANDROID_DATA") || has("TERMUX_VERSION")
}

/** 平台归一化；参数可注入，供测试覆盖各平台 */
export function detectPlatform(
    nodePlatform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): PlatformName {
    switch (nodePlatform) {
        case "win32":
            return "windows"
        case "darwin":
            return "macos"
        case "android":
            return "android"
        default:
            return isAndroidEnv(env) ? "android" : "linux"
    }
}

export const platform: PlatformName = detectPlatform()
export const isWindows: boolean = platform === "windows"
export const isMacOS: boolean = platform === "macos"
export const isLinux: boolean = platform === "linux"
export const isAndroid: boolean = platform === "android"
/** POSIX 权限与路径语义可用的平台，含 Android */
export const isPosix: boolean = platform !== "windows"

function detectWsl(): boolean {
    if (platform !== "linux") {
        return false
    }
    // WSL 会注入 WSL_DISTRO_NAME / WSL_INTEROP，该环境下调用外部程序的行为与原生 Linux 不同
    return process.env["WSL_DISTRO_NAME"] !== undefined || process.env["WSL_INTEROP"] !== undefined
}

export const isWsl: boolean = detectWsl()

/** Android 上的 Termux 用户态 */
export const isTermux: boolean =
    isAndroid &&
    (readEnv("TERMUX_VERSION") !== undefined ||
        (readEnv("PREFIX")?.includes("com.termux") ?? false))

/** 读取环境变量，空串按未设置处理；Windows 下变量名大小写不敏感 */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const direct = env[name]
    if (direct !== undefined) {
        const value = direct.trim()
        return value === "" ? undefined : value
    }
    if (!isWindows) {
        return undefined
    }
    const lower = name.toLowerCase()
    const key = Object.keys(env).find((item) => item.toLowerCase() === lower)
    const value = key === undefined ? undefined : env[key]?.trim()
    return value === undefined || value === "" ? undefined : value
}

/** HOME 优先，其次 USERPROFILE 与系统用户目录；Android 沙箱可能三者皆无 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = readEnv("HOME", env) ?? readEnv("USERPROFILE", env)
    if (fromEnv !== undefined) {
        return fromEnv
    }
    try {
        const home = homedir()
        if (home !== "") {
            return home
        }
    } catch {
        // 无 passwd 条目时回落
    }
    return process.cwd()
}

/** Windows 可执行文件带 .exe 后缀 */
export function executableName(name: string): string {
    if (!isWindows || name.toLowerCase().endsWith(".exe")) {
        return name
    }
    return `${name}.exe`
}
