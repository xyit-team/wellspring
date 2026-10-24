#!/usr/bin/env node
/*
 * Wellspring CLI 入口。
 * 解析全局参数 → 应用目录/日志覆盖 → 加载配置与插件 → 分发命令。
 */

import { resolve } from "node:path"

import type { HostOutput, PluginCommandContext } from "./api/host/plugin.ts"
import { configureHost, setHostStatus } from "./api/host/host.ts"
import { setHookErrorHandler, setHookGuard, withHookOwner } from "./api/host/hooks.ts"
import { runConfigCommand } from "./commands/config.ts"
import { runConversationCommand } from "./commands/conversation.ts"
import { runDoctorCommand } from "./commands/doctor.ts"
import { runHelpCommand } from "./commands/help.ts"
import { runKeyCommand } from "./commands/key.ts"
import { runPluginCommand } from "./commands/plugin.ts"
import {
    errorMessage,
    exitCodeFor,
    failure,
    type CommandContext,
    type CommandOutcome,
} from "./commands/shared.ts"
import { runSessionCommand } from "./commands/session.ts"
import { runStartCommand } from "./commands/start.ts"
import { runStopCommand } from "./commands/stop.ts"
import { runVersionCommand } from "./commands/version.ts"
import { credentialsFile } from "./config/credentials.ts"
import {
    activeModelProvider,
    effectiveModel,
    effectiveReasoning,
    providerApiKey,
    providerOpenAISettings,
} from "./config/providers.ts"
import { DEFAULT_SETTINGS } from "./config/defaults.ts"
import { loadSettings, SETTING_FILE_NAME } from "./config/loader.ts"
import type { AppSetting } from "./config/types.ts"
import { BUILTIN_NAMES, findBuiltin } from "./input/commands.ts"
import { parseGlobal } from "./input/parse.ts"
import type { GlobalOptions } from "./input/types.ts"
import { getElog, initElog } from "./logger/elog4js.ts"
import { closeLogger, initLogger } from "./logger/logger.ts"
import { initOpenAIClient, type OpenAIClient } from "./network/openai.ts"
import { createProxyFetch } from "./network/proxy.ts"
import { getPaths } from "./platform/path.ts"
import { withConsoleGuard } from "./plugin/console-guard.ts"
import { loadPlugins, type LoadedPlugin } from "./plugin/loader.ts"
import { createPluginFileApi } from "./plugin/fs.ts"
import { ensurePluginDataDir, loadPluginConfig } from "./plugin/runtime.ts"
import { shutdownAllSandboxPlugins } from "./sandbox/plugin-client.ts"
import { AgentToolRegistry } from "./plugin/agent-tools.ts"
import { PluginRegistry } from "./plugin/registry.ts"

function printParseError(code: string): void {
    const elog = getElog()
    elog.error(errorMessage(code))
    elog.notice("运行 wellspring --help 查看用法")
    process.exitCode = 2
}

function emitOutcome(outcome: CommandOutcome, json: boolean): void {
    const code = outcome.result.getCode()
    if (json) {
        const payload = {
            success: outcome.result.isSuccess(),
            code: outcome.result.isSuccess() ? null : code,
            data: outcome.result.isSuccess() ? outcome.result.getData() : null,
        }
        process.stdout.write(`${JSON.stringify(payload)}\n`)
    } else if (!outcome.result.isSuccess() && code !== null) {
        getElog().error(errorMessage(code))
    }
    process.exitCode = outcome.result.isSuccess() ? 0 : exitCodeFor(code)
}

function stripJsonFlag(argv: readonly string[]): { argv: string[]; json: boolean } {
    const next = [...argv]
    const marker = next.indexOf("--")
    const limit = marker === -1 ? next.length : marker
    for (let index = 0; index < limit; index += 1) {
        if (next[index] === "--json") {
            next.splice(index, 1)
            return { argv: next, json: true }
        }
    }
    return { argv: next, json: false }
}

function createPluginOutput(pluginName: string): HostOutput {
    const elog = getElog()
    return {
        info: (text) => elog.plugin("info", pluginName, text),
        warn: (text) => elog.plugin("warn", pluginName, text),
        error: (text) => elog.plugin("error", pluginName, text),
        print: (text = "") => elog.plugin("info", pluginName, text),
    }
}

async function main(argv: readonly string[]): Promise<void> {
    const parsed = parseGlobal(argv)
    if (!parsed.isSuccess()) {
        printParseError(parsed.getCode() ?? "usage.invalid-value")
        return
    }
    const parsedGlobal = parsed.getData()
    if (parsedGlobal === null) {
        printParseError("usage.invalid-value")
        return
    }
    const { options: globalOptions } = parsedGlobal
    let command = parsedGlobal.command
    let commandArgv = [...parsedGlobal.commandArgv]

    if (globalOptions.version) {
        command = "version"
        commandArgv = []
    }

    const builtin = command === null ? undefined : findBuiltin(command)
    const builtinName = builtin?.name ?? null
    let jsonMode = globalOptions.json
    if (builtinName !== null) {
        const stripped = stripJsonFlag(commandArgv)
        commandArgv = stripped.argv
        jsonMode = jsonMode || stripped.json
    }

    const options: GlobalOptions = { ...globalOptions, json: jsonMode }

    if (globalOptions.home !== undefined) {
        process.env["WELLSPRING_HOME"] = globalOptions.home
    }
    const paths = getPaths()
    configureHost({ paths })
    setHostStatus("starting")
    const settingsFile = resolve(globalOptions.config ?? `${paths.configDir}/${SETTING_FILE_NAME}`)

    const loaded = await loadSettings(settingsFile)
    const settings: AppSetting = loaded.getData() ?? DEFAULT_SETTINGS
    const configCode = loaded.isSuccess() ? null : loaded.getCode()

    initElog({ json: jsonMode })
    const elog = getElog()

    const logger = await initLogger({
        settings,
        level: globalOptions.logLevel ?? (globalOptions.quiet ? "silent" : undefined),
        json: jsonMode,
        stdout: false,
    })
    if (configCode !== null) {
        logger.warn({ code: configCode }, "配置加载失败，使用默认配置")
        elog.warn(`配置加载失败，使用默认配置：${errorMessage(configCode)}`)
    }

    setHookGuard(async (owner, task) => {
        await withHookOwner(owner, async () => {
            await withConsoleGuard(owner, logger.child({ plugin: owner }), task)
        })
    })

    setHookErrorHandler(({ hook, owner, error }) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn({ hook, owner, message }, "插件钩子执行失败")
        elog.warn(`插件钩子执行失败：${hook}（${owner ?? "-"}）：${message}`)
    })

    let openai: OpenAIClient | null = null
    let proxyFetch: ReturnType<typeof createProxyFetch>
    try {
        proxyFetch = createProxyFetch(settings.network.proxy)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logger.warn({ reason }, "代理初始化失败")
        elog.warn(`代理初始化失败：${reason}`)
        proxyFetch = undefined
    }
    // 当前供应商/模型：启动时解析一次，CLI 单轮命令直接用
    const provider = activeModelProvider(settings)
    const activeModel = effectiveModel(settings, provider)
    const activeReasoning = effectiveReasoning(settings, provider)
    const providerApiKeyValue = providerApiKey(provider, paths.configDir)
    const openaiResult = initOpenAIClient({
        settings: providerOpenAISettings(settings, provider),
        apiKey: providerApiKeyValue ?? "",
        credentialsFile: credentialsFile(paths.configDir),
        logger: logger.child({ module: "openai" }),
        fetch: proxyFetch,
    })
    if (openaiResult.isSuccess()) {
        openai = openaiResult.getData()
    } else {
        logger.warn({ code: openaiResult.getCode() }, "OpenAI 客户端不可用")
    }

    const registry = new PluginRegistry()
    const agentTools = new AgentToolRegistry()
    let pluginsCache: readonly LoadedPlugin[] | null = null
    const ensurePlugins = async (): Promise<readonly LoadedPlugin[]> => {
        if (pluginsCache !== null) {
            return pluginsCache
        }
        pluginsCache = await loadPlugins({
            paths,
            config: settings,
            logger,
            registry,
            agentTools,
            sandbox: settings.sandbox,
        })
        setHostStatus("running")
        for (const plugin of pluginsCache) {
            if (plugin.status === "failed") {
                logger.warn({ plugin: plugin.name, error: plugin.error }, "插件加载失败")
            }
        }
        return pluginsCache
    }

    const commandHelpRequested =
        builtinName !== null && commandArgv.some((token) => token === "--help" || token === "-h")
    const requested = commandHelpRequested ? builtinName : command
    let commandName: string
    if ((globalOptions.help || commandHelpRequested) && requested !== null) {
        commandName = "help"
        commandArgv = [requested]
    } else {
        commandName = requested ?? "help"
    }

    const ctx: CommandContext = {
        global: options,
        settings,
        settingsFile,
        configCode,
        paths,
        logger,
        elog,
        registry,
        agentTools,
        openai,
        activeProvider: provider.id,
        activeModel,
        activeReasoning,
        loadPlugins: ensurePlugins,
    }

    try {
        // 钩子与插件命令都可能在任意命令里用到；只有 version 不需要插件
        // version / key 不依赖插件，启动会更快
        if (commandName !== "version" && commandName !== "key") {
            await ensurePlugins()
        }
        setHostStatus("running")

        let outcome: CommandOutcome
        switch (commandName) {
            case "chat":
                outcome = await runConversationCommand(ctx, commandArgv, "chat")
                break
            case "run":
                outcome = await runConversationCommand(ctx, commandArgv, "run")
                break
            case "start":
                outcome = await runStartCommand(ctx)
                break
            case "stop":
                outcome = await runStopCommand(ctx)
                break
            case "session":
                outcome = await runSessionCommand(ctx, commandArgv)
                break
            case "config":
                outcome = await runConfigCommand(ctx, commandArgv)
                break
            case "plugin":
                outcome = await runPluginCommand(ctx, commandArgv)
                break
            case "doctor":
                outcome = await runDoctorCommand(ctx)
                break
            case "key":
                outcome = await runKeyCommand(ctx, commandArgv)
                break
            case "version":
                outcome = await runVersionCommand(ctx)
                break
            case "help":
                outcome = await runHelpCommand(ctx, commandArgv)
                break
            default: {
                const record = registry.resolve(commandName)
                if (record === undefined) {
                    outcome = failure(`usage.unknown-command:${commandName}`)
                    break
                }
                const pluginLogger = logger.child({ plugin: record.pluginName })
                try {
                    const pluginDataDir = await ensurePluginDataDir(record.pluginName, paths)
                    const pluginConfig = await loadPluginConfig(record.pluginName, paths)
                    const pluginFs = createPluginFileApi(pluginDataDir)
                    const workspaceFs = createPluginFileApi(process.cwd())
                    const pluginContext: PluginCommandContext = {
                        argv: commandArgv,
                        env: process.env,
                        paths,
                        config: settings,
                        logger: pluginLogger,
                        output: createPluginOutput(record.pluginName),
                        pluginDataDir,
                        pluginConfig,
                        fs: pluginFs,
                        workspaceFs,
                        cwd: process.cwd(),
                        json: jsonMode,
                        stdin: process.stdin,
                        stdout: process.stdout,
                        stderr: process.stderr,
                    }
                    const code = await withHookOwner(record.pluginName, async () =>
                        withConsoleGuard(record.pluginName, pluginLogger, async () =>
                            record.command.run(pluginContext),
                        ),
                    )
                    process.exitCode = typeof code === "number" ? code : 0
                    return
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.error({ plugin: record.pluginName, message }, "插件命令执行失败")
                    outcome = failure(`plugin.command-failed:${message}`)
                }
            }
        }
        emitOutcome(outcome, jsonMode)
    } finally {
        setHostStatus("stopped")
        await shutdownAllSandboxPlugins()
        await closeLogger()
    }
}

await main(process.argv.slice(2))
