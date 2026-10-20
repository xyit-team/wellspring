import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import {
    ensureDir,
    ensureDirs,
    isNotFound,
    moveAside,
    readJsonIfExists,
    readTextIfExists,
    timeStamp,
    writeJsonAtomic,
    writeTextAtomic,
} from "../src/platform/file.ts"
import { detectPlatform } from "../src/platform/os.ts"
import {
    APP_DIR_NAME,
    defaultRoots,
    describePaths,
    getPaths,
    initPaths,
    resetPaths,
} from "../src/platform/path.ts"

test("detectPlatform 归一化 Node 平台", () => {
    assert.equal(detectPlatform("win32", {}), "windows")
    assert.equal(detectPlatform("darwin", {}), "macos")
    assert.equal(detectPlatform("linux", {}), "linux")
    assert.equal(detectPlatform("android", {}), "android")
    // Termux 等用户态 Node 报告 linux，靠 Android 环境变量识别
    assert.equal(detectPlatform("linux", { TERMUX_VERSION: "0.118" }), "android")
    assert.equal(detectPlatform("linux", { ANDROID_DATA: "/data" }), "android")
    // WSL 仍是 linux
    assert.equal(detectPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu" }), "linux")
})

test("defaultRoots windows", () => {
    const roots = defaultRoots(
        "windows",
        { APPDATA: "/roaming", LOCALAPPDATA: "/local" },
        "/home/u",
    )
    assert.deepEqual(roots, {
        configDir: join("/roaming", APP_DIR_NAME),
        dataDir: join("/local", APP_DIR_NAME),
        cacheDir: join("/local", APP_DIR_NAME, "cache"),
        logDir: join("/local", APP_DIR_NAME, "logs"),
    })
})

test("defaultRoots windows 无环境变量时回落用户目录", () => {
    const roots = defaultRoots("windows", {}, "/home/u")
    assert.equal(roots.configDir, join("/home/u", "AppData", "Roaming", APP_DIR_NAME))
    assert.equal(roots.dataDir, join("/home/u", "AppData", "Local", APP_DIR_NAME))
})

test("defaultRoots macos", () => {
    const roots = defaultRoots("macos", {}, "/Users/u")
    assert.deepEqual(roots, {
        configDir: join("/Users/u", "Library", "Application Support", APP_DIR_NAME),
        dataDir: join("/Users/u", "Library", "Application Support", APP_DIR_NAME),
        cacheDir: join("/Users/u", "Library", "Caches", APP_DIR_NAME),
        logDir: join("/Users/u", "Library", "Logs", APP_DIR_NAME),
    })
})

test("defaultRoots linux 遵循 XDG 并提供回退", () => {
    const custom = defaultRoots(
        "linux",
        {
            XDG_CONFIG_HOME: "/xdg/config",
            XDG_DATA_HOME: "/xdg/data",
            XDG_CACHE_HOME: "/xdg/cache",
            XDG_STATE_HOME: "/xdg/state",
        },
        "/home/u",
    )
    assert.deepEqual(custom, {
        configDir: join("/xdg/config", APP_DIR_NAME),
        dataDir: join("/xdg/data", APP_DIR_NAME),
        cacheDir: join("/xdg/cache", APP_DIR_NAME),
        logDir: join("/xdg/state", APP_DIR_NAME, "logs"),
    })

    const fallback = defaultRoots("linux", {}, "/home/u")
    assert.equal(fallback.configDir, join("/home/u", ".config", APP_DIR_NAME))
    assert.equal(fallback.dataDir, join("/home/u", ".local", "share", APP_DIR_NAME))
    assert.equal(fallback.cacheDir, join("/home/u", ".cache", APP_DIR_NAME))
    assert.equal(fallback.logDir, join("/home/u", ".local", "state", APP_DIR_NAME, "logs"))
})

test("defaultRoots android 应用沙箱使用 HOME", () => {
    const sandbox = "/data/user/0/com.example.wellspring/files"
    const roots = defaultRoots("android", { HOME: sandbox }, "/tmp/home")
    assert.deepEqual(roots, {
        configDir: join(sandbox, "config"),
        dataDir: join(sandbox, "data"),
        cacheDir: join(sandbox, "cache"),
        logDir: join(sandbox, "logs"),
    })
})

test("defaultRoots android Termux 沿用 XDG", () => {
    const home = "/data/data/com.termux/files/home"
    const roots = defaultRoots("android", { HOME: home, TERMUX_VERSION: "0.118" }, home)
    assert.equal(roots.configDir, join(home, ".config", APP_DIR_NAME))
    assert.equal(roots.dataDir, join(home, ".local", "share", APP_DIR_NAME))
})

test("initPaths 覆盖 > 环境变量 > 便携模式", () => {
    const paths = initPaths(
        { configDir: "/cli/config" },
        {
            HOME: "/home/u",
            WELLSPRING_HOME: "/srv/wellspring",
            WELLSPRING_DATA_DIR: "/srv/data",
        },
    )
    assert.equal(paths.configDir, "/cli/config")
    assert.equal(paths.sources.configDir, "override")
    assert.equal(paths.dataDir, "/srv/data")
    assert.equal(paths.sources.dataDir, "env")
    assert.equal(paths.cacheDir, join("/srv/wellspring", "cache"))
    assert.equal(paths.sources.cacheDir, "portable-home")
})

test("initPaths 展开 ~ 与相对路径", () => {
    const env = { HOME: "/home/u" }
    assert.equal(initPaths({ configDir: "~/cfg" }, env).configDir, join("/home/u", "cfg"))
    assert.equal(
        initPaths({ dataDir: "rel/data" }, env).dataDir,
        join(process.cwd(), "rel", "data"),
    )
})

test("getPaths 缓存，resetPaths 后重新解析", () => {
    resetPaths()
    initPaths({ configDir: "/cached/config" }, { HOME: "/home/u" })
    assert.equal(getPaths().configDir, "/cached/config")
    resetPaths()
    assert.notEqual(getPaths().configDir, "/cached/config")
})

test("describePaths 标注来源", () => {
    const paths = initPaths({ logDir: "/logs" }, { HOME: "/home/u" })
    const text = describePaths(paths)
    assert.match(text, /config .* \(os-default\)/)
    assert.match(text, /log .*\/logs {2}\(override\)/)
})

test("readTextIfExists 缺失返回 null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wellspring-read-"))
    try {
        assert.equal(await readTextIfExists(join(dir, "missing.txt")), null)
        assert.equal(await readJsonIfExists(join(dir, "missing.json")), null)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test("isNotFound 仅识别 ENOENT", () => {
    assert.equal(isNotFound({ code: "ENOENT" }), true)
    assert.equal(isNotFound({ code: "EACCES" }), false)
    assert.equal(isNotFound(null), false)
})

test("timeStamp 格式", () => {
    assert.equal(timeStamp(new Date(2026, 8, 19, 1, 30, 45)), "20260919-013045")
})

let workDir = ""
before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "wellspring-file-"))
})
after(() => rm(workDir, { recursive: true, force: true }))

test("文件落盘", async (t) => {
    const dir = workDir

    await t.test("writeTextAtomic 创建目录并写入", async () => {
        const file = join(dir, "nested", "a.txt")
        await writeTextAtomic(file, "hello")
        assert.equal(await readTextIfExists(file), "hello")
    })

    await t.test("writeJsonAtomic 4 空格缩进 + 末尾换行", async () => {
        const file = join(dir, "b.json")
        const value = { logger: { level: "info" } }
        await writeJsonAtomic(file, value)
        assert.equal(await readTextIfExists(file), `${JSON.stringify(value, null, 4)}\n`)
        assert.deepEqual(await readJsonIfExists(file), value)
    })

    await t.test("moveAside 重命名损坏文件", async () => {
        const file = join(dir, "c.txt")
        await writeTextAtomic(file, "broken")
        const moved = await moveAside(file, "corrupt-1")
        assert.equal(moved, `${file}.corrupt-1`)
        assert.equal(await readTextIfExists(file), null)
        assert.equal(await readTextIfExists(moved), "broken")
    })

    await t.test("ensureDirs 创建四个根目录", async () => {
        const roots = {
            configDir: join(dir, "roots", "config"),
            dataDir: join(dir, "roots", "data"),
            cacheDir: join(dir, "roots", "cache"),
            logDir: join(dir, "roots", "logs"),
        }
        await ensureDirs(roots)
        for (const path of Object.values(roots)) {
            assert.equal((await stat(path)).isDirectory(), true)
        }
    })

    await t.test("ensureDir 幂等", async () => {
        const path = join(dir, "idempotent")
        await ensureDir(path)
        await ensureDir(path)
        assert.equal((await stat(path)).isDirectory(), true)
    })
})
