/*
 * native/seatbelt-run/src/main.c 的静态约束
 *
 * 断言不编译 C，只钉住 loader 的契约：目标命令用 execve 以绝对路径执行
 * 按名字解析的 exec 变体会把「执行哪个文件」的决定权交回 PATH
 * PATH 里可能有模型可写的工作区目录
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const source = readFileSync(
    join(import.meta.dirname, "..", "native", "seatbelt-run", "src", "main.c"),
    "utf8",
)

// 去掉注释：注释文字会触发断言
function code(): string {
    return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "")
}

test("用 execve 执行，且只有 execve", () => {
    const body = code()
    assert.match(body, /execve\(/)
    for (const forbidden of ["execvp(", "execlp(", "execvpe(", "system(", "popen("]) {
        assert.ok(!body.includes(forbidden), `不得出现 ${forbidden}：它会按 PATH 解析`)
    }
})

test("拒绝非绝对路径的目标命令", () => {
    const body = code()
    assert.match(body, /target\[0\] != '\/'/, "必须有绝对路径检查")
})

test("从 libsandbox 动态取 sandbox_init，不链私有框架", () => {
    const body = code()
    assert.match(body, /dlopen\(/)
    assert.match(body, /dlsym\(/)
    assert.match(body, /sandbox_init/)
    assert.match(body, /libsandbox\.1\.dylib/)
})

test("自检在子进程里施加 profile，不污染自身", () => {
    const body = code()
    assert.match(body, /fork\(\)/, "self-test 必须 fork")
    assert.match(body, /waitpid\(/)
    assert.match(body, /--self-test/)
})

test("不使用 shell、不拼接命令行", () => {
    assert.ok(!code().includes("/bin/sh"))
    assert.ok(!source.includes("strcat"), "配置文件与命令都不做字符串拼接")
})
