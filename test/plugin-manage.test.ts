import assert from "node:assert/strict"
import { crc32, deflateRawSync } from "node:zlib"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import type { HostPlugin } from "../src/api/host/host.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { createHostPluginManager } from "../src/plugin/manage.ts"
import { readPluginState, setPluginEnabled } from "../src/plugin/state.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-manage-test-"))
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

function hostPlugin(
    id: string,
    deps: readonly string[] = [],
    status: "ok" | "failed" = "ok",
    version = "1.0.0",
): HostPlugin {
    return {
        id,
        name: id,
        version,
        deps,
        commands: [],
        getStatus: () => status,
    }
}

async function writePlugin(dirName: string, id: string, version = "1.0.0"): Promise<void> {
    const dir = join(paths().dataDir, "plugins", dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "index.ts"), "export function setup() { return null }\n", "utf8")
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: id, version }), "utf8")
}

/** 最小 store 模式 zip，够 readZip 解析 */
function buildZip(files: Record<string, string>): Buffer {
    const localParts: Buffer[] = []
    const centralParts: Buffer[] = []
    let offset = 0
    for (const [name, text] of Object.entries(files)) {
        const nameBytes = Buffer.from(name, "utf8")
        const data = Buffer.from(text, "utf8")
        const checksum = crc32(data)
        const local = Buffer.alloc(30 + nameBytes.length)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0, 6)
        local.writeUInt16LE(0, 8)
        local.writeUInt32LE(checksum, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(nameBytes.length, 26)
        nameBytes.copy(local, 30)
        localParts.push(local, data)

        const central = Buffer.alloc(46 + nameBytes.length)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(0, 8)
        central.writeUInt16LE(0, 10)
        central.writeUInt32LE(checksum, 16)
        central.writeUInt32LE(data.length, 20)
        central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(nameBytes.length, 28)
        central.writeUInt32LE(offset, 42)
        nameBytes.copy(central, 46)
        centralParts.push(central)
        offset += local.length + data.length
    }
    const centralBuffer = Buffer.concat(centralParts)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(centralParts.length, 8)
    eocd.writeUInt16LE(centralParts.length, 10)
    eocd.writeUInt32LE(centralBuffer.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...localParts, centralBuffer, eocd])
}

function manager(
    plugins: readonly HostPlugin[],
    runtime?: {
        hotEnable(
            id: string,
        ): Promise<{ ok: boolean; id: string; changed?: boolean; error?: string }>
        hotDisable(
            id: string,
        ): Promise<{ ok: boolean; id: string; changed?: boolean; error?: string }>
        hotForget?(id: string): Promise<void>
    },
) {
    return createHostPluginManager({
        paths: paths(),
        logger: pino({ level: "silent" }),
        getHostPlugins: () => plugins,
        ...(runtime === undefined ? {} : { runtime }),
    })
}

test("插件管理：列表、启用/禁用与状态文件", async () => {
    await writePlugin("alpha", "alpha", "2.0.0")
    const service = manager([hostPlugin("alpha", [], "ok", "2.0.0")])
    const listed = await service.list()
    assert.deepEqual(
        listed.plugins.map((item) => [item.id, item.version, item.status, item.enabled]),
        [["alpha", "2.0.0", "ok", true]],
    )

    const disabled = await service.disable("alpha")
    assert.equal(disabled.ok, true)
    assert.equal(disabled.changed, true)
    assert.equal(disabled.restartRequired, true)
    assert.ok((await readPluginState(paths())).has("alpha"))
    assert.equal((await service.list()).plugins[0]?.status, "disabled")

    const enabled = await service.enable("alpha")
    assert.equal(enabled.ok, true)
    assert.equal(enabled.changed, true)
    assert.equal((await readPluginState(paths())).has("alpha"), false)
})

test("插件管理：允许禁用 wellspring-web，但禁止卸载", async () => {
    await writePlugin("wellspring-web", "wellspring-web")
    const service = manager([hostPlugin("wellspring-web")])

    const disabled = await service.disable("wellspring-web")
    assert.equal(disabled.ok, true)
    assert.equal(disabled.restartRequired, true)

    const removed = await service.remove("wellspring-web")
    assert.equal(removed.ok, false)
    assert.match(removed.error ?? "", /不能卸载 wellspring-web/)
    assert.ok((await readdir(join(paths().dataDir, "plugins"))).includes("wellspring-web"))
})

test("插件管理：依赖检查与卸载", async () => {
    await writePlugin("alpha", "alpha")
    await writePlugin("beta", "beta")
    const service = manager([hostPlugin("alpha"), hostPlugin("beta", ["alpha"])])

    const blocked = await service.remove("alpha")
    assert.equal(blocked.ok, false)
    assert.deepEqual(blocked.dependents, ["beta"])

    const removed = await service.remove("beta")
    assert.equal(removed.ok, true)
    assert.equal(removed.restartRequired, true)
    assert.equal((await readdir(join(paths().dataDir, "plugins"))).includes("beta"), false)
})

test("插件管理：从 zip 安装、覆盖与 wellspring-web 保护", async () => {
    await rm(join(paths().dataDir, "plugins", "wellspring-web"), { recursive: true, force: true })
    const service = manager([])
    const zip = buildZip({
        "package.json": JSON.stringify({ name: "zeta", version: "1.2.0" }),
        "index.ts": "export function setup() { return null }\n",
    }).toString("base64")

    const installed = await service.install({ filename: "zeta.zip", dataBase64: zip })
    assert.equal(installed.ok, true)
    assert.equal(installed.id, "zeta")
    assert.equal(installed.restartRequired, true)
    assert.equal(
        (await service.list()).plugins.find((item) => item.id === "zeta")?.status,
        "unknown",
    )

    const duplicate = await service.install({ filename: "zeta.zip", dataBase64: zip })
    assert.equal(duplicate.ok, false)

    const forced = await service.install({ filename: "zeta.zip", dataBase64: zip, force: true })
    assert.equal(forced.ok, true)

    const webZip = buildZip({
        "package.json": JSON.stringify({ name: "wellspring-web", version: "9.9.9" }),
        "index.ts": "export function setup() { return null }\n",
    }).toString("base64")
    const blocked = await service.install({ filename: "web.zip", dataBase64: webZip })
    assert.equal(blocked.ok, false)
    assert.equal(
        (await readdir(join(paths().dataDir, "plugins"))).includes("wellspring-web"),
        false,
    )

    const badName = await service.install({ filename: "zeta.tar", dataBase64: zip })
    assert.equal(badName.ok, false)
    const badData = await service.install({ filename: "zeta.zip", dataBase64: "!!!not-base64!!!" })
    assert.equal(badData.ok, false)
})

test("插件管理：状态文件与安装的插件名非法时拒绝", async () => {
    await setPluginEnabled("ghost", false, paths())
    const service = manager([])
    const listed = await service.list()
    assert.equal(
        listed.plugins.some((item) => item.id === "ghost"),
        false,
    )
})

test("插件管理：有热运行时时启用/禁用即时生效，wellspring-web 仍重启", async () => {
    await writePlugin("hot-a", "hot-a")
    await writePlugin("wellspring-web", "wellspring-web")
    const calls: string[] = []
    const service = manager([hostPlugin("hot-a"), hostPlugin("wellspring-web")], {
        async hotEnable(id) {
            calls.push("enable:" + id)
            return { ok: true, id: "hot-a", changed: true }
        },
        async hotDisable(id) {
            calls.push("disable:" + id)
            return { ok: true, id: "hot-a", changed: true }
        },
    })

    const disabled = await service.disable("hot-a")
    assert.equal(disabled.ok, true)
    assert.equal(disabled.hot, true)
    assert.equal(disabled.restartRequired, false)
    const enabled = await service.enable("hot-a")
    assert.equal(enabled.hot, true)
    assert.equal(enabled.restartRequired, false)
    assert.deepEqual(calls, ["disable:hot-a", "enable:hot-a"])

    await setPluginEnabled("wellspring-web", true, paths())
    const web = await service.disable("wellspring-web")
    assert.equal(web.ok, true)
    assert.equal(web.restartRequired, true)
    assert.equal(web.hot, undefined)
})

test("插件管理：热禁用被依赖时把依赖方带回", async () => {
    await writePlugin("alpha", "alpha")
    await writePlugin("beta", "beta")
    const service = manager([hostPlugin("alpha"), hostPlugin("beta", ["alpha"])], {
        async hotEnable(id) {
            return { ok: true, id }
        },
        async hotDisable(id) {
            return { ok: false, id, dependents: ["beta"], error: "插件被依赖：beta" }
        },
    })
    const blocked = await service.disable("alpha")
    assert.equal(blocked.ok, false)
    assert.equal(blocked.restartRequired, false)
    assert.deepEqual(blocked.dependents, ["beta"])
})

test("插件管理：有热运行时时，运行中的插件不能直接卸载", async () => {
    await writePlugin("running", "running")
    const service = manager([hostPlugin("running")], {
        async hotEnable(id) {
            return { ok: true, id }
        },
        async hotDisable(id) {
            return { ok: true, id, changed: true }
        },
    })
    const blocked = await service.remove("running")
    assert.equal(blocked.ok, false)
    assert.match(blocked.error ?? "", /先禁用/)
})

test("插件管理：卸载禁用插件后清掉运行时占位", async () => {
    await writePlugin("idle", "idle")
    await setPluginEnabled("idle", false, paths())
    const forgotten: string[] = []
    const service = manager([hostPlugin("idle")], {
        async hotEnable(id) {
            return { ok: true, id }
        },
        async hotDisable(id) {
            return { ok: true, id, changed: true }
        },
        async hotForget(id) {
            forgotten.push(id)
        },
    })
    const removed = await service.remove("idle")
    assert.equal(removed.ok, true)
    assert.equal(removed.hot, true)
    assert.equal(removed.restartRequired, false)
    assert.deepEqual(forgotten, ["idle"])
})
