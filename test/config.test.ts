import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { CONFIG_CODES, invalidCode } from "../src/config/codes.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import {
    loadSettings,
    saveSettings,
    SETTING_FILE_NAME,
    settingsFile,
} from "../src/config/loader.ts"
import { type AppSetting } from "../src/config/types.ts"
import { validateSettings } from "../src/config/validate.ts"
import {
    ensureDir,
    readTextIfExists,
    writeJsonAtomic,
    writeTextAtomic,
} from "../src/platform/file.ts"
import { getPaths } from "../src/platform/path.ts"

let workDir = ""

before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "wellspring-config-"))
})

after(() => rm(workDir, { recursive: true, force: true }))

test("默认配置已冻结", () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
        version: 1,
        logger: { level: "info" },
        openai: { baseUrl: null, model: "gpt-4o-mini", timeoutMs: 60000, maxRetries: 2 },
        network: { proxy: null },
        sandbox: {
            mode: "strict",
            backend: "auto",
            access: "read-only",
            maxConcurrent: 2,
            defaultTimeoutMs: 60000,
            defaultMemoryMB: 512,
            outputLimitBytes: 16 * 1024 * 1024,
        },
    })
    assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true)
    assert.equal(Object.isFrozen(DEFAULT_SETTINGS.logger), true)
    assert.equal(Object.isFrozen(DEFAULT_SETTINGS.openai), true)
    assert.equal(Object.isFrozen(DEFAULT_SETTINGS.network), true)
    assert.equal(Object.isFrozen(DEFAULT_SETTINGS.sandbox), true)
})

test("validateSettings 接受完整配置", () => {
    const result = validateSettings({ version: 1, logger: { level: "debug" } })
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData(), {
        version: 1,
        logger: { level: "debug" },
        openai: DEFAULT_SETTINGS.openai,
        network: DEFAULT_SETTINGS.network,
        sandbox: DEFAULT_SETTINGS.sandbox,
    })
})

test("validateSettings 补齐缺省字段", () => {
    assert.deepEqual(validateSettings({}).getData(), DEFAULT_SETTINGS)
    assert.deepEqual(validateSettings({ logger: {} }).getData(), DEFAULT_SETTINGS)
    assert.deepEqual(validateSettings({ version: 1 }).getData(), DEFAULT_SETTINGS)
})

test("validateSettings 忽略未声明字段", () => {
    const result = validateSettings({ logger: { level: "warn" }, extra: true })
    assert.deepEqual(result.getData(), {
        version: 1,
        logger: { level: "warn" },
        openai: DEFAULT_SETTINGS.openai,
        network: DEFAULT_SETTINGS.network,
        sandbox: DEFAULT_SETTINGS.sandbox,
    })
})

test("validateSettings 字段级错误码", () => {
    const cases: Array<[unknown, string]> = [
        [null, invalidCode("root")],
        [[], invalidCode("root")],
        [{ logger: "info" }, invalidCode("logger")],
        [{ logger: { level: "verbose" } }, invalidCode("logger.level")],
        [{ logger: { level: 1 } }, invalidCode("logger.level")],
        [{ version: 2 }, `${CONFIG_CODES.versionUnsupported}:2`],
        [{ openai: [] }, invalidCode("openai")],
        [{ openai: { baseUrl: "ftp://example.com" } }, invalidCode("openai.baseUrl")],
        [{ openai: { model: "  " } }, invalidCode("openai.model")],
        [{ openai: { timeoutMs: 0 } }, invalidCode("openai.timeoutMs")],
        [{ openai: { maxRetries: -1 } }, invalidCode("openai.maxRetries")],
    ]
    for (const [input, code] of cases) {
        const result = validateSettings(input)
        assert.equal(result.isSuccess(), false)
        assert.equal(result.getCode(), code)
        assert.equal(result.getData(), null)
    }
})

test("validateSettings 接受 openai 配置", () => {
    const result = validateSettings({
        openai: {
            baseUrl: "https://api.example.com/v1",
            model: " gpt-test ",
            timeoutMs: 1000,
            maxRetries: 0,
        },
    })
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData()?.openai, {
        baseUrl: "https://api.example.com/v1",
        model: "gpt-test",
        timeoutMs: 1000,
        maxRetries: 0,
    })
})

test("validateSettings 接受 network.proxy", () => {
    const result = validateSettings({
        network: { proxy: { url: "http://127.0.0.1:7890", noProxy: ["localhost", "*.internal"] } },
    })
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData()?.network, {
        proxy: {
            type: "http",
            url: "http://127.0.0.1:7890",
            noProxy: ["localhost", "*.internal"],
        },
    })
    assert.deepEqual(validateSettings({ network: { proxy: null } }).getData()?.network, {
        proxy: null,
    })
})

test("validateSettings 拒绝非法代理配置", () => {
    const cases: Array<[unknown, string]> = [
        [{ network: "x" }, invalidCode("network")],
        [{ network: { proxy: [] } }, invalidCode("network.proxy")],
        [{ network: { proxy: { url: "ftp://example.com" } } }, invalidCode("network.proxy.url")],
        [
            { network: { proxy: { type: "socks5", url: "http://127.0.0.1:7890" } } },
            invalidCode("network.proxy.type"),
        ],
        [
            { network: { proxy: { url: "http://127.0.0.1:7890", noProxy: "localhost" } } },
            invalidCode("network.proxy.noProxy"),
        ],
        [
            { network: { proxy: { url: "http://127.0.0.1:7890", noProxy: [""] } } },
            invalidCode("network.proxy.noProxy"),
        ],
    ]
    for (const [input, code] of cases) {
        const result = validateSettings(input)
        assert.equal(result.isSuccess(), false)
        assert.equal(result.getCode(), code)
    }
})

test("validateSettings 接受 sandbox 配置", () => {
    const result = validateSettings({
        sandbox: {
            mode: "best-effort",
            backend: "bwrap",
            access: "workspace-write",
            maxConcurrent: 4,
            defaultTimeoutMs: 120000,
            defaultMemoryMB: 1024,
            outputLimitBytes: 1024 * 1024,
        },
    })
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData()?.sandbox, {
        mode: "best-effort",
        backend: "bwrap",
        access: "workspace-write",
        maxConcurrent: 4,
        defaultTimeoutMs: 120000,
        defaultMemoryMB: 1024,
        outputLimitBytes: 1024 * 1024,
    })
    assert.deepEqual(validateSettings({ sandbox: {} }).getData()?.sandbox, DEFAULT_SETTINGS.sandbox)
})

test("validateSettings 拒绝非法 sandbox 配置", () => {
    const cases: Array<[unknown, string]> = [
        [{ sandbox: "x" }, invalidCode("sandbox")],
        [{ sandbox: { mode: "yolo" } }, invalidCode("sandbox.mode")],
        [{ sandbox: { backend: "docker" } }, invalidCode("sandbox.backend")],
        [{ sandbox: { access: "root" } }, invalidCode("sandbox.access")],
        [{ sandbox: { maxConcurrent: 0 } }, invalidCode("sandbox.maxConcurrent")],
        [{ sandbox: { maxConcurrent: 33 } }, invalidCode("sandbox.maxConcurrent")],
        [{ sandbox: { defaultTimeoutMs: 0 } }, invalidCode("sandbox.defaultTimeoutMs")],
        [{ sandbox: { defaultMemoryMB: 8193 } }, invalidCode("sandbox.defaultMemoryMB")],
        [{ sandbox: { outputLimitBytes: 1 } }, invalidCode("sandbox.outputLimitBytes")],
    ]
    for (const [input, code] of cases) {
        const result = validateSettings(input)
        assert.equal(result.isSuccess(), false)
        assert.equal(result.getCode(), code)
    }
})

test("settingsFile 位于 config 根目录", () => {
    assert.equal(settingsFile(), join(getPaths().configDir, SETTING_FILE_NAME))
})

test("缺文件时创建默认配置", async () => {
    const file = join(workDir, "created", SETTING_FILE_NAME)
    const result = await loadSettings(file)
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(result.getData(), DEFAULT_SETTINGS)
    assert.deepEqual(JSON.parse((await readTextIfExists(file)) ?? ""), DEFAULT_SETTINGS)
})

test("JSON 损坏时回退默认值且不覆盖文件", async () => {
    const file = join(workDir, "broken.json")
    await writeTextAtomic(file, "{")
    const result = await loadSettings(file)
    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), CONFIG_CODES.parseFailed)
    assert.deepEqual(result.getData(), DEFAULT_SETTINGS)
    assert.equal(await readTextIfExists(file), "{")
})

test("非法字段回退默认值", async () => {
    const file = join(workDir, "invalid.json")
    await writeJsonAtomic(file, { logger: { level: "verbose" } })
    const result = await loadSettings(file)
    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), invalidCode("logger.level"))
    assert.deepEqual(result.getData(), DEFAULT_SETTINGS)
})

test("读取失败返回 readFailed", async () => {
    const dirAsFile = join(workDir, "as-dir")
    await ensureDir(dirAsFile)
    const result = await loadSettings(dirAsFile)
    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), CONFIG_CODES.readFailed)
    assert.deepEqual(result.getData(), DEFAULT_SETTINGS)
})

test("saveSettings 写盘后可读回", async () => {
    const file = join(workDir, "roundtrip", SETTING_FILE_NAME)
    const saved = await saveSettings(
        {
            version: 1,
            logger: { level: "trace" },
            openai: DEFAULT_SETTINGS.openai,
            network: DEFAULT_SETTINGS.network,
            sandbox: DEFAULT_SETTINGS.sandbox,
        },
        file,
    )
    assert.equal(saved.isSuccess(), true)
    assert.equal(saved.getCode(), null)

    const loaded = await loadSettings(file)
    assert.equal(loaded.isSuccess(), true)
    assert.deepEqual(loaded.getData(), {
        version: 1,
        logger: { level: "trace" },
        openai: DEFAULT_SETTINGS.openai,
        network: DEFAULT_SETTINGS.network,
        sandbox: DEFAULT_SETTINGS.sandbox,
    })
})

test("saveSettings 校验失败时不落盘", async () => {
    const file = join(workDir, "rejected.json")
    const invalid = { version: 2, logger: { level: "info" } } as unknown as AppSetting
    const result = await saveSettings(invalid, file)
    assert.equal(result.isSuccess(), false)
    assert.equal(result.getCode(), `${CONFIG_CODES.versionUnsupported}:2`)
    assert.equal(await readTextIfExists(file), null)
})

test("saveSettings 丢弃未声明字段", async () => {
    const file = join(workDir, "normalized.json")
    const withExtra = {
        version: 1,
        logger: { level: "debug" },
        extra: true,
    } as unknown as AppSetting
    const result = await saveSettings(withExtra, file)
    assert.equal(result.isSuccess(), true)
    assert.deepEqual(JSON.parse((await readTextIfExists(file)) ?? ""), {
        version: 1,
        logger: { level: "debug" },
        openai: DEFAULT_SETTINGS.openai,
        network: DEFAULT_SETTINGS.network,
        sandbox: DEFAULT_SETTINGS.sandbox,
    })
})
