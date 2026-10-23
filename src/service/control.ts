/*
 * 服务进程控制：pid 文件 + 跨进程停止。
 * 只有 wellspring start 会写服务记录；wellspring stop 读取后发送 SIGTERM。
 */

import { join } from "node:path"

import { readJsonIfExists, removePath, statIfExists, writeJsonAtomic } from "../platform/file.ts"
import { getPaths, type ResolvedPaths } from "../platform/path.ts"

export interface ServiceRecord {
    readonly version: 1
    readonly pid: number
    readonly startedAt: string
    readonly cwd: string
}

export class ServiceNotRunningError extends Error {
    constructor() {
        super("没有正在运行的 Wellspring 服务")
        this.name = "ServiceNotRunningError"
    }
}

export class ServiceAlreadyRunningError extends Error {
    readonly pid: number

    constructor(pid: number) {
        super(`Wellspring 服务已在运行（pid ${pid}）`)
        this.name = "ServiceAlreadyRunningError"
        this.pid = pid
    }
}

export class ServiceStopTimeoutError extends Error {
    readonly pid: number

    constructor(pid: number) {
        super(`等待服务退出超时（pid ${pid}）`)
        this.name = "ServiceStopTimeoutError"
        this.pid = pid
    }
}

export function serviceRecordFile(paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, "service.json")
}

export async function readServiceRecord(
    paths: ResolvedPaths = getPaths(),
): Promise<ServiceRecord | null> {
    const value = await readJsonIfExists<Partial<ServiceRecord>>(serviceRecordFile(paths))
    if (
        value === null ||
        typeof value.pid !== "number" ||
        !Number.isInteger(value.pid) ||
        value.pid <= 0
    ) {
        return null
    }
    return {
        version: 1,
        pid: value.pid,
        startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
        cwd: typeof value.cwd === "string" ? value.cwd : "",
    }
}

export async function writeServiceRecord(
    record: Omit<ServiceRecord, "version">,
    paths: ResolvedPaths = getPaths(),
): Promise<void> {
    await writeJsonAtomic(serviceRecordFile(paths), { version: 1, ...record })
}

/** 只清理属于指定 pid 的记录，避免误删后来的服务 */
export async function clearServiceRecord(
    pid: number,
    paths: ResolvedPaths = getPaths(),
): Promise<void> {
    const current = await readServiceRecord(paths)
    if (current !== null && current.pid !== pid) {
        return
    }
    await removePath(serviceRecordFile(paths))
}

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            return false
        }
        return true
    }
}

export interface StopServiceOptions {
    readonly timeoutMs?: number
    readonly pollMs?: number
}

/** 停止当前服务：SIGTERM → 轮询等待退出 → 清理 pid 文件 */
export async function stopService(
    paths: ResolvedPaths = getPaths(),
    options: StopServiceOptions = {},
): Promise<number> {
    const record = await readServiceRecord(paths)
    if (record === null) {
        throw new ServiceNotRunningError()
    }
    if (!isProcessAlive(record.pid)) {
        await clearServiceRecord(record.pid, paths)
        throw new ServiceNotRunningError()
    }

    try {
        process.kill(record.pid, "SIGTERM")
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            await clearServiceRecord(record.pid, paths)
            throw new ServiceNotRunningError()
        }
        throw error
    }

    const timeoutMs = options.timeoutMs ?? 5_000
    const pollMs = options.pollMs ?? 100
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        if (!isProcessAlive(record.pid)) {
            await clearServiceRecord(record.pid, paths)
            return record.pid
        }
    }
    throw new ServiceStopTimeoutError(record.pid)
}

/** start 前检查：已有存活服务则报错，残留记录直接清掉 */
export async function assertServiceStartable(paths: ResolvedPaths = getPaths()): Promise<void> {
    const record = await readServiceRecord(paths)
    if (record === null) {
        return
    }
    if (isProcessAlive(record.pid)) {
        throw new ServiceAlreadyRunningError(record.pid)
    }
    const shown = await statIfExists(serviceRecordFile(paths))
    if (shown !== null) {
        await clearServiceRecord(record.pid, paths)
    }
}
