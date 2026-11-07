/*
 * key 命令：查看 / 设置 / 清除 / 测试模型供应商的 API Key
 *
 * 默认操作当前生效供应商；--provider 指定其他供应商
 * 明文 key 只写入 <configDir>/credentials.json（0600），输出一律用掩码
 * 无参数时交互式输入或从 stdin 读取，shell 历史里不出现明文
 */

import { Result } from "../api/result/result.ts"
import { CONFIG_CODES } from "../config/codes.ts"
import {
    clearProviderApiKey,
    credentialsFile,
    normalizeApiKey,
    providerKeyStatusSync,
    resolveProviderApiKeySync,
    saveProviderApiKey,
    type ProviderKeyStatus,
} from "../config/credentials.ts"
import {
    activeModelProvider,
    findModelProvider,
    providerOpenAISettings,
    type ResolvedModelProvider,
} from "../config/providers.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { parseCommandArgs } from "../input/parse-options.ts"
import { OpenAIClient } from "../network/openai.ts"
import { createProxyFetch } from "../network/proxy.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

const MAX_STDIN_CHARS = 8192

function sourceLabel(status: ProviderKeyStatus): string {
    if (status.source === "env") {
        return `环境变量 ${status.envVar ?? ""}`.trim()
    }
    if (status.source === "credentials") {
        return `本地凭据 ${status.file}`
    }
    return "未配置"
}

function printStatus(
    ctx: CommandContext,
    provider: ResolvedModelProvider,
    status: ProviderKeyStatus,
): void {
    ctx.elog.print(`供应商: ${provider.name}（${provider.id}）`)
    ctx.elog.print(`来源: ${sourceLabel(status)}`)
    if (status.masked !== null) {
        ctx.elog.print(`Key: ${status.masked}`)
    }
    if (status.source === "env") {
        ctx.elog.print(`提示: 环境变量 ${status.envVar ?? ""} 优先生效，本地保存的 key 会被忽略`)
    }
}

/** key 默认操作当前生效供应商 */
function targetProvider(
    ctx: CommandContext,
    providerId: string | undefined,
): ResolvedModelProvider {
    if (providerId === undefined || providerId.trim() === "") {
        return activeModelProvider(ctx.settings)
    }
    const found = findModelProvider(ctx.settings, providerId.trim())
    if (found === null) {
        throw new Error(`models.provider-not-found:${providerId}`)
    }
    return found
}

/** 管道或重定向时从 stdin 读取 key */
async function readKeyFromStdin(): Promise<string | null> {
    if (process.stdin.isTTY === true) {
        return null
    }
    process.stdin.setEncoding("utf8")
    let text = ""
    for await (const chunk of process.stdin) {
        text += String(chunk)
        if (text.length > MAX_STDIN_CHARS) {
            break
        }
    }
    return text.trim()
}

/** 交互式隐藏输入，只回显星号 */
function promptHiddenApiKey(prompt: string): Promise<string | null> {
    const stdin = process.stdin
    if (stdin.isTTY !== true) {
        return Promise.resolve(null)
    }
    const wasRaw = stdin.isRaw === true
    process.stderr.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    return new Promise((resolvePromise) => {
        let text = ""
        let settled = false
        const finish = (value: string | null): void => {
            if (settled) {
                return
            }
            settled = true
            stdin.off("data", onData)
            if (wasRaw !== true) {
                stdin.setRawMode(false)
            }
            stdin.pause()
            process.stderr.write("\n")
            resolvePromise(value)
        }
        const onData = (chunk: string): void => {
            for (const char of chunk) {
                if (char === "\r" || char === "\n") {
                    finish(text.trim() === "" ? null : text.trim())
                    return
                }
                if (char === "\u0003" || char === "\u0004") {
                    finish(null)
                    return
                }
                if (char === "\u007f" || char === "\b") {
                    if (text.length > 0) {
                        text = text.slice(0, -1)
                        process.stderr.write("\b \b")
                    }
                    continue
                }
                text += char
                process.stderr.write("*")
            }
        }
        stdin.on("data", onData)
    })
}

function keyStatusOf(ctx: CommandContext, provider: ResolvedModelProvider): ProviderKeyStatus {
    return providerKeyStatusSync(
        { id: provider.id, apiKeyEnv: provider.apiKeyEnv },
        credentialsFile(ctx.paths.configDir),
    )
}

async function runTest(
    ctx: CommandContext,
    provider: ResolvedModelProvider,
    candidate: string | undefined,
): Promise<CommandOutcome> {
    const file = credentialsFile(ctx.paths.configDir)
    let apiKey: string | undefined
    if (candidate !== undefined) {
        const normalized = normalizeApiKey(candidate)
        if (normalized === null) {
            return failure(CONFIG_CODES.invalidApiKey)
        }
        apiKey = normalized
    } else {
        const resolved = resolveProviderApiKeySync(
            { id: provider.id, apiKeyEnv: provider.apiKeyEnv },
            file,
        )
        if (resolved === null) {
            return failure("openai.missing-api-key")
        }
        apiKey = resolved.apiKey
    }
    let fetch: ReturnType<typeof createProxyFetch> | undefined
    try {
        fetch = createProxyFetch(ctx.settings.network.proxy)
    } catch {
        fetch = undefined
    }
    const created = OpenAIClient.create({
        settings: providerOpenAISettings(ctx.settings, provider),
        apiKey,
        credentialsFile: file,
        logger: ctx.logger.child({ module: "openai" }),
        fetch,
    })
    const client = created.getData()
    if (!created.isSuccess() || client === null) {
        return failure(created.getCode() ?? "openai.request-failed")
    }
    const tested = await client.testConnection()
    const data = tested.getData()
    if (!tested.isSuccess() || data === null) {
        return failure(tested.getCode() ?? "openai.request-failed")
    }
    const model = provider.defaultModel ?? provider.models[0] ?? ctx.settings.openai.model
    ctx.elog.print(`连接正常: ${provider.name} 可见模型 ${data.models} 个，缺省模型 ${model}`)
    return success({ models: data.models, model, provider: provider.id })
}

export async function runKeyCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const [subcommand = "status", ...rest] = argv
    const parsed = parseCommandArgs(rest, { provider: { type: "string" } })
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }
    const rawProviderOption = line.values["provider"]
    let provider: ResolvedModelProvider
    try {
        provider = targetProvider(
            ctx,
            typeof rawProviderOption === "string" ? rawProviderOption : undefined,
        )
    } catch (error) {
        return failure(error instanceof Error ? error.message : "models.provider-not-found")
    }

    switch (subcommand) {
        case "status": {
            const status = keyStatusOf(ctx, provider)
            printStatus(ctx, provider, status)
            return success(status)
        }
        case "path": {
            const file = credentialsFile(ctx.paths.configDir)
            ctx.elog.print(file)
            return success({ path: file })
        }
        case "set": {
            const raw =
                line.positionals[0] ??
                (await readKeyFromStdin()) ??
                (await promptHiddenApiKey("粘贴 API Key（输入不回显，回车确认）: "))
            if (raw === null || raw === undefined || raw === "") {
                return failure(`${USAGE_CODES.missingValue}:key`)
            }
            const saved = await saveProviderApiKey(
                provider.id,
                raw,
                credentialsFile(ctx.paths.configDir),
            )
            if (!saved.isSuccess()) {
                return failure(saved.getCode() ?? CONFIG_CODES.credentialsWriteFailed)
            }
            const status = keyStatusOf(ctx, provider)
            ctx.elog.print(`已保存 ${provider.name}: ${status.masked ?? ""} -> ${status.file}`)
            if (status.source === "env") {
                ctx.elog.print(
                    `注意: 环境变量 ${status.envVar ?? ""} 优先，实际请求仍用环境变量里的 key`,
                )
            }
            return success(status)
        }
        case "clear": {
            const cleared = await clearProviderApiKey(
                provider.id,
                credentialsFile(ctx.paths.configDir),
            )
            if (!cleared.isSuccess()) {
                return failure(cleared.getCode() ?? CONFIG_CODES.credentialsWriteFailed)
            }
            const status = keyStatusOf(ctx, provider)
            ctx.elog.print(
                status.envOverride
                    ? `本地凭据已清除；环境变量 ${status.envVar ?? ""} 仍然生效`
                    : "本地凭据已清除",
            )
            return success(status)
        }
        case "test": {
            return await runTest(ctx, provider, line.positionals[0])
        }
        default:
            return failure(`${USAGE_CODES.unknownSubcommand}:${subcommand}`)
    }
}
