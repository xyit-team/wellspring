/*
 * 宿主网络配置服务：读写 app-setting.json 的 network.proxy。
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { CONFIG_CODES, invalidCode } from "../src/config/codes.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { saveSettings } from "../src/config/loader.ts"
import { createHostNetworkService } from "../src/plugin/network-service.ts"

let root = ""
let settingsFile = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-network-service-"))
    await mkdir(join(root, "config"), { recursive: true })
    settingsFile = join(root, "config", "app-setting.json")
    const seeded = {
        ...DEFAULT_SETTINGS,
        openai: { ...DEFAULT_SETTINGS.openai, baseUrl: "https://api.example.com/v1" },
    }
    const saved = await saveSettings(seeded, settingsFile)
    assert.equal(saved.isSuccess(), true)
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

function service() {
    return createHostNetworkService({ settings: DEFAULT_SETTINGS, settingsFile })
}

async function readProxy(): Promise<unknown> {
    const parsed = JSON.parse(await readFile(settingsFile, "utf8")) as {
        network?: { proxy?: unknown }
        openai?: { baseUrl?: unknown }
    }
    return parsed
}

test("初始状态为直连", async () => {
    const state = await service().state()
    assert.deepEqual(state, { proxy: null })
})

test("保存 HTTP 代理并保留其它配置", async () => {
    const result = await service().saveProxy({
        url: "http://127.0.0.1:7890",
        noProxy: ["localhost", " 127.0.0.1 ", "localhost", ""],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.state.proxy, {
        type: "http",
        url: "http://127.0.0.1:7890",
        noProxy: ["localhost", "127.0.0.1"],
    })

    const state = await service().state()
    assert.deepEqual(state.proxy, result.state.proxy)

    const stored = (await readProxy()) as {
        network: { proxy: unknown }
        openai: { baseUrl: string }
    }
    assert.deepEqual(stored.network.proxy, result.state.proxy)
    assert.equal(stored.openai.baseUrl, "https://api.example.com/v1", "其它配置原样保留")
})

test("留空保存等于改回直连", async () => {
    await service().saveProxy({ url: "http://127.0.0.1:7890" })
    const cleared = await service().saveProxy({ url: "" })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.state.proxy, null)
    const stored = (await readProxy()) as { network: { proxy: unknown } }
    assert.equal(stored.network.proxy, null)
})

test("非法代理地址不落盘", async () => {
    await service().saveProxy({ url: "http://127.0.0.1:7890" })
    const before = await readFile(settingsFile, "utf8")
    for (const url of ["127.0.0.1:7890", "ftp://example.com", "socks5://127.0.0.1:1080"]) {
        const result = await service().saveProxy({ url })
        assert.equal(result.ok, false, url)
        assert.equal(result.code, invalidCode("network.proxy.url"), url)
        assert.equal(result.state.proxy?.url, "http://127.0.0.1:7890", "失败时返回当前配置")
    }
    assert.equal(await readFile(settingsFile, "utf8"), before, "校验失败不写文件")
})

test("配置文件写不进去时返回失败", async () => {
    // 用一个目录冒充配置文件：读取/写入都会失败
    const dirAsFile = join(root, "config", "dir-as-file")
    await mkdir(dirAsFile, { recursive: true })
    const target = createHostNetworkService({
        settings: DEFAULT_SETTINGS,
        settingsFile: dirAsFile,
    })
    const result = await target.saveProxy({ url: "http://127.0.0.1:7890" })
    assert.equal(result.ok, false)
    assert.equal(result.code, CONFIG_CODES.writeFailed)
    assert.deepEqual(result.state, { proxy: null })
})
