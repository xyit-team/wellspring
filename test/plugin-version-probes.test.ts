import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import {
    checkPluginUpdates,
    clearVersionProbes,
    compareVersions,
    hasVersionProbe,
    readProbeValue,
    setVersionProbe,
    validateDownloadUrl,
    versionProbeIds,
} from "../src/plugin/version-probes.ts"

afterEach(() => {
    clearVersionProbes()
})

test("compareVersions：按段比数值，位数不同补 0", () => {
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0)
    assert.equal(compareVersions("1.2.4", "1.2.3"), 1)
    assert.equal(compareVersions("1.3.0", "1.2.9"), 1)
    assert.equal(compareVersions("2.0.0", "1.99.99"), 1)
    assert.equal(compareVersions("1.2", "1.2.0"), 0)
    assert.equal(compareVersions("1.2.0", "1.2"), 0)
    assert.equal(compareVersions("0.0.1", "0.1.0"), -1)
})

test("compareVersions：容忍 v 前缀与首尾空白", () => {
    assert.equal(compareVersions("v1.4.0", "1.3.10"), 1)
    assert.equal(compareVersions(" 1.4.0 ", "1.4.0"), 0)
})

test("compareVersions：正式版大于预发布，预发布按段比", () => {
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1)
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1)
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1)
    assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1, "数字段按数值而非字典序")
    assert.equal(compareVersions("1.0.0-rc", "1.0.0-rc.1"), -1)
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1)
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1, "字母段高于数字段")
})

test("compareVersions：解析不了的值按相等处理，不抛错", () => {
    assert.equal(compareVersions("", "1.0.0"), 0)
    assert.equal(compareVersions("latest", "1.0.0"), 0)
})

test("validateDownloadUrl：接受 http/https 的 .zip 与 .tar.gz", () => {
    assert.deepEqual(validateDownloadUrl("https://example.com/p/1.4.0.zip"), {
        url: "https://example.com/p/1.4.0.zip",
        error: null,
    })
    // 大小写不敏感
    assert.equal(validateDownloadUrl("https://example.com/A.ZIP").url, "https://example.com/A.ZIP")
    // 查询串不影响：签名链接常见形态
    assert.equal(
        validateDownloadUrl("https://example.com/a.zip?sig=xyz").url,
        "https://example.com/a.zip?sig=xyz",
    )
    // npm tarball 与 GitHub 归档两种写法都收
    assert.equal(
        validateDownloadUrl("https://registry.npmjs.org/w/-/w-1.4.0.tgz").url,
        "https://registry.npmjs.org/w/-/w-1.4.0.tgz",
    )
    assert.equal(
        validateDownloadUrl("https://example.com/w-1.4.0.tar.gz").url,
        "https://example.com/w-1.4.0.tar.gz",
    )
})

test("validateDownloadUrl：拒绝非归档与非 http 协议", () => {
    assert.match(
        String(validateDownloadUrl("https://example.com/a").error),
        /必须是 \.zip 或 \.tar\.gz/,
    )
    assert.match(String(validateDownloadUrl("https://example.com/a.rar").error), /必须是/)
    // 查询串里的扩展名不算
    assert.match(String(validateDownloadUrl("https://example.com/a?f=1.zip").error), /必须是/)
    assert.match(String(validateDownloadUrl("ftp://example.com/a.zip").error), /http\/https/)
    assert.match(String(validateDownloadUrl("file:///tmp/a.zip").error), /http\/https/)
    assert.match(String(validateDownloadUrl("不是地址").error), /合法 URL/)
    assert.match(String(validateDownloadUrl("   ").error), /为空/)
})

test("readProbeValue：接受裸字符串，下载地址为空", () => {
    assert.deepEqual(readProbeValue(" 1.4.0 "), {
        version: "1.4.0",
        downloadUrl: null,
        error: null,
    })
})

test("readProbeValue：接受版本 + zip 地址", () => {
    assert.deepEqual(readProbeValue({ version: "1.4.0", downloadUrl: "https://x/a.zip" }), {
        version: "1.4.0",
        downloadUrl: "https://x/a.zip",
        error: null,
    })
})

test("readProbeValue：非法下载地址保留版本但标记失败", () => {
    const outcome = readProbeValue({ version: "1.4.0", downloadUrl: "https://github.com/x/y" })
    assert.equal(outcome.version, "1.4.0")
    assert.equal(outcome.downloadUrl, null)
    assert.match(String(outcome.error), /必须是 \.zip/)
})

test("checkPluginUpdates：检查失败的项不算有更新，但保留 latest 供展示", async () => {
    setVersionProbe("broken-url", async () => ({
        version: "2.0.0",
        downloadUrl: "https://github.com/x/y",
    }))
    const checks = await checkPluginUpdates([{ id: "broken-url", version: "1.0.0" }])
    assert.equal(checks[0]?.latest, "2.0.0", "让用户看到新版确实发了")
    assert.equal(checks[0]?.updateAvailable, false, "但不能说可以更新")
    assert.notEqual(checks[0]?.error, null)
})

test("readProbeValue：缺版本号算失败", () => {
    assert.match(String(readProbeValue({}).error), /没有返回版本号/)
    assert.match(String(readProbeValue({ version: "   " }).error), /没有返回版本号/)
    assert.match(String(readProbeValue(null).error), /没有返回版本号/)
    assert.match(String(readProbeValue(123).error), /没有返回版本号/)
    assert.match(String(readProbeValue({ version: 1.4 }).error), /没有返回版本号/)
})

test("readProbeValue：下载地址类型不对算失败", () => {
    const outcome = readProbeValue({ version: "1.4.0", downloadUrl: 42 })
    assert.equal(outcome.version, "1.4.0")
    assert.match(String(outcome.error), /必须是字符串/)
})

test("setVersionProbe：重复注册报错", () => {
    setVersionProbe("a", async () => "1.0.0")
    assert.equal(hasVersionProbe("a"), true)
    assert.deepEqual(versionProbeIds(), ["a"])
    assert.throws(() => setVersionProbe("a", async () => "2.0.0"), /已经注册过/)
})

test("setVersionProbe：非函数直接拒绝", () => {
    assert.throws(() => setVersionProbe("a", "1.0.0" as never), TypeError)
})

test("checkPluginUpdates：比较探针结果与已装版本", async () => {
    setVersionProbe("new", async () => ({
        version: "1.4.0",
        downloadUrl: "https://x/1.4.0.zip",
    }))
    setVersionProbe("same", async () => "1.0.0")
    setVersionProbe("old", async () => "0.9.0")
    const checks = await checkPluginUpdates([
        { id: "new", version: "1.3.10" },
        { id: "same", version: "1.0.0" },
        { id: "old", version: "1.0.0" },
        { id: "none", version: "1.0.0" },
    ])
    assert.deepEqual(
        checks.map((check) => [check.id, check.latest, check.updateAvailable, check.hasProbe]),
        [
            ["new", "1.4.0", true, true],
            ["same", "1.0.0", false, true],
            ["old", "0.9.0", false, true],
            ["none", null, false, false],
        ],
    )
    assert.equal(checks[0]?.downloadUrl, "https://x/1.4.0.zip")
    assert.equal(checks[1]?.downloadUrl, null)
    assert.equal(checks[3]?.error, null, "没有探针不是错误")
})

test("checkPluginUpdates：单个探针抛错不影响其他插件", async () => {
    setVersionProbe("broken", async () => {
        throw new Error("registry 502")
    })
    setVersionProbe("fine", async () => "2.0.0")
    const checks = await checkPluginUpdates([
        { id: "broken", version: "1.0.0" },
        { id: "fine", version: "1.0.0" },
    ])
    assert.equal(checks[0]?.latest, null)
    assert.equal(checks[0]?.updateAvailable, false)
    assert.match(String(checks[0]?.error), /registry 502/)
    assert.equal(checks[1]?.latest, "2.0.0")
    assert.equal(checks[1]?.updateAvailable, true)
})

test("checkPluginUpdates：探针超时不挂住整次检查", async () => {
    setVersionProbe("slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        return "9.9.9"
    })
    const checks = await checkPluginUpdates([{ id: "slow", version: "1.0.0" }], {
        timeoutMs: 30,
    })
    assert.equal(checks[0]?.latest, null)
    assert.match(String(checks[0]?.error), /超时/)
})
