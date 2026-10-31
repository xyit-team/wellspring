import assert from "node:assert/strict"
import { test } from "node:test"

import { extractSymbols } from "../plugins/wellspring-code/src/symbols.ts"

test("符号解析：TS/JS 导出与声明", () => {
    const code = [
        "export function alpha() {",
        "    return 1",
        "}",
        "export class Beta {}",
        "const gamma = 1",
        "interface Delta {}",
        "",
    ].join("\n")
    assert.deepEqual(
        extractSymbols(code, "typescript").map((symbol) => [symbol.name, symbol.kind, symbol.line]),
        [
            ["alpha", "function", 1],
            ["Beta", "class", 4],
            ["gamma", "symbol", 5],
            ["Delta", "class", 6],
        ],
    )
    // 缩进进入 depth，最多 4
    assert.equal(extractSymbols("    function nested() {}", "javascript")[0]?.depth, 2)
    assert.equal(
        extractSymbols("                    function deep() {}", "javascript")[0]?.depth,
        4,
    )
})

test("符号解析：Python / Go / Rust / Java", () => {
    assert.deepEqual(
        extractSymbols("class A:\n    def run(self):\n        pass\n", "python").map((symbol) => [
            symbol.name,
            symbol.kind,
        ]),
        [
            ["A", "class"],
            ["run", "function"],
        ],
    )
    assert.deepEqual(
        extractSymbols("func main() {\n}\ntype Foo struct{}", "go").map((symbol) => [
            symbol.name,
            symbol.kind,
        ]),
        [
            ["main", "function"],
            ["Foo", "type"],
        ],
    )
    assert.deepEqual(
        extractSymbols("pub fn run() {}\nstruct Item;", "rust").map((symbol) => symbol.name),
        ["run", "Item"],
    )
    assert.deepEqual(
        extractSymbols("public class Demo {\n    void run() {}\n}", "java").map(
            (symbol) => symbol.name,
        ),
        ["Demo", "run"],
    )
})

test("符号解析：CSS / Markdown / HTML / YAML", () => {
    assert.deepEqual(
        extractSymbols(".card {\n  color: red;\n}\n#main {\n}", "css").map((symbol) => [
            symbol.name,
            symbol.kind,
        ]),
        [
            [".card", "selector"],
            ["#main", "selector"],
        ],
    )
    assert.deepEqual(
        extractSymbols("# 标题\n\n正文\n## 小节\n", "markdown").map((symbol) => [
            symbol.name,
            symbol.kind,
        ]),
        [
            ["标题", "heading"],
            ["小节", "heading"],
        ],
    )
    assert.deepEqual(
        extractSymbols('<div id="app"></div>', "html").map((symbol) => [symbol.name, symbol.kind]),
        [["app", "tag"]],
    )
    assert.deepEqual(
        extractSymbols("name: demo\nserver:\n  port: 1", "yaml").map((symbol) => symbol.name),
        ["name", "server", "port"],
    )
})

test("符号解析：不支持的语言与空内容", () => {
    assert.deepEqual(extractSymbols("{}", "json"), [])
    assert.deepEqual(extractSymbols("", "typescript"), [])
    assert.deepEqual(extractSymbols("x", "plaintext"), [])
})
