/*
 * 插件版本：发版校验脚本的归并逻辑，以及官方插件两处版本声明是否一致
 *
 * 版本以 plugins/<name>/package.json 为准；setup() 里写的 version 由宿主覆盖，
 * 这里守住两者相等，读源码时不会看到两个数字
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import {
    findVersionViolations,
    groupChangedPlugins,
    pluginDirOf,
    requiresVersionBump,
} from "../scripts/check-plugin-versions.mjs"

const projectRoot = join(import.meta.dirname, "..")

const OFFICIAL_PLUGINS = ["wellspring-code", "wellspring-http", "wellspring-web"]

test("pluginDirOf：只认 plugins/<name>/ 下的文件", () => {
    assert.equal(pluginDirOf("plugins/a/index.ts"), "plugins/a")
    assert.equal(pluginDirOf("plugins/a/src/deep/x.ts"), "plugins/a")
    assert.equal(pluginDirOf("plugins/a"), null)
    assert.equal(pluginDirOf("src/index.ts"), null)
    assert.equal(pluginDirOf("pluginsx/a/b.ts"), null)
})

test("requiresVersionBump：只改 README 不算，改其他文件都要涨版本", () => {
    assert.equal(requiresVersionBump("plugins/a/index.ts"), true)
    assert.equal(requiresVersionBump("plugins/a/package.json"), true)
    assert.equal(requiresVersionBump("plugins/a/src/x.ts"), true)
    assert.equal(requiresVersionBump("plugins/a/README.md"), false)
    assert.equal(requiresVersionBump("src/sandbox/manager.ts"), false)
})

test("groupChangedPlugins：按插件归并，忽略插件外的路径与 README", () => {
    const grouped = groupChangedPlugins([
        "plugins/a/index.ts",
        "plugins/a/src/x.ts",
        "plugins/a/README.md",
        "plugins/b/index.ts",
        "src/index.ts",
    ])
    assert.deepEqual([...grouped.keys()].sort(), ["plugins/a", "plugins/b"])
    assert.deepEqual(grouped.get("plugins/a"), ["plugins/a/index.ts", "plugins/a/src/x.ts"])
    assert.deepEqual(grouped.get("plugins/b"), ["plugins/b/index.ts"])
})

test("findVersionViolations：版本没动就是违规，动了就放行", () => {
    const changed = new Map([["plugins/a", ["plugins/a/index.ts"]]])

    const unchanged = findVersionViolations({
        changed,
        versions: new Map([["plugins/a", "1.0.0"]]),
        baseVersions: new Map([["plugins/a", "1.0.0"]]),
    })
    assert.equal(unchanged.length, 1)
    assert.equal(unchanged[0].reason, "unchanged")

    const bumped = findVersionViolations({
        changed,
        versions: new Map([["plugins/a", "1.0.1"]]),
        baseVersions: new Map([["plugins/a", "1.0.0"]]),
    })
    assert.deepEqual(bumped, [])

    /* 基线里没有这个插件：等于新插件，但当前版本仍必须写出来 */
    const missing = findVersionViolations({
        changed,
        versions: new Map([["plugins/a", null]]),
        baseVersions: new Map([["plugins/a", null]]),
    })
    assert.equal(missing[0].reason, "missing")
})

test("插件被删除：不要求涨版本，也不算缺 version", () => {
    const changed = groupChangedPlugins(["plugins/gone/index.ts", "plugins/gone/package.json"])
    const violations = findVersionViolations({
        changed,
        /* versions 只含当前还在的插件；删掉的插件不会出现在这里 */
        versions: new Map(),
        baseVersions: new Map([["plugins/gone", "1.0.0"]]),
    })
    assert.deepEqual(violations, [])
})

test("官方插件：index.ts 里的 version 与 package.json 一致", () => {
    for (const id of OFFICIAL_PLUGINS) {
        const pkg = JSON.parse(
            readFileSync(join(projectRoot, "plugins", id, "package.json"), "utf8"),
        )
        const entry = readFileSync(join(projectRoot, "plugins", id, "index.ts"), "utf8")
        const match = /^\s+version: "([^"]+)",$/m.exec(entry)
        assert.ok(match !== null, `${id} 的 index.ts 没有 version 字段`)
        assert.equal(match[1], pkg.version, `${id} 两处版本不一致`)
    }
})
