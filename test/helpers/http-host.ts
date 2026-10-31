/*
 * 测试辅助：以 sandbox 客户端的方式启动 wellspring-http 插件。
 * 依赖 wellspring-http 的插件（wellspring-web / wellspring-code）在测试里需要先启动它。
 */

import { join } from "node:path"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../../src/config/defaults.ts"
import type { EventEntity } from "../../src/event/event.ts"
import { eventBus } from "../../src/event/event.ts"
import type { ResolvedPaths } from "../../src/platform/path.ts"
import { DirectBackend } from "../../src/sandbox/backends/direct.ts"
import { PluginSandboxClient } from "../../src/sandbox/plugin-client.ts"
import type { HttpBusReadyEvent, HttpBusServerEvent } from "../../src/api/plugin/http-protocol.ts"
import { httpRequestChannel } from "../../src/api/plugin/http-protocol.ts"

const projectRoot = join(import.meta.dirname, "../..")

/** 启动 wellspring-http 插件实例；返回的 client 需要测试自己 close */
export async function startHttpHostPlugin(paths: ResolvedPaths): Promise<PluginSandboxClient> {
    const client = new PluginSandboxClient({
        pluginId: "wellspring-http",
        pluginName: "Wellspring HTTP",
        pluginVersion: "1.0.0",
        pluginDir: join(projectRoot, "plugins", "wellspring-http"),
        pluginEntry: join(projectRoot, "plugins", "wellspring-http", "index.ts"),
        paths,
        config: DEFAULT_SETTINGS,
        pluginConfig: {},
        backend: new DirectBackend(),
        limits: { timeoutMs: 10_000, memoryMB: 256, pids: 32, outputLimitBytes: 4096 },
        logger: pino({ level: "silent" }),
        permissions: {
            hostApi: ["logger", "http", "event"],
            workspaceRead: false,
            workspaceWrite: false,
        },
    })
    await client.start()
    return client
}

export interface HttpServerWatcher {
    /** ready 已经发生则立即可用；error / 超时都会 reject */
    readonly ready: Promise<HttpBusReadyEvent>
    /** 收到的全部服务器事件（ready / http-request / stopped …），便于断言 */
    readonly events: HttpBusServerEvent[]
    dispose(): void
}

/** 在发起注册之前订阅请求频道，等待 wellspring-http 回 ready */
export function watchHttpServer(name: string, timeoutMs = 10_000): HttpServerWatcher {
    const events: HttpBusServerEvent[] = []
    let settleReady: ((event: HttpBusReadyEvent) => void) | null = null
    let settleError: ((error: Error) => void) | null = null
    const unsubscribe = eventBus.subscribe<HttpBusServerEvent>(
        httpRequestChannel(name),
        (event: EventEntity<HttpBusServerEvent>) => {
            const data = event.getData()
            events.push(data)
            if (data.type === "ready") {
                settleReady?.(data)
            } else if (data.type === "error") {
                settleError?.(new Error(`${data.code}: ${data.message}`))
            }
        },
    )
    const timer = setTimeout(() => {
        settleError?.(new Error(`等待 HTTP 服务器超时：${name}`))
    }, timeoutMs)
    timer.unref()
    const ready = new Promise<HttpBusReadyEvent>((resolve, reject) => {
        settleReady = (event) => {
            clearTimeout(timer)
            resolve(event)
        }
        settleError = (error) => {
            clearTimeout(timer)
            reject(error)
        }
    })
    return {
        ready,
        events,
        dispose() {
            clearTimeout(timer)
            unsubscribe()
        },
    }
}
