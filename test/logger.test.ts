import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { CONFIG_CODES } from "../src/config/codes.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import {
    LOG_FILE_NAME,
    closeLogger,
    createLogger,
    getLogger,
    initLogger,
} from "../src/logger/logger.ts"
import {
    ensureDir,
    readTextIfExists,
    writeJsonAtomic,
    writeTextAtomic,
} from "../src/platform/file.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"

let workDir = ""

before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "wellspring-logger-"))
})

after(async () => {
    await closeLogger()
    await rm(workDir, { recursive: true, force: true })
})

function pathsAt(name: string): ResolvedPaths {
    const root = join(workDir, name)
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

async function readLog(paths: ResolvedPaths): Promise<string> {
    return (await readTextIfExists(join(paths.logDir, LOG_FILE_NAME))) ?? ""
}

test("未初始化时 getLogger 抛错", () => {
    assert.throws(() => getLogger(), /尚未初始化/)
})

test("createLogger 拒绝没有输出目标", () => {
    assert.throws(() => createLogger({ file: false, stdout: false }), /日志输出未启用/)
})

test("initLogger 按配置级别写文件", async () => {
    const paths = pathsAt("level-debug")
    const logger = await initLogger({
        paths,
        settings: {
            version: 1,
            logger: { level: "debug" },
            openai: DEFAULT_SETTINGS.openai,
            network: DEFAULT_SETTINGS.network,
        },
        stdout: false,
    })
    assert.equal(getLogger(), logger)
    logger.info("hello")
    logger.debug("detail")
    await closeLogger()

    const text = await readLog(paths)
    assert.match(text, /"msg":"hello"/)
    assert.match(text, /"msg":"detail"/)
    assert.match(text, /"name":"wellspring"/)
})

test("initLogger 过滤低于配置级别的日志", async () => {
    const paths = pathsAt("level-warn")
    const logger = await initLogger({
        paths,
        settings: {
            version: 1,
            logger: { level: "warn" },
            openai: DEFAULT_SETTINGS.openai,
            network: DEFAULT_SETTINGS.network,
        },
        stdout: false,
    })
    logger.info("hidden")
    logger.warn("shown")
    await closeLogger()

    const text = await readLog(paths)
    assert.doesNotMatch(text, /hidden/)
    assert.match(text, /"msg":"shown"/)
})

test("initLogger 读取配置文件里的级别", async () => {
    const paths = pathsAt("from-config")
    const configFile = join(paths.configDir, "app-setting.json")
    await writeJsonAtomic(configFile, { logger: { level: "trace" } })

    const logger = await initLogger({ paths, configFile, stdout: false })
    assert.equal(logger.level, "trace")
    logger.trace("trace-msg")
    await closeLogger()

    assert.match(await readLog(paths), /trace-msg/)
})

test("配置文件损坏时回退默认级别并记录错误码", async () => {
    const paths = pathsAt("corrupt-config")
    const configFile = join(paths.configDir, "app-setting.json")
    await writeTextAtomic(configFile, "{")

    const logger = await initLogger({ paths, configFile, stdout: false })
    assert.equal(logger.level, "info")
    await closeLogger()

    const text = await readLog(paths)
    assert.match(text, /配置加载失败/)
    assert.ok(text.includes(CONFIG_CODES.parseFailed))
})

test("initLogger 支持 redact", async () => {
    const paths = pathsAt("redact")
    const logger = await initLogger({
        paths,
        settings: {
            version: 1,
            logger: { level: "info" },
            openai: DEFAULT_SETTINGS.openai,
            network: DEFAULT_SETTINGS.network,
        },
        stdout: false,
        redact: { paths: ["apiKey"], censor: "[redacted]" },
    })
    logger.info({ apiKey: "secret-token" }, "auth")
    await closeLogger()

    const text = await readLog(paths)
    assert.match(text, /\[redacted\]/)
    assert.doesNotMatch(text, /secret-token/)
})

test("文件目标不可用时 createLogger 抛错", async () => {
    const dirAsFile = join(workDir, "as-dir")
    await ensureDir(dirAsFile)
    assert.throws(() => createLogger({ file: dirAsFile, stdout: false }), /日志文件不可写/)
})

test("文件目标不可用时 initLogger 降级到 stdout", async () => {
    const paths = pathsAt("fallback")
    const blocker = join(workDir, "blocker")
    await writeTextAtomic(blocker, "not a directory")

    const stdout = process.stdout
    const originalWrite = stdout.write.bind(stdout)
    let captured = ""
    stdout.write = ((chunk: unknown) => {
        captured += String(chunk)
        return true
    }) as typeof stdout.write

    try {
        const logger = await initLogger({
            paths,
            settings: {
                version: 1,
                logger: { level: "info" },
                openai: DEFAULT_SETTINGS.openai,
                network: DEFAULT_SETTINGS.network,
            },
            file: join(blocker, "app.log"),
        })
        logger.info("stdout-only")
        await closeLogger()
    } finally {
        stdout.write = originalWrite
    }

    assert.match(captured, /日志文件不可写/)
    assert.match(captured, /stdout-only/)
})

test("initLogger 重复调用返回同一实例", async () => {
    const first = await initLogger({
        paths: pathsAt("reuse-a"),
        settings: {
            version: 1,
            logger: { level: "info" },
            openai: DEFAULT_SETTINGS.openai,
            network: DEFAULT_SETTINGS.network,
        },
        stdout: false,
    })
    const second = await initLogger({
        paths: pathsAt("reuse-b"),
        settings: {
            version: 1,
            logger: { level: "info" },
            openai: DEFAULT_SETTINGS.openai,
            network: DEFAULT_SETTINGS.network,
        },
        stdout: false,
    })
    assert.equal(first, second)
    await closeLogger()
})

test("closeLogger 可重复调用，关闭后 getLogger 抛错", async () => {
    await closeLogger()
    await closeLogger()
    assert.throws(() => getLogger(), /尚未初始化/)
})
