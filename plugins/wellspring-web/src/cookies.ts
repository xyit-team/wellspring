/* Cookie 解析：认证与主题共用。 */

export function parseCookies(header: string | undefined): Record<string, string> {
    if (header === undefined) {
        return {}
    }
    const cookies: Record<string, string> = {}
    for (const part of header.split(";")) {
        const index = part.indexOf("=")
        if (index === -1) {
            continue
        }
        const key = part.slice(0, index).trim()
        const value = part.slice(index + 1).trim()
        if (key === "") {
            continue
        }
        try {
            cookies[key] = decodeURIComponent(value)
        } catch {
            cookies[key] = value
        }
    }
    return cookies
}
