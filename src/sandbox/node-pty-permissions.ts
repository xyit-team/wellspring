/*
 * node-pty 的 spawn-helper 执行位
 *
 * node-pty 1.1.0 的 prebuilds 里 spawn-helper 是 -rw-r--r--，缺执行位时 posix_spawnp 失败
 * import 阶段不报错，开终端时才失败
 * macOS 与 Linux 都受影响，与 Node 版本无关
 */

import { chmodSync, statSync } from "node:fs"
import { join } from "node:path"

export interface SpawnHelperOptions {
    /** node-pty 包根目录 */
    readonly moduleDir: string
    readonly platform: NodeJS.Platform
    readonly arch: string
    readonly chmod?: (file: string, mode: number) => void
    readonly stat?: (file: string) => { isFile(): boolean; mode: number }
}

export interface SpawnHelperResult {
    /** 补执行位成功时被修的文件 */
    readonly repaired: string | null
    /** 失败原因；null 表示无需处理或已修复 */
    readonly error: string | null
}

/** spawn-helper 的候选位置：prebuilds 优先，退回 node-gyp 的产物 */
export function spawnHelperCandidates(
    moduleDir: string,
    platform: NodeJS.Platform,
    arch: string,
): readonly string[] {
    return [
        join(moduleDir, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
        join(moduleDir, "build", "Release", "spawn-helper"),
    ]
}

/** 补齐执行位；Windows 不适用 */
export function ensureSpawnHelperExecutable(options: SpawnHelperOptions): SpawnHelperResult {
    if (options.platform === "win32") {
        return { repaired: null, error: null }
    }
    const stat = options.stat ?? statSync
    const chmod = options.chmod ?? chmodSync

    for (const file of spawnHelperCandidates(options.moduleDir, options.platform, options.arch)) {
        let info
        try {
            info = stat(file)
        } catch {
            continue
        }
        if (!info.isFile() || (info.mode & 0o111) !== 0) {
            continue
        }
        try {
            chmod(file, 0o755)
            return { repaired: file, error: null }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            return {
                repaired: null,
                error: `spawn-helper 缺少执行位且无法修复（${file}）：${reason}`,
            }
        }
    }
    return { repaired: null, error: null }
}
