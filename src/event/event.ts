/*
 * EventEntity / EventBus
 *
 * EventEntity 的负载只读，取消状态可变：监听器对事件实例调 cancel 后
 * isCancelled 立即为 true，EventBus 据此终止后续传播
 * 取消不回滚已完成的投递
 */

export class EventEntity<T> {
    private readonly data: T
    private cancelled: boolean
    private cancelReason: string

    private constructor(data: T, cancelled = false, cancelReason = "") {
        this.data = data
        this.cancelled = cancelled
        this.cancelReason = cancelReason
    }

    public static create<T>(data: T, cancelled = false, cancelReason = ""): EventEntity<T> {
        return new EventEntity(data, cancelled, cancelReason)
    }

    public cancel(reason = ""): this {
        this.cancelled = true
        this.cancelReason = reason
        return this
    }

    public getData(): T {
        return this.data
    }
    public isCancelled(): boolean {
        return this.cancelled
    }
    public getCancelReason(): string {
        return this.cancelReason
    }
}

import { getHostBridge } from "../sandbox/bridge-state.ts"

export type EventListener<T = unknown> = (event: EventEntity<T>) => void

// 存储层擦除负载类型：同一总线容纳各事件名的监听器
type ListenerRecord = {
    readonly fn: EventListener<any>
    active: boolean
}

export class EventBus {
    private readonly listeners = new Map<string, ListenerRecord[]>()
    private readonly bridgeSubscriptions = new Set<string>()

    subscribe<T>(eventName: string, listener: EventListener<T>): () => void {
        if (typeof listener !== "function") {
            throw new TypeError(`监听器不是函数：${eventName}`)
        }
        const record: ListenerRecord = { fn: listener, active: true }
        const bridge = getHostBridge()
        if (bridge !== null && !this.bridgeSubscriptions.has(eventName)) {
            this.bridgeSubscriptions.add(eventName)
            void bridge.request("host.event.subscribe", { name: eventName }).catch(() => undefined)
        }
        const handlers = this.listeners.get(eventName)
        if (handlers) {
            handlers.push(record)
        } else {
            this.listeners.set(eventName, [record])
        }

        return () => this.remove(eventName, record)
    }

    publish<T>(eventName: string, event: EventEntity<T>): void {
        const bridge = getHostBridge()
        if (bridge !== null) {
            bridge.notify("host.event.publish", { name: eventName, data: event.getData() })
            return
        }
        this.deliverLocal(eventName, event)
    }

    /** sandbox bridge 收到宿主事件后在本进程投递 */
    receive<T>(eventName: string, data: T): void {
        this.deliverLocal(eventName, EventEntity.create(data))
    }

    private deliverLocal<T>(eventName: string, event: EventEntity<T>): void {
        const handlers = this.listeners.get(eventName)
        if (!handlers || handlers.length === 0) {
            return
        }

        let firstError: unknown
        let failed = false
        // 快照后校验存活状态：本轮回调内的退订对后续监听器生效
        for (const record of handlers.slice()) {
            if (!record.active) continue
            if (event.isCancelled()) break
            try {
                record.fn(event)
            } catch (error) {
                // 单监听器异常不中断其余监听器，循环结束后抛出首个异常
                if (!failed) {
                    firstError = error
                    failed = true
                }
            }
        }
        if (failed) {
            throw firstError
        }
    }

    once<T>(eventName: string, listener: EventListener<T>): () => void {
        const unsubscribe = this.subscribe<T>(eventName, (event) => {
            // 先退订再回调：回调内重入发布不会二次触发，回调抛错也不残留订阅
            unsubscribe()
            listener(event)
        })
        return unsubscribe
    }

    clear(eventName: string): void {
        this.unsubscribeBridge(eventName)
        const handlers = this.listeners.get(eventName)
        if (!handlers) return
        for (const record of handlers) {
            record.active = false
        }
        this.listeners.delete(eventName)
    }

    clearAll(): void {
        for (const eventName of [...this.bridgeSubscriptions]) {
            this.unsubscribeBridge(eventName)
        }
        for (const handlers of this.listeners.values()) {
            for (const record of handlers) {
                record.active = false
            }
        }
        this.listeners.clear()
    }

    private remove(eventName: string, record: ListenerRecord): void {
        if (!record.active) return
        record.active = false
        const handlers = this.listeners.get(eventName)
        if (!handlers) return
        const index = handlers.indexOf(record)
        if (index !== -1) {
            handlers.splice(index, 1)
        }
        if (handlers.length === 0) {
            this.listeners.delete(eventName)
            this.unsubscribeBridge(eventName)
        }
    }

    private unsubscribeBridge(eventName: string): void {
        if (!this.bridgeSubscriptions.delete(eventName)) {
            return
        }
        const bridge = getHostBridge()
        bridge?.notify("host.event.unsubscribe", { name: eventName })
    }
}

export const eventBus = new EventBus()
