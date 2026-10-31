/*
 * 客户端语法高亮片段，与 editor / app 片段拼进同一个 IIFE。
 * 约束：String.raw 原始字符串，不能出现反引号和美元花括号插值。
 *
 * 输出是已转义的 HTML 片段，只由 highlightCode 内部拼接，不直接接受用户 HTML。
 */

export const HIGHLIGHT_JS = String.raw`
/* ── 词法工具 ─────────────────────────────────────────────── */

function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (character) {
        if (character === "&") return "&amp;"
        if (character === "<") return "&lt;"
        if (character === ">") return "&gt;"
        return "&quot;"
    })
}

function wrapToken(kind, text) {
    return '<span class="tok-' + kind + '">' + escapeHtml(text) + "</span>"
}

function wordSet(words) {
    var set = Object.create(null)
    var list = words.split(" ")
    for (var index = 0; index < list.length; index += 1) {
        if (list[index] !== "") set[list[index]] = true
    }
    return set
}

var PAREN_AHEAD = /\s*\(/y

function matchIsCall(code, fromIndex) {
    PAREN_AHEAD.lastIndex = fromIndex
    return PAREN_AHEAD.test(code)
}

function isPropertyAccess(code, index) {
    if (index <= 0) return false
    return code.charAt(index - 1) === "."
}

function highlightByPattern(code, regex, classify) {
    var output = ""
    var last = 0
    var match
    regex.lastIndex = 0
    while ((match = regex.exec(code)) !== null) {
        if (match.index > last) {
            output += escapeHtml(code.slice(last, match.index))
        }
        output += classify(match[0], match.index, code)
        last = regex.lastIndex
        if (match[0].length === 0) regex.lastIndex += 1
    }
    output += escapeHtml(code.slice(last))
    return output
}

/* ── C 家族 ───────────────────────────────────────────────── */

var C_KEYWORDS = wordSet(
    "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Bool _Complex _Imaginary"
)
var C_TYPES = wordSet(
    "bool char double float int long short signed size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t void unsigned FILE"
)
var C_LITERALS = wordSet("NULL true false")
var JS_KEYWORDS = wordSet(
    "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set as from"
)
var TS_KEYWORDS = wordSet(
    "abstract declare enum implements infer interface is keyof module namespace never override private protected public readonly require satisfies type unique asserts accessor"
)
var JS_TYPES = wordSet(
    "Array Boolean Date Error JSON Map Math Number Object Promise Record RegExp Set String Symbol URL WeakMap any bigint boolean null number object string symbol undefined unknown void never"
)
var JAVA_KEYWORDS = wordSet(
    "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public record sealed permits return static strictfp super switch synchronized this throw throws transient try var void volatile while yield"
)
var JAVA_TYPES = wordSet(
    "boolean byte char double float int long short void String Object Integer Long Double Float Boolean Character List Map Set Optional Stream"
)
var RUST_KEYWORDS = wordSet(
    "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true false type unsafe use where while"
)
var RUST_TYPES = wordSet(
    "bool char f32 f64 i8 i16 i32 i64 i128 isize str String u8 u16 u32 u64 u128 usize Vec Option Result Box Rc Arc"
)
var GO_KEYWORDS = wordSet(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"
)
var GO_TYPES = wordSet(
    "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"
)
var CS_KEYWORDS = wordSet(
    "abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while async await var record init"
)
var CS_TYPES = wordSet(
    "bool byte char decimal double float int long object sbyte short string uint ulong ushort void Task List Dictionary"
)
var PHP_KEYWORDS = wordSet(
    "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield"
)

var C_FAMILIES = {
    typescript: {
        keywords: JS_KEYWORDS,
        extra: TS_KEYWORDS,
        types: JS_TYPES,
        literals: wordSet("true false null undefined this super"),
        template: true
    },
    javascript: {
        keywords: JS_KEYWORDS,
        extra: null,
        types: JS_TYPES,
        literals: wordSet("true false null undefined this super"),
        template: true
    },
    java: {
        keywords: JAVA_KEYWORDS,
        extra: null,
        types: JAVA_TYPES,
        literals: wordSet("true false null")
    },
    c: {
        keywords: C_KEYWORDS,
        extra: null,
        types: C_TYPES,
        literals: C_LITERALS
    },
    cpp: {
        keywords: C_KEYWORDS,
        extra: wordSet(
            "alignas alignof and and_eq asm bitand bitor bool catch char16_t char32_t class compl constexpr const_cast decltype delete dynamic_cast explicit export false friend mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reinterpret_cast static_assert static_cast template this thread_local throw true try typeid typename using virtual wchar_t xor xor_eq override final concept requires"
        ),
        types: C_TYPES,
        literals: wordSet("true false nullptr")
    },
    csharp: {
        keywords: CS_KEYWORDS,
        extra: null,
        types: CS_TYPES,
        literals: wordSet("true false null")
    },
    rust: {
        keywords: RUST_KEYWORDS,
        extra: null,
        types: RUST_TYPES,
        literals: wordSet("true false None Some Ok Err")
    },
    go: {
        keywords: GO_KEYWORDS,
        extra: null,
        types: GO_TYPES,
        literals: wordSet("true false nil iota")
    },
    php: {
        keywords: PHP_KEYWORDS,
        extra: null,
        types: wordSet("array bool callable float int iterable mixed object string void null"),
        literals: wordSet("true false null")
    },
    swift: {
        keywords: wordSet(
            "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as any catch false is nil rethrows super self Self throw throws true try"
        ),
        extra: null,
        types: wordSet("Int Double Float String Bool Array Dictionary Set Optional Any"),
        literals: wordSet("true false nil")
    }
}

var C_PATTERN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\u0060(?:\\[\s\S]|[^\\\u0060])*\u0060|"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'|\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|[A-Za-z_$][A-Za-z0-9_$]*|[{}()\[\];,.:+\-*/%=<>!&|^~?]+|\s+/g

function makeCFamilyClassifier(config) {
    return function (token, index, code) {
        var first = token.charAt(0)
        if (token.slice(0, 2) === "//" || token.slice(0, 2) === "/*") {
            return wrapToken("comment", token)
        }
        if (first === '"' || first === "'" || first === "\u0060") {
            return wrapToken("string", token)
        }
        if (first >= "0" && first <= "9") {
            return wrapToken("number", token)
        }
        if (/^[A-Za-z_$]/.test(first)) {
            if (config.keywords[token] === true) return wrapToken("keyword", token)
            if (config.extra !== null && config.extra[token] === true) return wrapToken("keyword", token)
            if (config.types[token] === true) return wrapToken("type", token)
            if (config.literals[token] === true) return wrapToken("literal", token)
            if (matchIsCall(code, index + token.length)) return wrapToken("function", token)
            if (isPropertyAccess(code, index)) return wrapToken("property", token)
            if (/^[A-Z]/.test(first)) return wrapToken("type", token)
            return wrapToken("variable", token)
        }
        if (/^[{}()\[\];,.:]+$/.test(token)) {
            return wrapToken("punct", token)
        }
        return wrapToken("operator", token)
    }
}

function highlightCFamily(code, language) {
    var config = C_FAMILIES[language]
    if (config === undefined) return escapeHtml(code)
    return highlightByPattern(code, C_PATTERN, makeCFamilyClassifier(config))
}


/* ── C 家族：按行增量分词（带跨行状态） ──────────────────────
 * 编辑器增量着色用：给定行首状态（普通 / 块注释 / 模板字符串），只分词这一行，
 * 返回这一行的 HTML 和行尾状态。改哪行只需重算哪行；只有跨行结构变化时才向后传播。
 */

var LINE_STATE_CODE = 0
var LINE_STATE_BLOCK_COMMENT = 1
var LINE_STATE_STRING = 2

function isIdentifierStartCode(code) {
    return (
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36
    )
}

function isIdentifierPartCode(code) {
    return isIdentifierStartCode(code) || (code >= 48 && code <= 57)
}

function isDigitCode(code) {
    return code >= 48 && code <= 57
}

function isSpaceCode(code) {
    return code === 32 || code === 9 || code === 13 || code === 11 || code === 12
}

function isPunctuationCode(code) {
    return (
        code === 123 ||
        code === 125 ||
        code === 40 ||
        code === 41 ||
        code === 91 ||
        code === 93 ||
        code === 59 ||
        code === 44 ||
        code === 46 ||
        code === 58
    )
}

function isOperatorCode(code) {
    return (
        code === 43 ||
        code === 45 ||
        code === 42 ||
        code === 47 ||
        code === 37 ||
        code === 61 ||
        code === 60 ||
        code === 62 ||
        code === 33 ||
        code === 38 ||
        code === 124 ||
        code === 94 ||
        code === 126 ||
        code === 63
    )
}

/** 从 cursor 起找未转义的结束反引号；返回结束位置之后的下标，找不到返回 -1 */
function scanTemplateEnd(line, cursor) {
    var length = line.length
    while (cursor < length) {
        var code = line.charCodeAt(cursor)
        if (code === 92) {
            cursor += 2
            continue
        }
        if (code === 96) return cursor + 1
        cursor += 1
    }
    return -1
}

/** 单行字符串（"…" / '…'）：允许反斜杠转义，不允许裸换行 */
function scanQuotedEnd(line, cursor, quoteCode) {
    var length = line.length
    while (cursor < length) {
        var code = line.charCodeAt(cursor)
        if (code === 92) {
            cursor += 2
            continue
        }
        if (code === quoteCode) return cursor + 1
        cursor += 1
    }
    return -1
}

/** 数字字面量：0x / 0b / 0o / 十进制（含小数与指数） */
function scanNumberEnd(line, cursor) {
    var length = line.length
    if (line.charCodeAt(cursor) === 48) {
        var prefix = line.charCodeAt(cursor + 1)
        if (prefix === 120 || prefix === 88) {
            cursor += 2
            while (cursor < length) {
                var hex = line.charCodeAt(cursor)
                if (
                    (hex >= 48 && hex <= 57) ||
                    (hex >= 65 && hex <= 70) ||
                    (hex >= 97 && hex <= 102)
                ) {
                    cursor += 1
                } else {
                    break
                }
            }
            return cursor
        }
        if (prefix === 98 || prefix === 66) {
            cursor += 2
            while (cursor < length) {
                var binary = line.charCodeAt(cursor)
                if (binary === 48 || binary === 49) cursor += 1
                else break
            }
            return cursor
        }
        if (prefix === 111 || prefix === 79) {
            cursor += 2
            while (cursor < length) {
                var octal = line.charCodeAt(cursor)
                if (octal >= 48 && octal <= 55) cursor += 1
                else break
            }
            return cursor
        }
    }
    while (cursor < length && isDigitCode(line.charCodeAt(cursor))) cursor += 1
    if (line.charCodeAt(cursor) === 46 && isDigitCode(line.charCodeAt(cursor + 1))) {
        cursor += 1
        while (cursor < length && isDigitCode(line.charCodeAt(cursor))) cursor += 1
    }
    var exponent = line.charCodeAt(cursor)
    if (exponent === 101 || exponent === 69) {
        var sign = line.charCodeAt(cursor + 1)
        var digitsAt = sign === 43 || sign === 45 ? cursor + 2 : cursor + 1
        if (isDigitCode(line.charCodeAt(digitsAt))) {
            cursor = digitsAt
            while (cursor < length && isDigitCode(line.charCodeAt(cursor))) cursor += 1
        }
    }
    return cursor
}

/** 标识符后面（跳过空白）是不是左括号：调用名标成 function */
function isCallArgument(line, from) {
    var cursor = from
    while (cursor < line.length && isSpaceCode(line.charCodeAt(cursor))) cursor += 1
    return line.charCodeAt(cursor) === 40
}

function cFamilyWordKind(line, start, end, config) {
    var word = line.slice(start, end)
    if (config.keywords[word] === true) return "keyword"
    if (config.extra !== null && config.extra !== undefined && config.extra[word] === true) {
        return "keyword"
    }
    if (config.types[word] === true) return "type"
    if (config.literals[word] === true) return "literal"
    if (isCallArgument(line, end)) return "function"
    if (start > 0 && line.charCodeAt(start - 1) === 46) return "property"
    var first = line.charCodeAt(start)
    if (first >= 65 && first <= 90) return "type"
    return "variable"
}

/**
 * 按行分词：返回 { html, state }。state 是行尾状态，会作为下一行的行首状态。
 * 跨行的只有块注释和模板字符串；其余结构都能在单行内判定。
 */
function tokenizeCFamilyLine(line, startState, language) {
    var config = C_FAMILIES[language]
    if (config === undefined) return { html: escapeHtml(line), state: LINE_STATE_CODE }
    var html = ""
    var state = typeof startState === "number" ? startState : LINE_STATE_CODE
    var index = 0
    var length = line.length
    while (index < length) {
        var code = line.charCodeAt(index)
        if (state === LINE_STATE_BLOCK_COMMENT) {
            var close = line.indexOf("*/", index)
            if (close === -1) {
                html += wrapToken("comment", line.slice(index))
                state = LINE_STATE_BLOCK_COMMENT
                break
            }
            html += wrapToken("comment", line.slice(index, close + 2))
            index = close + 2
            state = LINE_STATE_CODE
            continue
        }
        if (state === LINE_STATE_STRING) {
            var templateClose = scanTemplateEnd(line, index)
            if (templateClose === -1) {
                html += wrapToken("string", line.slice(index))
                state = LINE_STATE_STRING
                break
            }
            html += wrapToken("string", line.slice(index, templateClose))
            index = templateClose
            state = LINE_STATE_CODE
            continue
        }
        if (isSpaceCode(code) || code === 10) {
            var spaceEnd = index + 1
            while (spaceEnd < length) {
                var spaceCode = line.charCodeAt(spaceEnd)
                if (!isSpaceCode(spaceCode) && spaceCode !== 10) break
                spaceEnd += 1
            }
            html += escapeHtml(line.slice(index, spaceEnd))
            index = spaceEnd
            continue
        }
        if (code === 47) {
            var next = line.charCodeAt(index + 1)
            if (next === 47) {
                html += wrapToken("comment", line.slice(index))
                index = length
                continue
            }
            if (next === 42) {
                var blockClose = line.indexOf("*/", index + 2)
                if (blockClose === -1) {
                    html += wrapToken("comment", line.slice(index))
                    state = LINE_STATE_BLOCK_COMMENT
                    index = length
                    continue
                }
                html += wrapToken("comment", line.slice(index, blockClose + 2))
                index = blockClose + 2
                continue
            }
            var slashEnd = index + 1
            while (slashEnd < length && isOperatorCode(line.charCodeAt(slashEnd))) slashEnd += 1
            html += wrapToken("operator", line.slice(index, slashEnd))
            index = slashEnd
            continue
        }
        if (code === 34 || code === 39) {
            var quotedEnd = scanQuotedEnd(line, index + 1, code)
            if (quotedEnd === -1) {
                /* 没闭合的引号按原文显示，和整篇正则的可见结果一致 */
                html += escapeHtml(line.charAt(index))
                index += 1
                continue
            }
            html += wrapToken("string", line.slice(index, quotedEnd))
            index = quotedEnd
            continue
        }
        if (code === 96) {
            var stringEnd = scanTemplateEnd(line, index + 1)
            if (stringEnd === -1) {
                html += wrapToken("string", line.slice(index))
                state = LINE_STATE_STRING
                index = length
                continue
            }
            html += wrapToken("string", line.slice(index, stringEnd))
            index = stringEnd
            continue
        }
        if (isIdentifierStartCode(code)) {
            var wordEnd = index + 1
            while (wordEnd < length && isIdentifierPartCode(line.charCodeAt(wordEnd))) wordEnd += 1
            html += wrapToken(
                cFamilyWordKind(line, index, wordEnd, config),
                line.slice(index, wordEnd),
            )
            index = wordEnd
            continue
        }
        if (isDigitCode(code)) {
            var numberEnd = scanNumberEnd(line, index)
            if (isIdentifierPartCode(line.charCodeAt(numberEnd))) {
                /* 123abc 这种不是数字字面量，整段按原文输出 */
                var plainEnd = numberEnd
                while (plainEnd < length && isIdentifierPartCode(line.charCodeAt(plainEnd))) {
                    plainEnd += 1
                }
                html += escapeHtml(line.slice(index, plainEnd))
                index = plainEnd
                continue
            }
            html += wrapToken("number", line.slice(index, numberEnd))
            index = numberEnd
            continue
        }
        if (isPunctuationCode(code)) {
            var punctuationEnd = index + 1
            while (
                punctuationEnd < length &&
                isPunctuationCode(line.charCodeAt(punctuationEnd))
            ) {
                punctuationEnd += 1
            }
            html += wrapToken("punct", line.slice(index, punctuationEnd))
            index = punctuationEnd
            continue
        }
        if (isOperatorCode(code)) {
            var operatorEnd = index + 1
            while (operatorEnd < length && isOperatorCode(line.charCodeAt(operatorEnd))) {
                operatorEnd += 1
            }
            html += wrapToken("operator", line.slice(index, operatorEnd))
            index = operatorEnd
            continue
        }
        html += escapeHtml(line.charAt(index))
        index += 1
    }
    return { html: html, state: state }
}

/* ── JSON ─────────────────────────────────────────────────── */

var JSON_PATTERN = /"(?:\\[\s\S]|[^\\"])*"(?=\s*:)|"(?:\\[\s\S]|[^\\"])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}[\],:]/g

function highlightJson(code) {
    return highlightByPattern(code, JSON_PATTERN, function (token) {
        var first = token.charAt(0)
        if (first === '"') {
            if (/^"(?:\\[\s\S]|[^\\"])*"(?=\s*:)/.test(token)) return wrapToken("property", token)
            return wrapToken("string", token)
        }
        if (token === "true" || token === "false") return wrapToken("literal", token)
        if (token === "null") return wrapToken("literal", token)
        if (/^[{}[\],:]$/.test(token)) return wrapToken("punct", token)
        return wrapToken("number", token)
    })
}

/* ── Python ───────────────────────────────────────────────── */

var PYTHON_KEYWORDS = wordSet(
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"
)
var PYTHON_BUILTINS = wordSet(
    "abs all any bool bytes callable chr dict dir enumerate eval filter float format frozenset getattr hasattr hash hex id input int isinstance issubclass iter len list map max min next object oct open ord pow print property range repr reversed round set setattr slice sorted str sum super tuple type vars zip self cls"
)
var PYTHON_PATTERN = /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'|@[A-Za-z_][\w.]*|\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|[A-Za-z_]\w*|[{}()\[\];,.:+\-*/%=<>!&|^~]+|\s+/g

function highlightPython(code) {
    return highlightByPattern(code, PYTHON_PATTERN, function (token, index, source) {
        var first = token.charAt(0)
        if (first === "#" || token.slice(0, 3) === '"""' || token.slice(0, 3) === "'''") {
            if (first === "#") return wrapToken("comment", token)
            return wrapToken("string", token)
        }
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (first === "@") return wrapToken("decorator", token)
        if (first >= "0" && first <= "9") return wrapToken("number", token)
        if (/^[A-Za-z_]/.test(first)) {
            if (PYTHON_KEYWORDS[token] === true) return wrapToken("keyword", token)
            if (token === "self" || token === "cls") return wrapToken("literal", token)
            if (PYTHON_BUILTINS[token] === true) return wrapToken("type", token)
            if (matchIsCall(source, index + token.length)) return wrapToken("function", token)
            if (/^[A-Z]/.test(first)) return wrapToken("type", token)
            return wrapToken("variable", token)
        }
        if (/^[{}()\[\];,.:]+$/.test(token)) return wrapToken("punct", token)
        return wrapToken("operator", token)
    })
}

/* ── CSS ──────────────────────────────────────────────────── */

var CSS_PATTERN = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'|#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:%|px|em|rem|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex)?\b|--[\w-]+|@[\w-]+|[\w-]+(?=\s*:)|[{}();:,>+~*]/g

function highlightCss(code) {
    return highlightByPattern(code, CSS_PATTERN, function (token) {
        var first = token.charAt(0)
        if (token.slice(0, 2) === "/*") return wrapToken("comment", token)
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (first === "#") return wrapToken("number", token)
        if (first >= "0" && first <= "9") return wrapToken("number", token)
        if (token.slice(0, 2) === "--") return wrapToken("variable", token)
        if (first === "@") return wrapToken("keyword", token)
        if (/^[\w-]+$/.test(token)) return wrapToken("property", token)
        return wrapToken("punct", token)
    })
}

/* ── HTML ─────────────────────────────────────────────────── */

var HTML_PATTERN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?[A-Za-z][\w:.-]*|\/?>|[A-Za-z_:][\w:.-]*(?=\s*=)|"(?:[^"]*)"|'(?:[^']*)'|&[#A-Za-z0-9]+;/g

function highlightHtml(code) {
    return highlightByPattern(code, HTML_PATTERN, function (token) {
        var first = token.charAt(0)
        if (token.slice(0, 4) === "<!--") return wrapToken("comment", token)
        if (token.slice(0, 2) === "<!") return wrapToken("keyword", token)
        if (first === "<" || first === "/") return wrapToken("tag", token)
        if (first === ">") return wrapToken("tag", token)
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (first === "&") return wrapToken("entity", token)
        return wrapToken("attr", token)
    })
}

/* ── YAML / INI / TOML ────────────────────────────────────── */

var YAML_PATTERN = /#[^\n]*|"(?:\\[\s\S]|[^\\"\n])*"|'(?:[^'\n])*'|\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b|^[\s-]*[\w.$-]+(?=\s*:)|\b[\w.-]+(?=\s*:)|[\[\]{}:,|-]/gm

function highlightYaml(code) {
    return highlightByPattern(code, YAML_PATTERN, function (token) {
        var first = token.charAt(0)
        if (first === "#") return wrapToken("comment", token)
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (token === "true" || token === "false" || token === "null" || token === "yes" || token === "no" || token === "on" || token === "off") {
            return wrapToken("literal", token)
        }
        if (/^[\[\]{}:,|-]+$/.test(token)) return wrapToken("punct", token)
        if (token.trim().slice(-1) === ":" || /^[\s-]*[\w.$-]+$/.test(token)) return wrapToken("property", token)
        return wrapToken("number", token)
    })
}

var INI_PATTERN = /[;#][^\n]*|"(?:[^"\n])*"|'(?:[^'\n])*'|^\[[^\]\n]+\]|^[\w.$-]+(?=\s*=)|\b\d+(?:\.\d+)?\b/gm

function highlightIni(code) {
    return highlightByPattern(code, INI_PATTERN, function (token) {
        var first = token.charAt(0)
        if (first === ";" || first === "#") return wrapToken("comment", token)
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (first === "[") return wrapToken("tag", token)
        if (/^[\w.$-]+$/.test(token)) return wrapToken("property", token)
        return wrapToken("number", token)
    })
}

/* ── Shell ────────────────────────────────────────────────── */

var SHELL_KEYWORDS = wordSet(
    "if then else elif fi for while until do done case esac function in select time return break continue local export readonly declare unset shift source alias echo cd pwd exit set trap wait curl git npm pnpm node sudo"
)
var SHELL_PATTERN = /#[^\n]*|"(?:\\[\s\S]|[^\\"\n])*"|'(?:[^'\n])*'|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}|\b\d+\b|[A-Za-z_][\w-]*|[{}()\[\];,.:+\-*/%=<>!&|^~]+|\s+/g

function highlightShell(code) {
    return highlightByPattern(code, SHELL_PATTERN, function (token, index, source) {
        var first = token.charAt(0)
        if (first === "#") return wrapToken("comment", token)
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (first === "$") return wrapToken("variable", token)
        if (first >= "0" && first <= "9") return wrapToken("number", token)
        if (/^[A-Za-z_]/.test(first)) {
            if (SHELL_KEYWORDS[token] === true) return wrapToken("keyword", token)
            if (matchIsCall(source, index + token.length)) return wrapToken("function", token)
            if (/^[A-Z]/.test(first)) return wrapToken("variable", token)
            return wrapToken("variable", token)
        }
        if (/^[{}()\[\];,.:]+$/.test(token)) return wrapToken("punct", token)
        return wrapToken("operator", token)
    })
}

/* ── 其他语言 ─────────────────────────────────────────────── */

var DOCKER_PATTERN = /#[^\n]*|^\s*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b|"(?:[^"\n])*"|'(?:[^'\n])*'|\\$/gm

function highlightDockerfile(code) {
    return highlightByPattern(code, DOCKER_PATTERN, function (token) {
        var first = token.charAt(0)
        if (first === "#") return wrapToken("comment", token)
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (token === "\\") return wrapToken("operator", token)
        return wrapToken("keyword", token)
    })
}

var MAKE_PATTERN = /#[^\n]*|\$\([^)]*\)|\$[@<^?*]|^[\w./%+-]+(?=\s*:)|\b\d+\b|"[^"\n]*"|'[^'\n]*'/gm

function highlightMakefile(code) {
    return highlightByPattern(code, MAKE_PATTERN, function (token) {
        var first = token.charAt(0)
        if (first === "#") return wrapToken("comment", token)
        if (first === "$") return wrapToken("variable", token)
        if (first === '"' || first === "'") return wrapToken("string", token)
        if (first >= "0" && first <= "9") return wrapToken("number", token)
        return wrapToken("function", token)
    })
}

var GRAPHQL_PATTERN = /#[^\n]*|"""[\s\S]*?"""|"(?:\\[\s\S]|[^\\"\n])*"|\b(?:query|mutation|subscription|fragment|on|type|interface|union|enum|input|scalar|schema|extend|directive|implements|true|false|null)\b|[A-Za-z_]\w*|[{}()\[\]:!|=&@$,]/g

function highlightGraphql(code) {
    return highlightByPattern(code, GRAPHQL_PATTERN, function (token, index, source) {
        var first = token.charAt(0)
        if (first === "#") return wrapToken("comment", token)
        if (first === '"') return wrapToken("string", token)
        if (/^[{}()\[\]:!|=&@$,]$/.test(token)) return wrapToken("punct", token)
        if (/^(?:query|mutation|subscription|fragment|on|type|interface|union|enum|input|scalar|schema|extend|directive|implements)$/.test(token)) {
            return wrapToken("keyword", token)
        }
        if (token === "true" || token === "false" || token === "null") return wrapToken("literal", token)
        if (/^[A-Z]/.test(first)) return wrapToken("type", token)
        if (matchIsCall(source, index + token.length)) return wrapToken("function", token)
        return wrapToken("property", token)
    })
}

function highlightDiff(code) {
    var lines = code.split("\n")
    var output = []
    for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index]
        if (line.slice(0, 3) === "+++" || line.slice(0, 3) === "---") {
            output.push(wrapToken("keyword", line))
        } else if (line.charAt(0) === "+") {
            output.push(wrapToken("inserted", line))
        } else if (line.charAt(0) === "-") {
            output.push(wrapToken("deleted", line))
        } else if (line.charAt(0) === "@") {
            output.push(wrapToken("keyword", line))
        } else {
            output.push(escapeHtml(line))
        }
    }
    return output.join("\n")
}

/* ── Markdown ─────────────────────────────────────────────── */

function highlightInlineMarkdown(line) {
    var pattern = /(\u0060[^\u0060]*\u0060)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]*\]\([^)]*\))|(<[^>\s]+>)|(&[#A-Za-z0-9]+;)/g
    var output = ""
    var last = 0
    var match
    while ((match = pattern.exec(line)) !== null) {
        if (match.index > last) output += escapeHtml(line.slice(last, match.index))
        var token = match[0]
        if (token.charAt(0) === "\u0060") output += wrapToken("string", token)
        else if (token.charAt(0) === "*" || token.charAt(0) === "_") output += wrapToken("keyword", token)
        else if (token.charAt(0) === "[") output += wrapToken("link", token)
        else if (token.charAt(0) === "<") output += wrapToken("tag", token)
        else output += wrapToken("entity", token)
        last = pattern.lastIndex
    }
    output += escapeHtml(line.slice(last))
    return output
}

function highlightMarkdown(code) {
    var lines = code.split("\n")
    var output = []
    var fence = null
    var fenceLanguage = ""
    var fenceLines = []

    for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index]
        var fenceMatch = /^\s*(?:>\s*)*(?:[-*+]\s+)?(\u0060{3,}|~{3,})\s*([\w+#-]*)/.exec(line)
        if (fence === null && fenceMatch !== null) {
            fence = fenceMatch[1].charAt(0)
            fenceLanguage = (fenceMatch[2] || "").toLowerCase()
            fenceLines = []
            output.push(wrapToken("fence", line))
            continue
        }
        if (fence !== null) {
            var closeMatch = /^\s*(\u0060{3,}|~{3,})\s*$/.exec(line)
            if (closeMatch !== null && closeMatch[1].charAt(0) === fence) {
                var inner = fenceLines.join("\n")
                var highlighted = fenceLanguage === "" ? escapeHtml(inner) : highlightCode(inner, fenceLanguage)
                output[output.length - 1] = wrapToken("fence", lines[index - fenceLines.length - 1]) + "\n" + highlighted
                output.push(wrapToken("fence", line))
                fence = null
                fenceLines = []
            } else {
                fenceLines.push(line)
            }
            continue
        }
        var heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
            output.push(wrapToken("keyword", heading[1]) + " " + highlightInlineMarkdown(heading[2]))
            continue
        }
        if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
            output.push(wrapToken("punct", line))
            continue
        }
        if (/^\s*>/.test(line)) {
            output.push(wrapToken("comment", "&gt;") + highlightInlineMarkdown(line.replace(/^\s*>/, "")))
            continue
        }
        var listItem = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
        if (listItem !== null) {
            output.push(listItem[1] + wrapToken("keyword", listItem[2]) + " " + highlightInlineMarkdown(listItem[3]))
            continue
        }
        output.push(highlightInlineMarkdown(line))
    }
    if (fence !== null) {
        output[output.length - 1] = wrapToken("fence", lines[lines.length - fenceLines.length - 1]) + "\n" + escapeHtml(fenceLines.join("\n"))
    }
    return output.join("\n")
}

/* ── 分派 ─────────────────────────────────────────────────── */

var MAX_HIGHLIGHT_CHARS = 500000

function highlightCode(code, language) {
    if (typeof code !== "string") return ""
    if (code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code)
    var name = typeof language === "string" ? language : "plaintext"
    switch (name) {
        case "typescript":
        case "javascript":
        case "java":
        case "c":
        case "cpp":
        case "csharp":
        case "rust":
        case "go":
        case "php":
        case "swift":
            return highlightCFamily(code, name)
        case "json":
            return highlightJson(code)
        case "python":
            return highlightPython(code)
        case "css":
        case "scss":
        case "less":
            return highlightCss(code)
        case "html":
        case "xml":
        case "vue":
            return highlightHtml(code)
        case "yaml":
            return highlightYaml(code)
        case "ini":
        case "toml":
            return highlightIni(code)
        case "shell":
        case "powershell":
            return highlightShell(code)
        case "dockerfile":
            return highlightDockerfile(code)
        case "makefile":
            return highlightMakefile(code)
        case "graphql":
            return highlightGraphql(code)
        case "diff":
            return highlightDiff(code)
        case "markdown":
            return highlightMarkdown(code)
        default:
            return escapeHtml(code)
    }
}
`
