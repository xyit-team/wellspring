/*
 * 工具参数与输出的展示格式化（纯逻辑，便于单测）。
 *
 * 参数是 JSON 字符串（`execute_code` 的 command/argv 等），直接丢进 <pre>
 * 会把换行显示成字面的 \n；这里能解析就展开成缩进键值，字符串值保留真实换行。
 */

function formatValue(value: unknown, depth: number): string {
    const pad = "  ".repeat(depth)
    if (value === null || value === undefined) return "null"
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (Array.isArray(value)) {
        if (value.length === 0) return "[]"
        return value
            .map((item) =>
                typeof item === "object" && item !== null
                    ? `\n${pad}  - ${formatValue(item, depth + 1).trim()}`
                    : ` ${formatValue(item, depth + 1)}`,
            )
            .join("")
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    return entries
        .map(([key, item]) => {
            const text = formatValue(item, depth + 1)
            const inline = !text.includes("\n") && text.length <= 60
            return inline ? `\n${pad}${key}: ${text}` : `\n${pad}${key}:\n${pad}  ${text.trim()}`
        })
        .join("")
}

/** 参数/输出文本 → 给人看的排版 */
export function formatPayload(text: string | undefined): string {
    const raw = (text ?? "").trim()
    if (raw === "") return ""
    const looksJson = raw.startsWith("{") || raw.startsWith("[")
    if (looksJson) {
        try {
            return formatValue(JSON.parse(raw), 0).trim()
        } catch {
            /* 不是合法 JSON：按纯文本处理 */
        }
    }
    // 已有真实换行就原样展示；只有字面 \n 的（旧数据/被转义过）才还原
    if (raw.includes("\n")) return raw
    return raw.replace(/\\n/g, "\n").replace(/\\t/g, "  ").replace(/\\r/g, "")
}
