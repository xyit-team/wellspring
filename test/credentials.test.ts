/*
 * API Key 凭据：存储、掩码、解析顺序与 CLI key 命令
 */

import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { runKeyCommand } from "../src/commands/key.ts"
import type { CommandContext } from "../src/commands/shared.ts"
import { CONFIG_CODES } from "../src/config/codes.ts"
import {
    apiKeyStatusSync,
    clearStoredApiKey,
    credentialsFile,
    maskApiKey,
    normalizeApiKey,
    readStoredApiKey,
    readStoredApiKeySync,
    resolveApiKeySync,
    saveStoredApiKey,
} from "../src/config/credentials.ts"
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { getElog, initElog, type ElogStream } from "../src/logger/elog4js.ts"
import { OPENAI_CODES, OpenAIClient } from "../src/network/openai.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"

let root = ""
let previousKey: string | undefined

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

function credFile(): string {
    return credentialsFile(paths().configDir)
}

function makeContext(output: { text: string }): CommandContext {
    const elogStream = output as ElogStream & { text: string }
    elogStream.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: elogStream, stderr: elogStream, color: false, json: false })
    return {
        global: { json: false, quiet: false, help: false, version: false },
        settings: DEFAULT_SETTINGS,
        settingsFile: join(paths().configDir, "app-setting.json"),
        configCode: null,
        paths: paths(),
        logger: pino({ level: "silent" }),
        elog: getElog(),
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        openai: null,
        loadPlugins: async () => [],
    }
}

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-credentials-"))
    configureHost({ paths: paths() })
    previousKey = process.env["OPENAI_API_KEY"]
    delete process.env["OPENAI_API_KEY"]
})

after(async () => {
    if (previousKey === undefined) {
        delete process.env["OPENAI_API_KEY"]
    } else {
        process.env["OPENAI_API_KEY"] = previousKey
    }
    await rm(root, { recursive: true, force: true })
})

test("掩码与格式校验", () => {
    assert.equal(maskApiKey("sk-1234567890abcdef"), "sk-…cdef")
    assert.equal(maskApiKey("short"), "••••")
    assert.equal(normalizeApiKey("  sk-abc  "), "sk-abc")
    assert.equal(normalizeApiKey(""), null)
    assert.equal(normalizeApiKey("   "), null)
    assert.equal(normalizeApiKey("bad key"), null)
    assert.equal(normalizeApiKey("a".repeat(5000)), null)
    assert.equal(normalizeApiKey(42), null)
})

test("保存 / 读取 / 清除本地凭据，文件权限 0600", async () => {
    const saved = await saveStoredApiKey("sk-test-abcdef123456", credFile())
    assert.equal(saved.isSuccess(), true)
    const file = credFile()
    assert.equal(readStoredApiKeySync(credFile()), "sk-test-abcdef123456")
    assert.equal(await readStoredApiKey(credFile()), "sk-test-abcdef123456")
    const stat = statSync(file)
    assert.equal(stat.mode & 0o777, 0o600)
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        version: number
        openai: { apiKey: string }
    }
    assert.equal(parsed.version, 2)
    assert.equal(parsed.openai.apiKey, "sk-test-abcdef123456")

    const status = apiKeyStatusSync(credFile())
    assert.equal(status.configured, true)
    assert.equal(status.source, "credentials")
    assert.equal(status.masked, "sk-…3456")
    assert.equal(status.stored, true)
    assert.equal(status.envOverride, false)

    const cleared = await clearStoredApiKey(credFile())
    assert.equal(cleared.isSuccess(), true)
    assert.equal(readStoredApiKeySync(credFile()), null)
    const empty = apiKeyStatusSync(credFile())
    assert.equal(empty.configured, false)
    assert.equal(empty.stored, false)
})

test("非法 key 拒绝写入", async () => {
    const saved = await saveStoredApiKey("bad key with spaces", credFile())
    assert.equal(saved.isSuccess(), false)
    assert.equal(saved.getCode(), CONFIG_CODES.invalidApiKey)
    assert.equal(readStoredApiKeySync(credFile()), null)
})

test("环境变量优先于本地凭据", async () => {
    await saveStoredApiKey("sk-file-000011112222", credFile())
    process.env["OPENAI_API_KEY"] = "sk-env-99998888"
    try {
        const resolved = resolveApiKeySync(credFile())
        assert.equal(resolved?.source, "env")
        assert.equal(resolved?.apiKey, "sk-env-99998888")
        const status = apiKeyStatusSync(credFile())
        assert.equal(status.source, "env")
        assert.equal(status.masked, "sk-…8888")
        assert.equal(status.envOverride, true)
        assert.equal(status.stored, true)
    } finally {
        delete process.env["OPENAI_API_KEY"]
        await clearStoredApiKey(credFile())
    }
})

test("凭据文件损坏时当作未配置", async () => {
    const file = credFile()
    await writeFile(file, "{ not json")
    assert.equal(readStoredApiKeySync(credFile()), null)
    assert.equal(await readStoredApiKey(credFile()), null)
    assert.equal(apiKeyStatusSync(credFile()).configured, false)
    await clearStoredApiKey(credFile())
})

test("OpenAI 客户端按 显式 > 环境变量 > 本地凭据 取 key", async () => {
    const missing = OpenAIClient.create({
        settings: DEFAULT_SETTINGS.openai,
        credentialsFile: credFile(),
    })
    assert.equal(missing.isSuccess(), false)
    assert.equal(missing.getCode(), OPENAI_CODES.missingApiKey)

    await saveStoredApiKey("sk-file-1234567890", credFile())
    const fromFile = OpenAIClient.create({
        settings: DEFAULT_SETTINGS.openai,
        credentialsFile: credFile(),
    })
    assert.equal(fromFile.isSuccess(), true)

    process.env["OPENAI_API_KEY"] = "sk-env-1234567890"
    try {
        const fromEnv = OpenAIClient.create({
            settings: DEFAULT_SETTINGS.openai,
            credentialsFile: credFile(),
        })
        assert.equal(fromEnv.isSuccess(), true)
        const explicit = OpenAIClient.create({
            settings: DEFAULT_SETTINGS.openai,
            apiKey: "sk-explicit-1234567890",
            credentialsFile: credFile(),
        })
        assert.equal(explicit.isSuccess(), true)
    } finally {
        delete process.env["OPENAI_API_KEY"]
        await clearStoredApiKey(credFile())
    }
})

test("CLI key status / set / clear / path", async () => {
    const output = { text: "" }
    const ctx = makeContext(output)

    const empty = await runKeyCommand(ctx, ["status"])
    assert.equal(empty.result.isSuccess(), true)
    assert.match(output.text, /未配置/)

    const set = await runKeyCommand(ctx, ["set", "sk-cli-11112222"])
    assert.equal(set.result.isSuccess(), true)
    assert.match(output.text, /已保存/)

    output.text = ""
    const status = await runKeyCommand(ctx, ["status"])
    assert.equal(status.result.isSuccess(), true)
    const data = status.result.getData() as { masked: string; source: string }
    assert.equal(data.source, "credentials")
    assert.equal(data.masked, "sk-…2222")
    assert.match(output.text, /本地凭据/)

    output.text = ""
    const path = await runKeyCommand(ctx, ["path"])
    assert.equal(path.result.isSuccess(), true)
    assert.match(output.text, /credentials\.json/)

    output.text = ""
    const clear = await runKeyCommand(ctx, ["clear"])
    assert.equal(clear.result.isSuccess(), true)
    assert.equal(readStoredApiKeySync(credFile()), null)

    const invalid = await runKeyCommand(ctx, ["set", "bad key"])
    assert.equal(invalid.result.isSuccess(), false)
    assert.equal(invalid.result.getCode(), CONFIG_CODES.invalidApiKey)

    const unknown = await runKeyCommand(ctx, ["nope"])
    assert.equal(unknown.result.isSuccess(), false)
    assert.match(unknown.result.getCode() ?? "", /usage\.unknown-subcommand/)
})
