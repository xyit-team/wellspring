// 后台 execute_code 任务注册表

import type { AgentCodeResult, AgentCodeTaskHandle, StopMode } from "../sandbox/types.ts"

export interface AgentTaskInfo {
    readonly taskId: string
    readonly sandboxId: string
    readonly status: "running" | "completed" | "failed" | "cancelled"
    readonly startedAt: number
    readonly stdout: string
    readonly stderr: string
    readonly result: AgentCodeResult | null
    readonly error: string | null
}

interface TaskRecord {
    readonly taskId: string
    readonly handle: AgentCodeTaskHandle
    readonly startedAt: number
    status: "running" | "completed" | "failed" | "cancelled"
    cancelled: boolean
    result: AgentCodeResult | null
    error: string | null
}

const tasks = new Map<string, TaskRecord>()
const order: string[] = []

export function registerBackgroundTask(handle: AgentCodeTaskHandle): AgentTaskInfo {
    const taskId = handle.sandboxId
    const record: TaskRecord = {
        taskId,
        handle,
        startedAt: Date.now(),
        status: "running",
        cancelled: false,
        result: null,
        error: null,
    }
    tasks.set(taskId, record)
    order.push(taskId)
    while (order.length > 50) {
        const oldest = order.shift()
        if (oldest !== undefined) {
            tasks.delete(oldest)
        }
    }
    void handle
        .wait()
        .then((result) => {
            record.status = record.cancelled ? "cancelled" : "completed"
            record.result = result
        })
        .catch((error: unknown) => {
            record.status = "failed"
            record.error = error instanceof Error ? error.message : String(error)
        })
    return infoOf(record)
}

function infoOf(record: TaskRecord): AgentTaskInfo {
    return {
        taskId: record.taskId,
        sandboxId: record.handle.sandboxId,
        status:
            record.status === "completed" &&
            (record.result?.signal === "SIGINT" || record.result?.signal === "SIGKILL")
                ? "cancelled"
                : record.status,
        startedAt: record.startedAt,
        stdout: record.result?.stdout ?? record.handle.stdout,
        stderr: record.result?.stderr ?? record.handle.stderr,
        result: record.result,
        error: record.error,
    }
}

export function queryTask(taskId?: string): AgentTaskInfo | null {
    if (taskId !== undefined && taskId !== "") {
        const record = tasks.get(taskId)
        return record === undefined ? null : infoOf(record)
    }
    for (let index = order.length - 1; index >= 0; index -= 1) {
        const id = order[index]
        if (id !== undefined) {
            const record = tasks.get(id)
            if (record !== undefined && record.status === "running") {
                return infoOf(record)
            }
        }
    }
    const latest = order[order.length - 1]
    return latest === undefined ? null : infoOf(tasks.get(latest)!)
}

export function stopTask(taskId: string | undefined, mode: StopMode): boolean {
    const info = queryTask(taskId)
    if (info === null) {
        return false
    }
    const record = tasks.get(info.taskId)
    if (record === undefined || record.status !== "running") {
        return false
    }
    record.cancelled = true
    record.handle.stop(mode)
    return true
}
