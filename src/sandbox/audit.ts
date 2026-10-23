/*
 * sandbox 审计日志：<logDir>/sandbox-audit.log，JSONL。
 */

import { appendFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { ensureDir } from "../platform/file.ts"
import type { ResolvedPaths } from "../platform/path.ts"

export interface SandboxAuditEvent {
    readonly type: string
    readonly sandboxId: string
    readonly pluginId?: string
    readonly backend?: string
    readonly decision?: "allowed" | "denied"
    readonly reason?: string
    readonly [key: string]: unknown
}

let queue: Promise<void> = Promise.resolve()

export function auditSandbox(paths: ResolvedPaths, event: SandboxAuditEvent): void {
    const file = join(paths.logDir, "sandbox-audit.log")
    queue = queue
        .then(async () => {
            await ensureDir(dirname(file))
            await appendFile(
                file,
                `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`,
            )
        })
        .catch(() => undefined)
}

export async function flushSandboxAudit(): Promise<void> {
    await queue
}
