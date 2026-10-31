/*
 * start：以服务进程启动。
 * 加载插件后触发 onInit，保持进程存活；只有 Ctrl+C / SIGTERM 或插件调用 shutdown() 才退出。
 */

import { emitInitHooks, emitShutdownHooks, setShutdownHandler } from "../api/host/hooks.ts"
import { setHostStatus } from "../api/host/host.ts"
import {
    ServiceAlreadyRunningError,
    assertServiceStartable,
    clearServiceRecord,
    writeServiceRecord,
} from "../service/control.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

export async function runStartCommand(ctx: CommandContext): Promise<CommandOutcome> {
    await ctx.loadPlugins()

    try {
        await assertServiceStartable(ctx.paths)
    } catch (error) {
        if (error instanceof ServiceAlreadyRunningError) {
            return failure(`service.already-running:${error.pid}`)
        }
        const message = error instanceof Error ? error.message : String(error)
        return failure(`service.record-failed:${message}`)
    }

    await writeServiceRecord(
        { pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() },
        ctx.paths,
    )

    const state: { resolve: (() => void) | null } = { resolve: null }
    const shutdownPromise = new Promise<void>((resolve) => {
        state.resolve = resolve
    })
    const requestShutdown = (): void => {
        state.resolve?.()
    }

    setShutdownHandler(requestShutdown)
    let signals = 0
    const onSignal = (): void => {
        signals += 1
        // 第二次 Ctrl+C 直接退出：某个插件的 onShutdown 卡住时仍然能停下来
        if (signals > 1) {
            ctx.elog.notice("强制退出")
            process.exit(130)
        }
        requestShutdown()
    }
    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)

    // 没有常驻 handle 时 Node 会直接退出，这里显式保持事件循环
    const keepAlive = setInterval(() => undefined, 60_000)

    ctx.logger.info({ pid: process.pid }, "service started")
    ctx.elog.info("Wellspring 服务已启动，Ctrl+C 退出")

    try {
        await emitInitHooks()
        await shutdownPromise
        setHostStatus("stopping")
        ctx.elog.notice("正在关闭…")
        // 兜底：插件 onShutdown 若卡住（例如有长连接没断开），超时后强制退出
        const forceExit = setTimeout(() => {
            ctx.elog.notice("关闭超时，强制退出")
            process.exit(130)
        }, 10_000)
        forceExit.unref()
        try {
            await emitShutdownHooks()
        } finally {
            clearTimeout(forceExit)
        }
        ctx.logger.info("service stopped")
        ctx.elog.info("Wellspring 服务已关闭")
        return success({ pid: process.pid })
    } finally {
        clearInterval(keepAlive)
        process.off("SIGINT", onSignal)
        process.off("SIGTERM", onSignal)
        setShutdownHandler(null)
        await clearServiceRecord(process.pid, ctx.paths)
    }
}
