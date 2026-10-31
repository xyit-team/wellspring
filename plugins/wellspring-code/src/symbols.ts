/*
 * 服务端符号解析：与客户端大纲共用同一套按语言的逐行正则规则。
 * 只做轻量提取，供工作区符号搜索使用。
 */

export interface SymbolEntry {
    readonly name: string
    readonly kind: string
    readonly line: number
    readonly depth: number
}

const MAX_SYMBOL_LINES = 8000
const MAX_SYMBOL_FILE_RESULTS = 400
const MAX_SYMBOL_LINE_CHARS = 400

interface LanguagePattern {
    readonly pattern: RegExp
    readonly nameGroup: number
    readonly kind: (match: RegExpExecArray) => string
    readonly depthByIndent: boolean
}

function languagePattern(language: string): LanguagePattern | null {
    switch (language) {
        case "typescript":
        case "javascript":
            return {
                pattern:
                    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
                nameGroup: 2,
                kind: (match) => keywordKind(match[1] ?? ""),
                depthByIndent: true,
            }
        case "python":
            return {
                pattern: /^\s*(class|def|async def)\s+([A-Za-z_]\w*)/,
                nameGroup: 2,
                kind: (match) => keywordKind(match[1] ?? ""),
                depthByIndent: true,
            }
        case "rust":
            return {
                pattern:
                    /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|impl|mod|const|type)\s+([A-Za-z_]\w*)/,
                nameGroup: 2,
                kind: (match) => keywordKind(match[1] ?? ""),
                depthByIndent: true,
            }
        case "go":
            return {
                pattern: /^\s*(func|type|var|const)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
                nameGroup: 2,
                kind: (match) => keywordKind(match[1] ?? ""),
                depthByIndent: true,
            }
        case "java":
        case "csharp":
            return {
                pattern:
                    /^\s*(?:public|private|protected|internal|static|abstract|final|sealed|partial|\s)*(class|interface|enum|record|void|[A-Za-z_][\w<>[\]]*)\s+([A-Za-z_]\w*)\s*\(?/,
                nameGroup: 2,
                kind: (match) => keywordKind(match[1] ?? ""),
                depthByIndent: true,
            }
        case "css":
        case "scss":
        case "less":
            return {
                pattern: /^\s*([.#]?[A-Za-z_][\w-]*(?:[\s>+~][.#]?[A-Za-z_][\w-]*)*)\s*\{/,
                nameGroup: 1,
                kind: () => "selector",
                depthByIndent: false,
            }
        case "markdown":
            return {
                pattern: /^(#{1,6})\s+(.+)$/,
                nameGroup: 2,
                kind: () => "heading",
                depthByIndent: false,
            }
        case "shell":
        case "powershell":
            return {
                pattern: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/,
                nameGroup: 1,
                kind: () => "function",
                depthByIndent: true,
            }
        case "html":
        case "xml":
        case "vue":
            return {
                pattern: /^(\s*)<([a-z][a-z0-9-]*)[^>]*\bid="([^"]+)"/,
                nameGroup: 3,
                kind: () => "tag",
                depthByIndent: false,
            }
        case "yaml":
        case "ini":
        case "toml":
            return {
                pattern: /^\s*([A-Za-z_][\w.-]*)\s*:/,
                nameGroup: 1,
                kind: () => "property",
                depthByIndent: false,
            }
        default:
            return null
    }
}

function keywordKind(keyword: string): string {
    if (
        keyword === "function" ||
        keyword === "fn" ||
        keyword === "def" ||
        keyword === "func" ||
        keyword === "async def"
    ) {
        return "function"
    }
    if (
        keyword === "class" ||
        keyword === "interface" ||
        keyword === "struct" ||
        keyword === "trait" ||
        keyword === "impl"
    ) {
        return "class"
    }
    if (keyword === "enum" || keyword === "type" || keyword === "record") {
        return "type"
    }
    return "symbol"
}

/** 从文本里提取符号；空内容或不支持的语言返回空数组 */
export function extractSymbols(content: string, language: string): SymbolEntry[] {
    const symbols: SymbolEntry[] = []
    if (typeof content !== "string" || content === "") return symbols
    const config = languagePattern(language)
    if (config === null) return symbols
    const lines = content.split("\n")
    const max = Math.min(lines.length, MAX_SYMBOL_LINES)
    for (let index = 0; index < max; index += 1) {
        const line = lines[index] ?? ""
        if (line.length > MAX_SYMBOL_LINE_CHARS) continue
        const match = config.pattern.exec(line)
        if (match === null) continue
        const name = (match[config.nameGroup] ?? "").trim()
        if (name === "") continue
        const indent = config.depthByIndent ? line.length - line.replace(/^\s+/, "").length : 0
        symbols.push({
            name,
            kind: config.kind(match),
            line: index + 1,
            depth: Math.min(4, Math.floor(indent / 2)),
        })
        if (symbols.length >= MAX_SYMBOL_FILE_RESULTS) break
    }
    return symbols
}
