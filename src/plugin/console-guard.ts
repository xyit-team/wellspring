// 插件 console 拦截
// console.* 先记一条 error，再按原方法级别输出原始消息，不直接写终端
// 拦截只覆盖插件的 import / register / run 期间，结束后恢复

import { format } from "node:util"

import type { Logger } from "pino"

const METHODS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table"] as const

type GuardedMethod = (typeof METHODS)[number]

const LEVEL_OF: Readonly<Record<GuardedMethod, "info" | "debug" | "warn" | "error" | "trace">> = {
    log: "info",
    info: "info",
    debug: "debug",
    warn: "warn",
    error: "error",
    trace: "trace",
    dir: "info",
    table: "info",
}

export async function withConsoleGuard<T>(
    pluginName: string,
    logger: Logger,
    task: () => T | Promise<T>,
): Promise<T> {
    const target = console as unknown as Record<string, (...args: unknown[]) => void>
    const originals = new Map<string, (...args: unknown[]) => void>()

    const emit = (level: "info" | "debug" | "warn" | "error" | "trace", args: unknown[]): void => {
        logger.error(`插件 [${pluginName}] 使用了不推荐的 console logger ！`)
        const text = `${pluginName} ${format(...args)}`
        logger[level](text)
    }

    for (const method of METHODS) {
        const original = target[method]
        if (typeof original !== "function") {
            continue
        }
        originals.set(method, original)
        target[method] = (...args: unknown[]): void => {
            emit(LEVEL_OF[method], args)
        }
    }

    const originalAssert = console.assert
    console.assert = (condition: unknown, ...args: unknown[]): void => {
        if (!condition) {
            emit("error", args)
        }
    }

    try {
        return await task()
    } finally {
        for (const [method, original] of originals) {
            target[method] = original
        }
        console.assert = originalAssert
    }
}
