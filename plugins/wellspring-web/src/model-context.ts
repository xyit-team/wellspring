/*
 * 模型上下文窗口配置：按 provider/model 记录 tokens 上限，存在插件数据目录。
 * 只用于界面显示（占用估算）与后续压缩策略，不改变宿主请求参数。
 */

const CONTEXT_FILE = "model-context.json"
export const MAX_CONTEXT_WINDOW = 10_000_000
export const MIN_CONTEXT_WINDOW = 256
const MAX_CONTEXT_ENTRIES = 500
const MAX_PROVIDER_CHARS = 64
const MAX_MODEL_CHARS = 160

/** 只声明用到的文件能力，便于单测注入 */
export interface ContextFileApi {
    readJson<T = unknown>(path: string): Promise<T | null>
    writeJson(path: string, value: unknown): Promise<void>
}

export interface ModelContextItem {
    readonly provider: string
    readonly model: string
    readonly contextWindow: number | null
}

export type ModelContextMap = Record<string, number>

export function modelContextKey(provider: string, model: string): string {
    return `${provider}/${model}`
}

export function isValidContextWindow(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= MIN_CONTEXT_WINDOW &&
        value <= MAX_CONTEXT_WINDOW
    )
}

function normalizeText(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null
    const text = value.trim()
    if (text === "" || text.length > max) return null
    if (/[\u0000-\u001f]/.test(text)) return null
    return text
}

export class ModelContextStore {
    readonly #fs: ContextFileApi
    #contexts: ModelContextMap = {}

    constructor(fs: ContextFileApi) {
        this.#fs = fs
    }

    async load(): Promise<void> {
        try {
            const value = await this.#fs.readJson<unknown>(CONTEXT_FILE)
            this.#contexts = normalizeContexts(value)
        } catch {
            this.#contexts = {}
        }
    }

    all(): ModelContextMap {
        return { ...this.#contexts }
    }

    get(provider: string, model: string): number | null {
        const value = this.#contexts[modelContextKey(provider, model)]
        return typeof value === "number" ? value : null
    }

    /** 批量写入；contextWindow 为 null 时删除该条配置 */
    async apply(items: readonly ModelContextItem[]): Promise<ModelContextMap> {
        const next: ModelContextMap = { ...this.#contexts }
        for (const item of items) {
            const provider = normalizeText(item.provider, MAX_PROVIDER_CHARS)
            const model = normalizeText(item.model, MAX_MODEL_CHARS)
            if (provider === null || model === null) {
                throw new Error("供应商或模型不合法")
            }
            const key = modelContextKey(provider, model)
            if (item.contextWindow === null) {
                delete next[key]
            } else {
                if (!isValidContextWindow(item.contextWindow)) {
                    throw new Error("上下文窗口必须是正整数字符数")
                }
                next[key] = item.contextWindow
            }
        }
        const entries = Object.entries(next)
        if (entries.length > MAX_CONTEXT_ENTRIES) {
            throw new Error("上下文配置条目过多")
        }
        const trimmed: ModelContextMap = {}
        for (const [key, value] of entries) {
            if (isValidContextWindow(value)) trimmed[key] = value
        }
        await this.#fs.writeJson(CONTEXT_FILE, trimmed)
        this.#contexts = trimmed
        return { ...trimmed }
    }
}

function normalizeContexts(value: unknown): ModelContextMap {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {}
    }
    const result: ModelContextMap = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!isValidContextWindow(raw)) continue
        if (key.length === 0 || key.length > MAX_PROVIDER_CHARS + MAX_MODEL_CHARS + 1) continue
        result[key] = raw
    }
    return result
}
