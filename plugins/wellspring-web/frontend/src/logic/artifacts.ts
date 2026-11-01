/*
 * 从过程行里收集 Agent「提交」的文件（纯逻辑，便于单测）。
 *
 * write 的结果里带 path；execute_code / query_task 的结果里带 artifacts
 * （sandbox 收集到的产物，形如 { path, size, sha256 }）
 * 只认绝对路径：宿主按绝对路径打开文件
 */

import type { ProcessItem } from "../types.ts"

export interface SubmittedFile {
    readonly path: string
    readonly name: string
    readonly size: number | null
    /** write = 直接写文件；artifact = sandbox 产物目录里收集到的 */
    readonly source: "write" | "artifact"
}

const MAX_FILES = 12

/** POSIX、Windows 盘符与 UNC 都算绝对路径 */
function isAbsolutePath(value: string): boolean {
    return value.startsWith("/") || /^[A-Za-z]:[\/]/.test(value) || value.startsWith("\\")
}

function parseObject(raw: string | undefined): Record<string, unknown> | null {
    const text = (raw ?? "").trim()
    if (text === "" || (!text.startsWith("{") && !text.startsWith("["))) return null
    try {
        const parsed: unknown = JSON.parse(text)
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
    } catch {
        return null
    }
}

function fileNameOf(path: string): string {
    const parts = path.split(/[\\/]/).filter((part) => part !== "")
    return parts[parts.length - 1] ?? path
}

function pushFile(target: SubmittedFile[], path: string, size: unknown, source: SubmittedFile["source"]): void {
    if (path === "" || !isAbsolutePath(path)) return
    if (target.some((item) => item.path === path)) return
    const numeric = typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null
    target.push({ path, name: fileNameOf(path), size: numeric, source })
}

export function submittedFiles(process: readonly ProcessItem[]): SubmittedFile[] {
    const files: SubmittedFile[] = []
    for (const item of process) {
        if (item.kind !== "tool" || item.status === "running") continue
        const data = parseObject(item.result)
        if (data === null) continue
        if (item.name === "write") {
            if (typeof data["path"] === "string") pushFile(files, data["path"], data["bytes"], "write")
            continue
        }
        const artifacts = data["artifacts"]
        if (!Array.isArray(artifacts)) continue
        for (const artifact of artifacts) {
            if (typeof artifact !== "object" || artifact === null) continue
            const record = artifact as Record<string, unknown>
            if (typeof record["path"] !== "string") continue
            pushFile(files, record["path"], record["size"], "artifact")
        }
    }
    return files.slice(0, MAX_FILES)
}
