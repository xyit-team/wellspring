/*
 * start：以服务进程启动。
 * 加载插件后触发 onInit，保持进程存活；只有 Ctrl+C / SIGTERM 或插件调用 shutdown() 才退出。
 */

import { emitInitHooks, emitShutdownHooks, setShutdownHandler } from "../api/host/hooks.ts"
import { success, type CommandContext, type CommandOutcome } from "./shared.ts"

export async function runStartCommand(ctx: CommandContext): Promise<CommandOutcome> {
    await ctx.loadPlugins()

    const state: { resolve: (() => void) | null } = { resolve: null }
    const shutdownPromise = new Promise<void>((resolve) => {
        state.resolve = resolve
    })
    const requestShutdown = (): void => {
        state.resolve?.()
    }

    setShutdownHandler(requestShutdown)
    const onSignal = (): void => {
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
        ctx.elog.notice("正在关闭…")
        await emitShutdownHooks()
        ctx.logger.info("service stopped")
        ctx.elog.info("Wellspring 服务已关闭")
        return success({ pid: process.pid })
    } finally {
        clearInterval(keepAlive)
        process.off("SIGINT", onSignal)
        process.off("SIGTERM", onSignal)
        setShutdownHandler(null)
    }
}
