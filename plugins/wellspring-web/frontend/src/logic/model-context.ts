/*
 * 上下文窗口表单：把输入框里的值映射回「供应商 + 模型」。
 *
 * 输入框的键是 `${provider}/${model}`，而模型名本身可能带 `/`
 * （例如 `deepseek/deepseek-v4.1-flash`）。所以这里按供应商/模型表遍历，
 * 绝不要把键按 `/` 拆开——拆开会截断模型名，保存的键对不上，
 * 页面重新加载后看起来像「保存失败」。
 */

export interface ContextProviderModels {
    readonly id: string
    readonly models: readonly string[]
}

export interface ContextInputEntry {
    readonly provider: string
    readonly model: string
    readonly raw: string
}

export function contextInputEntries(
    providers: readonly ContextProviderModels[],
    inputs: Readonly<Record<string, string>>,
): ContextInputEntry[] {
    const entries: ContextInputEntry[] = []
    for (const provider of providers) {
        for (const model of provider.models) {
            const raw = inputs[`${provider.id}/${model}`]
            if (raw === undefined) continue
            entries.push({ provider: provider.id, model, raw })
        }
    }
    return entries
}
