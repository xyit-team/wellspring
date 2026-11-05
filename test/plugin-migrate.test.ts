import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"

import pino from "pino"

import type { ResolvedPaths } from "../src/platform/path.ts"
import { createHostMigrator } from "../src/plugin/migrate.ts"
import { readPluginState, setPluginEnabled } from "../src/plugin/state.ts"

const FROM = "wellspring-core"
const TO = "@etheros/wellspring-core"

/** 每个用例一个独立 HOME，避免互相污染 */
const roots: string[] = []

afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
})

async function freshPaths(): Promise<ResolvedPaths> {
    const root = await mkdtemp(join(tmpdir(), "wellspring-migrate-test-"))
    roots.push(root)
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

function migrator(paths: ResolvedPaths) {
    return createHostMigrator({ paths, logger: pino({ level: "silent" }) })
}

/** 按真实布局铺旧 id 的数据：plugin-data、配置、旧插件目录 */
async function seedOldId(paths: ResolvedPaths): Promise<void> {
    const trashDir = join(paths.dataDir, "plugin-data", FROM, "trash", "20260101-000000")
    await mkdir(join(trashDir, "files"), { recursive: true })
    await writeFile(join(trashDir, "meta.json"), JSON.stringify({ at: "/a.txt" }), "utf8")
    await writeFile(join(trashDir, "files", "a.txt"), "hello", "utf8")

    await mkdir(join(paths.configDir, "plugins"), { recursive: true })
    await writeFile(
        join(paths.configDir, "plugins", `${FROM}.json`),
        JSON.stringify({ theme: "dark" }),
        "utf8",
    )

    const pluginDir = join(paths.dataDir, "plugins", FROM)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: FROM }), "utf8")

    await setPluginEnabled(FROM, false, paths)
}

async function exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null
}

test("迁移：数据目录、配置与禁用状态一起搬到新 id", async () => {
    const paths = await freshPaths()
    await seedOldId(paths)
    const result = await migrator(paths).movePluginData({ from: FROM, to: TO })

    assert.equal(result.ok, true, result.error ?? "")
    assert.ok(result.steps.some((step) => step.includes("迁移插件数据")))
    assert.ok(result.steps.some((step) => step.includes("迁移插件配置")))
    assert.ok(result.steps.some((step) => step.includes("清掉旧 id 的禁用标记")))

    const trash = join(paths.dataDir, "plugin-data", TO, "trash", "20260101-000000")
    assert.equal(await readFile(join(trash, "files", "a.txt"), "utf8"), "hello")
    assert.equal(
        await exists(join(paths.dataDir, "plugin-data", FROM)),
        false,
        "旧数据目录应该已经搬走",
    )

    const newConfig = JSON.parse(
        await readFile(join(paths.configDir, "plugins", `${TO}.json`), "utf8"),
    ) as { theme?: string }
    assert.equal(newConfig.theme, "dark")
    assert.equal(await exists(join(paths.configDir, "plugins", `${FROM}.json`)), false)

    const disabled = await readPluginState(paths)
    assert.equal(disabled.has(FROM), false, "旧 id 的禁用标记应该清掉")
    assert.equal(disabled.has(TO), false, "新 id 不继承禁用状态（升级后应保持启用）")
})

test("迁移：目标只有宿主预建的 tmp/ 时照样搬，不算冲突", async () => {
    const paths = await freshPaths()
    await seedOldId(paths)
    /* 插件加载时宿主会建 <plugin-data>/<id>/tmp */
    await mkdir(join(paths.dataDir, "plugin-data", TO, "tmp"), { recursive: true })

    const result = await migrator(paths).movePluginData({ from: FROM, to: TO })
    assert.equal(result.ok, true, result.error ?? "")
    assert.ok(result.steps.some((step) => step.includes("清掉已有的新数据目录")))
    assert.equal(
        await readFile(
            join(paths.dataDir, "plugin-data", TO, "trash", "20260101-000000", "files", "a.txt"),
            "utf8",
        ),
        "hello",
    )
})

test("迁移：目标已有真实数据时拒绝，除非 force", async () => {
    const paths = await freshPaths()
    await seedOldId(paths)
    const toData = join(paths.dataDir, "plugin-data", TO)
    await mkdir(join(toData, "trash"), { recursive: true })
    await writeFile(join(toData, "trash", "keep.txt"), "新数据", "utf8")

    const refused = await migrator(paths).movePluginData({ from: FROM, to: TO })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? "", /已经有内容/)
    /* 拒绝时两边都不能动 */
    assert.equal(
        await readFile(
            join(paths.dataDir, "plugin-data", FROM, "trash", "20260101-000000", "files", "a.txt"),
            "utf8",
        ),
        "hello",
    )
    assert.equal(await readFile(join(toData, "trash", "keep.txt"), "utf8"), "新数据")

    const forced = await migrator(paths).movePluginData({ from: FROM, to: TO, force: true })
    assert.equal(forced.ok, true, forced.error ?? "")
    assert.deepEqual((await readdir(toData)).sort(), ["trash"])
    assert.equal(
        await readFile(join(toData, "trash", "keep.txt"), "utf8").catch(() => "gone"),
        "gone",
        "force 时旧目标内容应被覆盖",
    )
})

test("迁移：removeOld 删掉旧插件目录", async () => {
    const paths = await freshPaths()
    await seedOldId(paths)
    const oldDir = join(paths.dataDir, "plugins", FROM)
    assert.equal(await exists(oldDir), true)

    const result = await migrator(paths).movePluginData({ from: FROM, to: TO, removeOld: true })
    assert.equal(result.ok, true, result.error ?? "")
    assert.ok(result.steps.some((step) => step.includes("删除旧插件目录")))
    assert.equal(await exists(oldDir), false)
})

test("迁移：不删旧目录时给出后续命令，不当作失败", async () => {
    const paths = await freshPaths()
    await seedOldId(paths)
    const oldDir = join(paths.dataDir, "plugins", FROM)

    const result = await migrator(paths).movePluginData({ from: FROM, to: TO })
    assert.equal(result.ok, true, result.error ?? "")
    assert.ok(result.skipped.some((item) => item.includes(`wellspring plugin remove ${FROM}`)))
    assert.equal(await exists(oldDir), true, "没加 removeOld 就不该删")
})

test("迁移：旧数据不存在只是跳过，不算失败", async () => {
    const paths = await freshPaths()
    const result = await migrator(paths).movePluginData({ from: FROM, to: TO })
    assert.equal(result.ok, true, result.error ?? "")
    assert.deepEqual(result.steps, [])
    assert.equal(result.skipped.length >= 1, true)
})

test("迁移：非法 id 与相同 id 都拒绝", async () => {
    const paths = await freshPaths()
    const same = await migrator(paths).movePluginData({ from: FROM, to: FROM })
    assert.equal(same.ok, false)
    assert.match(same.error ?? "", /相同/)

    const bad = await migrator(paths).movePluginData({ from: "../etc", to: TO })
    assert.equal(bad.ok, false)
    assert.match(bad.error ?? "", /不合法/)
})
