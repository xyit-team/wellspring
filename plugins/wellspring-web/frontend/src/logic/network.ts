/*
 * 网络代理表单的纯逻辑：noProxy 列表与文本框互转。
 */

/** 逗号 / 中文逗号 / 空白 / 换行分隔，去空去重 */
export function parseNoProxy(text: string): string[] {
    const result: string[] = []
    for (const raw of text.split(/[\s,，]+/)) {
        const value = raw.trim()
        if (value === "" || result.includes(value)) continue
        result.push(value)
    }
    return result
}

export function formatNoProxy(values: readonly string[] | null | undefined): string {
    return (values ?? []).join(", ")
}
