/*
 * stop 命令：停止运行中的 wellspring start 服务
 *
 * 读取 <dataDir>/service.json，发送 SIGTERM，等待进程退出
 */

import { ServiceNotRunningError, ServiceStopTimeoutError, stopService } from "../service/control.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

export async function runStopCommand(ctx: CommandContext): Promise<CommandOutcome> {
    try {
        const pid = await stopService(ctx.paths)
        ctx.elog.info(`已停止 Wellspring 服务（pid ${pid}）`)
        return success({ pid })
    } catch (error) {
        if (error instanceof ServiceNotRunningError) {
            return failure("service.not-running")
        }
        if (error instanceof ServiceStopTimeoutError) {
            return failure(`service.stop-timeout:${error.pid}`)
        }
        const message = error instanceof Error ? error.message : String(error)
        return failure(`service.stop-failed:${message}`)
    }
}
