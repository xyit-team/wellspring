/*
 * 用系统默认程序打开 URL 或本地路径。
 * target 可能来自外部输入，须校验：以 "-" 开头会被 open / cmd start 视为参数，协议限定白名单。
 */

import { spawn } from "node:child_process"
import { dirname, isAbsolute } from "node:path"

import { describeError } from "./exec.ts"
import { isTermux, isWsl, platform, type PlatformName } from "./os.ts"

/** 候选启动命令 */
export interface OpenCommand {
    readonly command: string
    readonly args: readonly string[]
}

/** 允许的协议 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"])

interface NormalizedTarget {
    readonly target: string
    readonly isUrl: boolean
}

/** 绝对路径原样返回；其余须为白名单协议 URL。不合法时抛出异常 */
function normalizeTarget(input: string): NormalizedTarget {
    const target = input.trim()
    if (target === "") {
        throw new Error("打开目标为空值")
    }
    // 控制字符（含换行）会破坏命令行语义
    if (/[\u0000-\u001f\u007f]/.test(target)) {
        throw new Error("打开目标包含控制字符")
    }
    if (target.startsWith("-")) {
        throw new Error(`打开目标不能以 "-" 开头：${target}`)
    }
    // 本地路径；Windows 的 "C:\\..." 亦归此类
    if (isAbsolute(target)) {
        return { target, isUrl: false }
    }

    let parsed: URL
    try {
        parsed = new URL(target)
    } catch {
        throw new Error(`目标既非绝对路径也非合法 URL：${target}`)
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`不允许的协议：${parsed.protocol}`)
    }
    return { target: parsed.href, isUrl: true }
}

/** 生成候选命令，按优先级排列。单独导出以便在任意平台测试各系统的构造结果 */
export function buildOpenCommands(
    rawTarget: string,
    targetPlatform: PlatformName = platform,
    inWsl: boolean = isWsl,
    inTermux: boolean = isTermux,
): OpenCommand[] {
    const { target, isUrl } = normalizeTarget(rawTarget)

    if (targetPlatform === "windows") {
        // 第二个参数为 start 的窗口标题占位；缺失时带引号的路径会被当作标题
        return [{ command: "cmd", args: ["/c", "start", "", target] }]
    }

    if (targetPlatform === "macos") {
        return [{ command: "open", args: [target] }]
    }

    if (targetPlatform === "android") {
        const candidates: OpenCommand[] = []
        if (inTermux) {
            candidates.push({ command: "termux-open", args: [target] })
        }
        candidates.push({ command: "xdg-open", args: [target] })
        // am 只能打开 URI，本地路径没有对应的 content:// 地址
        if (isUrl) {
            candidates.push({
                command: "am",
                args: ["start", "-a", "android.intent.action.VIEW", "-d", target],
            })
        }
        return candidates
    }

    const candidates: OpenCommand[] = []
    if (inWsl) {
        // WSL 下 xdg-open 常无效，优先 wslview（wslu），其次 explorer.exe
        candidates.push({ command: "wslview", args: [target] })
        candidates.push({ command: "explorer.exe", args: [target] })
    }
    candidates.push({ command: "xdg-open", args: [target] })
    candidates.push({ command: "gio", args: ["open", target] })
    return candidates
}

/**
 * 在文件管理器里定位路径的候选命令
 *
 * 目录各系统都能直接打开；文件走文件管理器的选中能力
 */
export function buildRevealCommands(
    rawTarget: string,
    targetPlatform: PlatformName = platform,
    inWsl: boolean = isWsl,
): OpenCommand[] {
    const { target, isUrl } = normalizeTarget(rawTarget)
    if (isUrl) {
        throw new Error(`reveal 只接受本地路径：${target}`)
    }

    if (targetPlatform === "windows" || inWsl) {
        return [{ command: "explorer.exe", args: [`/select,${target}`] }]
    }

    if (targetPlatform === "macos") {
        return [{ command: "open", args: ["-R", target] }]
    }

    // Linux / Android 的文件管理器没有统一的选中入口，退化为打开所在目录
    const parent = dirname(target)
    if (targetPlatform === "android") {
        return [{ command: "xdg-open", args: [parent] }]
    }
    return [
        { command: "xdg-open", args: [parent] },
        { command: "gio", args: ["open", parent] },
    ]
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        })
        child.once("error", reject)
        child.once("spawn", () => {
            // 不等待退出：浏览器与文件管理器均为长驻进程
            child.unref()
            resolve()
        })
    })
}

/** 依次尝试候选命令，全部失败时抛出聚合错误 */
export async function openExternal(rawTarget: string): Promise<void> {
    const { target } = normalizeTarget(rawTarget)
    await runCandidates(target, buildOpenCommands(target))
}

// 在文件管理器里定位路径；文件管理器都是长驻进程，不等退出
export async function revealExternal(rawTarget: string): Promise<void> {
    const { target } = normalizeTarget(rawTarget)
    await runCandidates(target, buildRevealCommands(target))
}

async function runCandidates(target: string, candidates: readonly OpenCommand[]): Promise<void> {
    const failures: string[] = []

    for (const candidate of candidates) {
        try {
            await spawnDetached(candidate.command, candidate.args)
            return
        } catch (error) {
            failures.push(`${candidate.command}: ${describeError(error)}`)
        }
    }

    throw new Error(`无法打开 ${target}：已尝试 ${failures.join("；")}`)
}
