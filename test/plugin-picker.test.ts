import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import type { ResolvedPaths } from "../src/platform/path.ts"
import {
    encodeWindowsCommand,
    parseWindowsPickerOutput,
    WINDOWS_PICKER_SCRIPT,
} from "../src/plugin/agent-service.ts"
import { removePlugin } from "../src/plugin/loader.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-picker-test-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function paths(): ResolvedPaths {
    return {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

test("Windows 选择框：按标记解析选中的路径", () => {
    const outcome = parseWindowsPickerOutput("PICKED D:\\工作 目录\\项目\n")
    assert.deepEqual(outcome, { kind: "picked", path: "D:\\工作 目录\\项目" })
})

test("Windows 选择框：取消与出错分开报", () => {
    assert.deepEqual(parseWindowsPickerOutput("CANCELLED\n"), { kind: "cancelled" })
    const failed = parseWindowsPickerOutput("ERROR 找不到类型 [System.Windows.Forms.Form]\n")
    assert.equal(failed.kind, "error")
    assert.match(failed.kind === "error" ? failed.detail : "", /找不到类型/)
})

test("Windows 选择框：没有标记就是没跑起来，不能当成用户取消", () => {
    const outcome = parseWindowsPickerOutput("")
    assert.equal(outcome.kind, "error")
    const junk = parseWindowsPickerOutput("Some random PowerShell banner\n")
    assert.equal(junk.kind, "error")
})

test("Windows 选择框：脚本走 UTF-8 输出、置顶父窗口与三种标记", () => {
    assert.match(
        WINDOWS_PICKER_SCRIPT,
        /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/,
    )
    assert.match(WINDOWS_PICKER_SCRIPT, /TopMost = \$true/)
    assert.match(WINDOWS_PICKER_SCRIPT, /ShowDialog\(\$owner\)/)
    assert.match(WINDOWS_PICKER_SCRIPT, /'PICKED '/)
    assert.match(WINDOWS_PICKER_SCRIPT, /'CANCELLED'/)
    assert.match(WINDOWS_PICKER_SCRIPT, /'ERROR '/)
    // 中文标题内嵌脚本，经 -EncodedCommand 传入，不受代码页影响
    assert.match(WINDOWS_PICKER_SCRIPT, /选择工作区文件夹/)
})

test("Windows 选择框：-EncodedCommand 用 UTF-16LE 编码，中文原样还原", () => {
    const encoded = encodeWindowsCommand(WINDOWS_PICKER_SCRIPT)
    assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), WINDOWS_PICKER_SCRIPT)
})

test("卸载插件：不存在的插件要报错，不能打印「已删除」", async () => {
    await mkdir(join(paths().dataDir, "plugins"), { recursive: true })
    await assert.rejects(() => removePlugin("never-installed", paths()), /插件不存在/)
})

test("卸载插件：真删掉目录，删完再看确实不在了", async () => {
    const dir = join(paths().dataDir, "plugins", "alpha")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "alpha" }), "utf8")
    await removePlugin("alpha", paths())
    await assert.rejects(
        () => removePlugin("alpha", paths()),
        /插件不存在/,
        "删过一次之后第二次必须报不存在",
    )
})
