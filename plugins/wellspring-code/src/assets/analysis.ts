/*
 * 轻量语法分析：只做结构检查，不追求完整解析。
 * 产出 { line, column, endLine, endColumn, severity, message } 供编辑器与问题面板展示。
 *
 * 检查项：括号配对、字符串/注释未闭合、JSON.parse 失败。
 * 语言按注释与字符串规则归类，未支持的语言直接返回空数组。
 */

export const ANALYSIS_JS = String.raw`
/* ── 语法分析 ─────────────────────────────────────────────── */

var ANALYSIS_MAX_CHARS = 400000
var ANALYSIS_MAX_ITEMS = 200
var ANALYSIS_QUOTE = String.fromCharCode(96)

/* 注释/字符串规则：c=C 家族（// 与块注释）、css=块注释、python/shell=行注释、json=仅双引号 */
var ANALYSIS_FAMILIES = {
    typescript: "c",
    javascript: "c",
    java: "c",
    c: "c",
    cpp: "c",
    csharp: "c",
    rust: "c",
    go: "c",
    php: "c",
    css: "css",
    scss: "css",
    less: "css",
    python: "python",
    shell: "shell",
    powershell: "shell",
    json: "json"
}

function analysisPositionOf(code, index) {
    var position = Math.max(0, Math.min(index, code.length))
    var line = 1
    var lastBreak = -1
    for (var i = 0; i < position; i += 1) {
        if (code.charAt(i) === "\n") {
            line += 1
            lastBreak = i
        }
    }
    return { line: line, column: position - lastBreak }
}

/** JSON 交给 JSON.parse 兜底；能取到位置时用它定位，取不到就落在第一行 */
function analyzeJsonText(code) {
    var items = []
    try {
        JSON.parse(code)
        return items
    } catch (error) {
        var message = error && error.message ? String(error.message) : "解析失败"
        var match = /position (\d+)/.exec(message)
        var location = analysisPositionOf(code, match === null ? 0 : Number(match[1]))
        var detail = message.replace(/ in JSON at position \d+/i, "").replace(/ at position \d+/i, "")
        if (detail.length > 120) detail = detail.slice(0, 120) + "…"
        items.push({
            line: location.line,
            column: location.column,
            endLine: location.line,
            endColumn: location.column + 1,
            severity: "error",
            message: "JSON 语法错误：" + detail
        })
    }
    return items
}

function analyzeStructure(code, language, family) {
    var items = []
    var stack = []
    var length = code.length
    var line = 1
    var column = 1
    var index = 0
    var slashComments = family === "c" || family === "css"
    var hashComments = family === "python" || family === "shell"
    var blockComments = family === "c" || family === "css"
    var tripleQuotes = language === "python"
    var templateQuotes =
        language === "javascript" ||
        language === "typescript" ||
        language === "go" ||
        language === "shell"
    var onlyDoubleQuotes = family === "json"
    var pairs = { ")": "(", "]": "[", "}": "{" }

    function advance() {
        if (code.charAt(index) === "\n") {
            line += 1
            column = 1
        } else {
            column += 1
        }
        index += 1
    }

    function push(message, atLine, atColumn, endLine, endColumn) {
        if (items.length >= ANALYSIS_MAX_ITEMS) return
        items.push({
            line: atLine,
            column: atColumn,
            endLine: endLine,
            endColumn: endColumn,
            severity: "error",
            message: message
        })
    }

    function skipLineComment() {
        while (index < length && code.charAt(index) !== "\n") advance()
    }

    function skipBlockComment(startLine, startColumn) {
        advance()
        advance()
        while (index < length) {
            if (code.charAt(index) === "*" && code.charAt(index + 1) === "/") {
                advance()
                advance()
                return
            }
            advance()
        }
        push("注释没有闭合", startLine, startColumn, undefined, undefined)
    }

    /* quote 已由调用方看过；这里从引号之后开始扫 */
    function scanString(quote, startLine, startColumn, allowNewline) {
        advance()
        while (index < length) {
            var character = code.charAt(index)
            if (character === "\\") {
                advance()
                if (index < length) advance()
                continue
            }
            if (character === quote) {
                advance()
                return
            }
            if (character === "\n" && allowNewline !== true) {
                push("字符串没有闭合", startLine, startColumn, undefined, undefined)
                return
            }
            advance()
        }
        push("字符串没有闭合", startLine, startColumn, undefined, undefined)
    }

    while (index < length && items.length < ANALYSIS_MAX_ITEMS) {
        var character = code.charAt(index)
        if (slashComments && character === "/" && code.charAt(index + 1) === "/") {
            skipLineComment()
            continue
        }
        if (blockComments && character === "/" && code.charAt(index + 1) === "*") {
            skipBlockComment(line, column)
            continue
        }
        if (hashComments && character === "#") {
            skipLineComment()
            continue
        }
        if (tripleQuotes && character === "\"" && code.slice(index, index + 3) === "\"\"\"") {
            var tripleLine = line
            var tripleColumn = column
            advance()
            advance()
            advance()
            var closed = false
            while (index < length) {
                if (code.slice(index, index + 3) === "\"\"\"") {
                    advance()
                    advance()
                    advance()
                    closed = true
                    break
                }
                advance()
            }
            if (!closed) push("字符串没有闭合", tripleLine, tripleColumn, undefined, undefined)
            continue
        }
        if (tripleQuotes && character === "'" && code.slice(index, index + 3) === "'''") {
            var singleLine = line
            var singleColumn = column
            advance()
            advance()
            advance()
            var singleClosed = false
            while (index < length) {
                if (code.slice(index, index + 3) === "'''") {
                    advance()
                    advance()
                    advance()
                    singleClosed = true
                    break
                }
                advance()
            }
            if (!singleClosed) push("字符串没有闭合", singleLine, singleColumn, undefined, undefined)
            continue
        }
        if (character === "\"" || character === "'") {
            scanString(character, line, column, false)
            continue
        }
        if (templateQuotes && character === ANALYSIS_QUOTE) {
            scanString(ANALYSIS_QUOTE, line, column, true)
            continue
        }
        if (onlyDoubleQuotes && character === "'") {
            advance()
            continue
        }
        if (character === "(" || character === "[" || character === "{") {
            stack.push({ char: character, line: line, column: column })
            advance()
            continue
        }
        if (character === ")" || character === "]" || character === "}") {
            var expected = pairs[character]
            if (stack.length === 0) {
                push("多余的 " + character, line, column, line, column + 1)
            } else {
                var top = stack[stack.length - 1]
                if (top.char !== expected) {
                    push(
                        "括号不匹配：应为 " + expected + "，这里是 " + character,
                        line,
                        column,
                        line,
                        column + 1
                    )
                }
                stack.pop()
            }
            advance()
            continue
        }
        advance()
    }

    for (var pending = stack.length - 1; pending >= 0 && items.length < ANALYSIS_MAX_ITEMS; pending -= 1) {
        var entry = stack[pending]
        /* 未闭合的括号只标这一个字符；字符串/注释仍标到行尾 */
        push(entry.char + " 没有闭合", entry.line, entry.column, entry.line, entry.column + 1)
    }
    return items
}

/* 光标相邻的括号所在的配对；被字符串/注释包住的位置不参与匹配 */
function bracketMatchAt(code, caret, language) {
    if (typeof code !== "string" || code === "" || typeof language !== "string") return null
    if (code.length > ANALYSIS_MAX_CHARS) return null
    var family = ANALYSIS_FAMILIES[language]
    if (family === undefined) return null
    var opens = "([{"
    var closes = ")]}"
    var pairs = { ")": "(", "]": "[", "}": "{" }
    var position = Math.max(0, Math.min(code.length, Math.floor(Number(caret) || 0)))
    var right = position < code.length ? code.charAt(position) : ""
    var left = position > 0 ? code.charAt(position - 1) : ""
    var target = -1
    var wantOpen = false
    if (opens.indexOf(right) !== -1) {
        target = position
        wantOpen = true
    } else if (closes.indexOf(left) !== -1) {
        target = position - 1
    } else if (opens.indexOf(left) !== -1) {
        target = position - 1
        wantOpen = true
    } else if (closes.indexOf(right) !== -1) {
        target = position
    } else {
        return null
    }

    var slashComments = family === "c" || family === "css"
    var hashComments = family === "python" || family === "shell"
    var blockComments = family === "c" || family === "css"
    var tripleQuotes = language === "python"
    var templateQuotes =
        language === "javascript" ||
        language === "typescript" ||
        language === "go" ||
        language === "shell"
    var onlyDoubleQuotes = family === "json"
    var stack = []
    var index = 0
    var length = code.length

    function skipLine() {
        while (index < length && code.charAt(index) !== "\n") index += 1
    }

    function skipString(quote, allowNewline) {
        index += 1
        while (index < length) {
            var character = code.charAt(index)
            if (character === "\\") {
                index += 2
                continue
            }
            if (character === quote) {
                index += 1
                return
            }
            if (character === "\n" && allowNewline !== true) return
            index += 1
        }
    }

    while (index < length) {
        var character = code.charAt(index)
        if (slashComments && character === "/" && code.charAt(index + 1) === "/") {
            skipLine()
            continue
        }
        if (blockComments && character === "/" && code.charAt(index + 1) === "*") {
            index += 2
            while (index < length) {
                if (code.charAt(index) === "*" && code.charAt(index + 1) === "/") {
                    index += 2
                    break
                }
                index += 1
            }
            continue
        }
        if (hashComments && character === "#") {
            skipLine()
            continue
        }
        if (tripleQuotes && code.slice(index, index + 3) === '"""') {
            index += 3
            while (index < length && code.slice(index, index + 3) !== '"""') index += 1
            index += 3
            continue
        }
        if (tripleQuotes && code.slice(index, index + 3) === "'''") {
            index += 3
            while (index < length && code.slice(index, index + 3) !== "'''") index += 1
            index += 3
            continue
        }
        if (character === '"' || character === "'") {
            skipString(character, false)
            continue
        }
        if (templateQuotes && character === ANALYSIS_QUOTE) {
            skipString(ANALYSIS_QUOTE, true)
            continue
        }
        if (onlyDoubleQuotes && character === "'") {
            index += 1
            continue
        }
        if (opens.indexOf(character) !== -1) {
            stack.push({ char: character, index: index })
            index += 1
            continue
        }
        if (closes.indexOf(character) !== -1) {
            if (stack.length > 0) {
                var top = stack[stack.length - 1]
                if (top.char === pairs[character]) {
                    stack.pop()
                    if (wantOpen && top.index === target) {
                        return { open: top.index, close: index }
                    }
                    if (wantOpen !== true && index === target) {
                        return { open: top.index, close: index }
                    }
                }
            }
            if (wantOpen !== true && index >= target) return null
            index += 1
            continue
        }
        index += 1
    }
    return null
}

function analyzeSyntax(code, language) {
    if (typeof code !== "string" || typeof language !== "string") return []
    if (code.length > ANALYSIS_MAX_CHARS) return []
    var family = ANALYSIS_FAMILIES[language]
    if (family === undefined) return []
    var items = analyzeStructure(code, language, family)
    if (family === "json") {
        if (items.length === 0) {
            items = analyzeJsonText(code)
        }
    }
    items.sort(function (left, right) {
        if (left.line !== right.line) return left.line - right.line
        return left.column - right.column
    })
    return items.slice(0, ANALYSIS_MAX_ITEMS)
}
`
