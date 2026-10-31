/*
 * 自定义供应商与模型切换：配置校验、凭据分槽、模型解析、宿主模型服务、CLI 切换。
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { configureHost } from "../src/api/host/host.ts"
import { runConfigCommand } from "../src/commands/config.ts"
import { runKeyCommand } from "../src/commands/key.ts"
import type { CommandContext } from "../src/commands/shared.ts"
import { CONFIG_CODES } from "../src/config/codes.ts"
import {
    clearProviderApiKey,
    credentialsFile,
    providerKeyStatusSync,
    readProviderApiKeySync,
    saveProviderApiKey,
} from "../src/config/credentials.ts"
import { DEFAULT_MODELS, DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { loadSettings, saveSettings, SETTING_FILE_NAME } from "../src/config/loader.ts"
import {
    activeModelProvider,
    effectiveModel,
    effectiveReasoning,
    findModelProvider,
    listModelProviders,
    providerOpenAISettings,
    requestProvider,
} from "../src/config/providers.ts"
import type { AppSetting, ModelProviderSetting } from "../src/config/types.ts"
import { validateSettings } from "../src/config/validate.ts"
import { getElog, initElog, type ElogStream } from "../src/logger/elog4js.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { createHostModelsService } from "../src/plugin/models-service.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"

let root = ""
let previous: string | undefined

const DEEPSEEK: ModelProviderSetting = {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
}

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

function settingsWith(models: AppSetting["models"]): AppSetting {
    return { ...DEFAULT_SETTINGS, models }
}

function makeContext(settings: AppSetting, output: { text: string }): CommandContext {
    const stream = output as ElogStream & { text: string }
    stream.write = (text: string) => {
        output.text += text
    }
    initElog({ stdout: stream, stderr: stream, color: false, json: false })
    return {
        global: { json: false, quiet: false, help: false, version: false },
        settings,
        settingsFile: join(paths().configDir, SETTING_FILE_NAME),
        configCode: null,
        paths: paths(),
        logger: pino({ level: "silent" }),
        elog: getElog(),
        registry: new PluginRegistry(),
        agentTools: new AgentToolRegistry(),
        openai: null,
        activeProvider: "openai",
        activeModel: settings.openai.model,
        loadPlugins: async () => [],
    }
}

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-models-"))
    configureHost({ paths: paths() })
    previous = process.env["OPENAI_API_KEY"]
    delete process.env["OPENAI_API_KEY"]
    delete process.env["DEEPSEEK_API_KEY"]
})

after(async () => {
    if (previous === undefined) {
        delete process.env["OPENAI_API_KEY"]
    } else {
        process.env["OPENAI_API_KEY"] = previous
    }
    delete process.env["DEEPSEEK_API_KEY"]
    await rm(root, { recursive: true, force: true })
})

test("配置校验：合法供应商与非法输入", () => {
    const valid = validateSettings({
        version: 1,
        models: {
            providers: [DEEPSEEK],
            activeProvider: "deepseek",
            activeModel: "deepseek-reasoner",
        },
    })
    assert.equal(valid.isSuccess(), true)
    const models = valid.getData()?.models
    assert.equal(models?.providers.length, 1)
    assert.equal(models?.activeProvider, "deepseek")
    assert.equal(models?.activeModel, "deepseek-reasoner")

    const noModels = validateSettings({ version: 1 })
    assert.equal(noModels.isSuccess(), true)
    assert.deepEqual(noModels.getData()?.models, DEFAULT_MODELS)
    assert.equal(DEFAULT_MODELS.activeReasoning, "off")

    const reasoning = validateSettings({
        version: 1,
        models: {
            providers: [DEEPSEEK],
            activeProvider: "deepseek",
            activeReasoning: "high",
        },
    })
    assert.equal(reasoning.isSuccess(), true)
    assert.equal(reasoning.getData()?.models?.activeReasoning, "high")
    const badReasoning = validateSettings({
        version: 1,
        models: { activeReasoning: "extreme" },
    })
    assert.equal(badReasoning.isSuccess(), false)
    assert.match(badReasoning.getCode() ?? "", /models\.activeReasoning/)

    const reserved = validateSettings({
        version: 1,
        models: { providers: [{ ...DEEPSEEK, id: "openai" }] },
    })
    assert.equal(reserved.isSuccess(), false)
    assert.match(reserved.getCode() ?? "", /models\.providers/)

    const duplicate = validateSettings({
        version: 1,
        models: { providers: [DEEPSEEK, { ...DEEPSEEK }] },
    })
    assert.equal(duplicate.isSuccess(), false)

    const badActive = validateSettings({
        version: 1,
        models: { providers: [DEEPSEEK], activeProvider: "nope" },
    })
    assert.equal(badActive.isSuccess(), false)
    assert.match(badActive.getCode() ?? "", /models\.activeProvider/)

    const badUrl = validateSettings({
        version: 1,
        models: { providers: [{ ...DEEPSEEK, baseUrl: "ftp://x" }] },
    })
    assert.equal(badUrl.isSuccess(), false)
})

test("供应商解析：内置 + 自定义、模型优先级", () => {
    const settings = settingsWith({
        providers: [DEEPSEEK],
        activeProvider: "deepseek",
        activeModel: "deepseek-reasoner",
        activeReasoning: "off",
    })
    const providers = listModelProviders(settings)
    assert.equal(providers.length, 2)
    assert.equal(providers[0]?.id, "openai")
    assert.equal(providers[0]?.builtin, true)
    assert.equal(providers[1]?.id, "deepseek")

    const deepseek = findModelProvider(settings, "deepseek")
    assert.ok(deepseek !== null)
    assert.equal(activeModelProvider(settings).id, "deepseek")
    assert.equal(effectiveModel(settings, deepseek), "deepseek-reasoner")
    assert.equal(effectiveModel(settings, deepseek, "other-model"), "other-model")
    assert.equal(effectiveReasoning(settings, deepseek), "off")
    assert.equal(effectiveReasoning(settings, deepseek, "high"), "high")

    const builtin = findModelProvider(settings, "openai")
    assert.ok(builtin !== null)
    assert.equal(effectiveModel(settings, builtin), settings.openai.model)

    // 请求里指定供应商/模型优先
    const requested = requestProvider(settings, "openai")
    assert.equal(requested.id, "openai")
    const fallback = requestProvider(settings, "missing")
    assert.equal(fallback.id, "deepseek")

    const openaiSettings = providerOpenAISettings(settings, deepseek)
    assert.equal(openaiSettings.baseUrl, "https://api.deepseek.com/v1")
    assert.equal(openaiSettings.model, "deepseek-reasoner")
})

test("凭据按供应商分槽，v1 文件仍可读，环境变量按供应商优先", async () => {
    const file = credentialsFile(paths().configDir)
    await saveProviderApiKey("deepseek", "sk-deepseek-00001111", file)
    await saveProviderApiKey("openai", "sk-openai-22223333", file)
    assert.equal(readProviderApiKeySync("deepseek", file), "sk-deepseek-00001111")
    assert.equal(readProviderApiKeySync("openai", file), "sk-openai-22223333")
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        version: number
        openai: { apiKey: string }
        providers: Record<string, string>
    }
    assert.equal(parsed.version, 2)
    assert.equal(parsed.providers.deepseek, "sk-deepseek-00001111")

    const deepseekStatus = providerKeyStatusSync(
        { id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
        file,
    )
    assert.equal(deepseekStatus.configured, true)
    assert.equal(deepseekStatus.source, "credentials")
    assert.equal(deepseekStatus.stored, true)

    process.env["DEEPSEEK_API_KEY"] = "sk-env-deepseek-4444"
    try {
        const overridden = providerKeyStatusSync(
            { id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
            file,
        )
        assert.equal(overridden.source, "env")
        assert.equal(overridden.envOverride, true)
    } finally {
        delete process.env["DEEPSEEK_API_KEY"]
    }

    // v1 文件（只有 openai 槽）仍能读出内置供应商 key
    const legacy = join(paths().configDir, "legacy-credentials.json")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(legacy, JSON.stringify({ version: 1, openai: { apiKey: "sk-legacy-9999" } }))
    assert.equal(readProviderApiKeySync("openai", legacy), "sk-legacy-9999")

    await clearProviderApiKey("deepseek", file)
    assert.equal(readProviderApiKeySync("deepseek", file), null)
    assert.equal(readProviderApiKeySync("openai", file), "sk-openai-22223333")
})

test("宿主模型服务：保存供应商、切换模型、删除、Key 状态", async () => {
    const settings = settingsWith({
        providers: [],
        activeProvider: "openai",
        activeModel: null,
        activeReasoning: "off",
    })
    const settingsFile = join(paths().configDir, SETTING_FILE_NAME)
    await saveSettings(settings, settingsFile)
    const service = createHostModelsService({
        settings,
        settingsFile,
        configDir: paths().configDir,
        logger: pino({ level: "silent" }),
    })

    const saved = await service.saveProvider({
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        models: ["deepseek-chat", "deepseek-reasoner"],
        defaultModel: "deepseek-chat",
        apiKey: "sk-service-00001111",
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.state.providers.length, 2)
    const deepseek = saved.state.providers.find((item) => item.id === "deepseek")
    assert.ok(deepseek !== undefined)
    assert.equal(deepseek.keyConfigured, true)
    assert.equal(deepseek.keyMasked, "sk-…1111")

    // 写回 app-setting.json，重新加载能看到
    const reloaded = await loadSettings(settingsFile)
    assert.equal(reloaded.isSuccess(), true)
    assert.equal(reloaded.getData()?.models?.providers.length, 1)

    assert.equal(saved.state.activeReasoning, "off")
    const active = await service.setActive("deepseek", "deepseek-reasoner", "high")
    assert.equal(active.activeProvider, "deepseek")
    assert.equal(active.activeModel, "deepseek-reasoner")
    assert.equal(active.activeReasoning, "high")
    assert.deepEqual(active.reasoningLevels, ["off", "low", "high", "max"])
    const keptReasoning = await service.setActive("deepseek", "deepseek-chat")
    assert.equal(keptReasoning.activeReasoning, "high")

    // 保存 key 后状态可见；清除后回落到未配置
    const keyed = await service.saveKey("deepseek", "sk-service-22223333")
    assert.equal(keyed.ok, true)
    const clearedState = await service.clearKey("deepseek")
    const cleared = clearedState.providers.find((item) => item.id === "deepseek")
    assert.equal(cleared?.keyConfigured, false)

    const removed = await service.removeProvider("deepseek")
    assert.equal(removed.ok, true)
    assert.equal(removed.state.activeProvider, "openai")
    assert.equal(removed.state.providers.length, 1)
    const removedAgain = await service.removeProvider("deepseek")
    assert.equal(removedAgain.ok, false)
    assert.equal(removedAgain.code, "models.provider-not-found")
    const builtin = await service.removeProvider("openai")
    assert.equal(builtin.ok, false)
    assert.equal(builtin.code, "models.builtin-provider")
})

test("宿主模型服务：拉取模型失败时给出错误码", async () => {
    const settings: AppSetting = {
        ...DEFAULT_SETTINGS,
        openai: { ...DEFAULT_SETTINGS.openai, timeoutMs: 800, maxRetries: 0 },
        models: {
            providers: [DEEPSEEK],
            activeProvider: "deepseek",
            activeModel: null,
            activeReasoning: "off",
        },
    }
    const settingsFile = join(paths().configDir, "fetch-setting.json")
    await saveSettings(settings, settingsFile)
    const service = createHostModelsService({
        settings,
        settingsFile,
        configDir: paths().configDir,
        logger: pino({ level: "silent" }),
    })
    const fetched = await service.fetchModels("deepseek", "sk-fake-00001111")
    assert.equal(fetched.ok, false)
    assert.match(fetched.code ?? "", /openai\./)
})

test("CLI：config 切换供应商/模型，key --provider 操作自定义供应商", async () => {
    const settings = settingsWith({
        providers: [DEEPSEEK],
        activeProvider: "openai",
        activeModel: null,
        activeReasoning: "off",
    })
    const output = { text: "" }
    const ctx = makeContext(settings, output)

    /** 同一进程连续跑多条 config 命令时按文件重读；真实 CLI 每条命令都是新进程 */
    async function freshConfigContext(): Promise<CommandContext> {
        const loaded = await loadSettings(join(paths().configDir, SETTING_FILE_NAME))
        return { ...ctx, settings: loaded.getData() ?? ctx.settings }
    }

    const configSet = await runConfigCommand(ctx, ["set", "models.activeProvider", "deepseek"])
    // 只读命令上下文里的 settingsFile 指向临时目录，写入会成功
    assert.equal(configSet.result.isSuccess(), true)
    const reloaded = await loadSettings(join(paths().configDir, SETTING_FILE_NAME))
    assert.equal(reloaded.getData()?.models?.activeProvider, "deepseek")

    const reasoningSet = await runConfigCommand(ctx, ["set", "models.activeReasoning", "high"])
    assert.equal(reasoningSet.result.isSuccess(), true)
    const badReasoning = await runConfigCommand(ctx, ["set", "models.activeReasoning", "extreme"])
    assert.equal(badReasoning.result.isSuccess(), false)
    const modelSet = await runConfigCommand(ctx, ["set", "models.activeModel", "deepseek-chat"])
    assert.equal(modelSet.result.isSuccess(), true)
    const active = await runConfigCommand(ctx, ["get", "models.activeModel"])
    assert.equal(active.result.isSuccess(), true)

    // 网络代理：CLI 也能设置（网页设置用的是同一份 app-setting.json）
    let proxyCtx = await freshConfigContext()
    const proxySet = await runConfigCommand(proxyCtx, [
        "set",
        "network.proxy",
        "http://127.0.0.1:7890",
    ])
    assert.equal(proxySet.result.isSuccess(), true)
    let proxySettings = (await loadSettings(join(paths().configDir, SETTING_FILE_NAME))).getData()
    assert.deepEqual(proxySettings?.network.proxy, {
        type: "http",
        url: "http://127.0.0.1:7890",
        noProxy: [],
    })

    proxyCtx = await freshConfigContext()
    const noProxySet = await runConfigCommand(proxyCtx, [
        "set",
        "network.noProxy",
        "localhost, 127.0.0.1",
    ])
    assert.equal(noProxySet.result.isSuccess(), true)
    proxySettings = (await loadSettings(join(paths().configDir, SETTING_FILE_NAME))).getData()
    assert.deepEqual(proxySettings?.network.proxy?.noProxy, ["localhost", "127.0.0.1"])

    proxyCtx = await freshConfigContext()
    const proxyGet = await runConfigCommand(proxyCtx, ["get", "network.proxy"])
    assert.equal(proxyGet.result.isSuccess(), true)
    assert.deepEqual(proxyGet.result.getData(), {
        key: "network.proxy",
        value: {
            type: "http",
            url: "http://127.0.0.1:7890",
            noProxy: ["localhost", "127.0.0.1"],
        },
    })

    proxyCtx = await freshConfigContext()
    const badProxy = await runConfigCommand(proxyCtx, [
        "set",
        "network.proxy",
        "socks5://127.0.0.1:1080",
    ])
    assert.equal(badProxy.result.isSuccess(), false)

    proxyCtx = await freshConfigContext()
    const clearProxy = await runConfigCommand(proxyCtx, ["set", "network.proxy", "none"])
    assert.equal(clearProxy.result.isSuccess(), true)
    proxySettings = (await loadSettings(join(paths().configDir, SETTING_FILE_NAME))).getData()
    assert.equal(proxySettings?.network.proxy, null)
    proxyCtx = await freshConfigContext()
    const orphanNoProxy = await runConfigCommand(proxyCtx, ["set", "network.noProxy", "internal"])
    assert.equal(orphanNoProxy.result.isSuccess(), false)

    // 插件私有配置：plugins.<id>.<field> 透传到 <configDir>/plugins/<id>.json
    const pluginSet = await runConfigCommand(ctx, ["set", "plugins.wellspring-web.host", "0.0.0.0"])
    assert.equal(pluginSet.result.isSuccess(), true)
    const portSet = await runConfigCommand(ctx, ["set", "plugins.wellspring-web.port", "8899"])
    assert.equal(portSet.result.isSuccess(), true)
    const pluginFile = join(paths().configDir, "plugins", "wellspring-web.json")
    const pluginConfig = JSON.parse(readFileSync(pluginFile, "utf8")) as Record<string, unknown>
    assert.deepEqual(pluginConfig, { host: "0.0.0.0", port: 8899 })
    const pluginGet = await runConfigCommand(ctx, ["get", "plugins.wellspring-web.host"])
    assert.equal(pluginGet.result.isSuccess(), true)
    assert.deepEqual(pluginGet.result.getData(), {
        key: "plugins.wellspring-web.host",
        value: "0.0.0.0",
    })
    assert.match(output.text, /"0\.0\.0\.0"/)
    const wholeConfig = await runConfigCommand(ctx, ["get", "plugins.wellspring-web"])
    assert.equal(wholeConfig.result.isSuccess(), true)
    const badWhole = await runConfigCommand(ctx, ["set", "plugins.wellspring-web", "not-object"])
    assert.equal(badWhole.result.isSuccess(), false)
    const badKey = await runConfigCommand(ctx, ["set", "plugins./evil.host", "x"])
    assert.equal(badKey.result.isSuccess(), false)

    // key 默认操作当前生效供应商（测试上下文 activeProvider 固定 openai，这里显式指定）
    const status = await runKeyCommand(ctx, ["status", "--provider", "deepseek"])
    assert.equal(status.result.isSuccess(), true)
    assert.match(output.text, /供应商: DeepSeek/)

    const setKey = await runKeyCommand(ctx, [
        "set",
        "sk-cli-deepseek-5555",
        "--provider",
        "deepseek",
    ])
    assert.equal(setKey.result.isSuccess(), true)
    assert.equal(
        readProviderApiKeySync("deepseek", credentialsFile(paths().configDir)),
        "sk-cli-deepseek-5555",
    )

    const badProvider = await runKeyCommand(ctx, ["status", "--provider", "nope"])
    assert.equal(badProvider.result.isSuccess(), false)
    assert.match(badProvider.result.getCode() ?? "", /models\.provider-not-found/)

    const invalid = await runKeyCommand(ctx, ["set", "bad key", "--provider", "deepseek"])
    assert.equal(invalid.result.isSuccess(), false)
    assert.equal(invalid.result.getCode(), CONFIG_CODES.invalidApiKey)
})
