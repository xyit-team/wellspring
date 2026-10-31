import assert from "node:assert/strict"
import { test } from "node:test"

import { ANALYSIS_JS } from "../plugins/wellspring-code/src/assets/analysis.ts"

interface Diagnostic {
    readonly line: number
    readonly column: number
    readonly endLine?: number
    readonly endColumn?: number
    readonly severity: string
    readonly message: string
}

const helpers = new Function(
    ANALYSIS_JS + "\nreturn { analyzeSyntax: analyzeSyntax, bracketMatchAt: bracketMatchAt }",
)() as {
    analyzeSyntax: (code: string, language: string) => Diagnostic[]
    bracketMatchAt: (
        code: string,
        caret: number,
        language: string,
    ) => { open: number; close: number } | null
}

/** 只关心行列与消息，避免断言被可选字段干扰 */
function shape(items: Diagnostic[]): Array<[number, number, string]> {
    return items.map((item) => [item.line, item.column, item.message])
}

test("语法分析：括号配平与字符串/注释闭合", () => {
    assert.deepEqual(helpers.analyzeSyntax("const a = f(1) + [2] + {b: 3}", "typescript"), [])
    assert.deepEqual(shape(helpers.analyzeSyntax("function f() { return 1", "typescript")), [
        [1, 14, "{ 没有闭合"],
    ])
    const mismatched = helpers.analyzeSyntax("f([1)]", "javascript")
    assert.equal(mismatched.length, 2)
    assert.match(mismatched[0]?.message ?? "", /^括号不匹配：应为 \(，这里是 \)/)
    assert.match(mismatched[1]?.message ?? "", /^括号不匹配：应为 \[，这里是 \]/)
    assert.deepEqual(shape(helpers.analyzeSyntax("const a = 'abc", "typescript")), [
        [1, 11, "字符串没有闭合"],
    ])
    assert.deepEqual(shape(helpers.analyzeSyntax("/* 未闭合", "javascript")), [
        [1, 1, "注释没有闭合"],
    ])
    // 行注释与字符串里的括号不参与配平
    assert.deepEqual(helpers.analyzeSyntax("// (\nconst a = 1", "javascript"), [])
    assert.deepEqual(helpers.analyzeSyntax("const s = '([{'\nconst t = \"(\"", "typescript"), [])
    // 模板字符串里的花括号不算代码结构
    assert.deepEqual(helpers.analyzeSyntax("const t = `a { b`", "javascript"), [])
})

test("语法分析：Python 三引号与 Shell 注释", () => {
    assert.deepEqual(helpers.analyzeSyntax("x = '''a\nb'''\ny = 1", "python"), [])
    assert.deepEqual(shape(helpers.analyzeSyntax("x = '''abc", "python")), [
        [1, 5, "字符串没有闭合"],
    ])
    assert.deepEqual(helpers.analyzeSyntax("# ([{\necho ok", "shell"), [])
    assert.deepEqual(shape(helpers.analyzeSyntax("def f():\n    return a)", "python")), [
        [2, 13, "多余的 )"],
    ])
})

test("语法分析：JSON 与 CSS", () => {
    assert.deepEqual(helpers.analyzeSyntax('{"a": [1, 2]}', "json"), [])
    const broken = helpers.analyzeSyntax('{"a": }', "json")
    assert.equal(broken.length, 1)
    assert.match(broken[0]?.message ?? "", /JSON 语法错误/)
    assert.deepEqual(shape(helpers.analyzeSyntax('{"a": 1', "json")), [[1, 1, "{ 没有闭合"]])
    assert.deepEqual(shape(helpers.analyzeSyntax("a { color: red", "css")), [[1, 3, "{ 没有闭合"]])
})

test("语法分析：未支持语言与大文件直接跳过", () => {
    assert.deepEqual(helpers.analyzeSyntax("# 标题\n\n正文 (」", "markdown"), [])
    assert.deepEqual(helpers.analyzeSyntax("x", "plaintext"), [])
    assert.deepEqual(helpers.analyzeSyntax("(".repeat(400001), "typescript"), [])
})

test("括号配对：光标相邻的括号返回配对位置", () => {
    const code = "function f(a) { return a }"
    assert.deepEqual(helpers.bracketMatchAt(code, 11, "typescript"), { open: 10, close: 12 })
    assert.deepEqual(helpers.bracketMatchAt(code, 13, "typescript"), { open: 10, close: 12 })
    // 光标不在括号旁时没有配对
    assert.equal(helpers.bracketMatchAt(code, 2, "typescript"), null)
    // 字符串/注释/模板里的括号不参与匹配
    assert.equal(helpers.bracketMatchAt('f("(") + g()', 3, "typescript"), null)
    assert.equal(helpers.bracketMatchAt("// (\n)", 5, "javascript"), null)
    assert.equal(helpers.bracketMatchAt("const t = `a { b`", 15, "javascript"), null)
    // 没有配对的括号返回 null
    assert.equal(helpers.bracketMatchAt("f(", 2, "javascript"), null)
    assert.equal(helpers.bracketMatchAt("x".repeat(400001) + "(", 400001, "javascript"), null)
})
