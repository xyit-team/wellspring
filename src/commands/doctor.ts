/*
 * doctor 命令：环境与配置诊断
 */

import { existsSync } from "node:fs"

import { apiKeyStatusSync, credentialsFile } from "../config/credentials.ts"
import { describePaths, isAndroid, platform } from "../platform/index.ts"
import { SandboxManager } from "../sandbox/manager.ts"
import { success, type CommandContext, type CommandOutcome } from "./shared.ts"

interface Check {
    readonly name: string
    readonly ok: boolean
    readonly detail: string
    /** 失败项附加的下一步提示 */
    readonly hint?: string
}

/** sandbox 不可用时的替代方案；Android 与 Linux 不同 */
function sandboxHint(): string {
    if (isAndroid) {
        return "插件仍可用 Node permission model（只限制文件读写）；Agent 命令需 sandbox.mode=best-effort 才以宿主身份执行"
    }
    return "装上 bwrap，或把 sandbox.mode 设为 best-effort（以宿主身份执行，无隔离）"
}

export async function runDoctorCommand(ctx: CommandContext): Promise<CommandOutcome> {
    const checks: Check[] = []
    const major = Number(process.versions.node.split(".")[0])
    checks.push({ name: "node", ok: major >= 24, detail: process.versions.node })
    checks.push({ name: "platform", ok: true, detail: platform })
    checks.push({
        name: "paths",
        ok: true,
        detail: describePaths(ctx.paths).replaceAll("\n", " | "),
    })
    checks.push({
        name: "config",
        ok: ctx.configCode === null,
        detail: ctx.configCode ?? ctx.settingsFile,
    })
    const keyStatus = apiKeyStatusSync(credentialsFile(ctx.paths.configDir))
    const keySource =
        keyStatus.source === "env"
            ? "OPENAI_API_KEY"
            : keyStatus.source === "credentials"
              ? keyStatus.file
              : null
    checks.push({
        name: "openai-key",
        ok: keyStatus.configured,
        detail:
            keySource === null
                ? "未配置（wellspring key set 或 OPENAI_API_KEY）"
                : `${keySource} ${keyStatus.masked ?? ""}`.trim(),
    })
    checks.push({
        name: "openai",
        ok: ctx.openai !== null,
        detail:
            ctx.openai === null
                ? "客户端未就绪"
                : `${ctx.activeProvider ?? "openai"} / ${ctx.activeModel ?? ctx.settings.openai.model}`,
    })
    checks.push({
        name: "proxy",
        ok: true,
        detail: ctx.settings.network.proxy?.url ?? "直连",
    })
    checks.push({
        name: "log-file",
        ok: existsSync(ctx.paths.logDir),
        detail: ctx.paths.logDir,
    })

    const sandboxProbe = await new SandboxManager({
        settings: ctx.settings.sandbox,
        paths: ctx.paths,
    }).probe()
    const sandboxOk = ctx.settings.sandbox.mode !== "strict" || sandboxProbe.available
    checks.push({
        name: "sandbox",
        ok: sandboxOk,
        detail: `${ctx.settings.sandbox.mode}/${sandboxProbe.backend}/${ctx.settings.sandbox.access}${sandboxProbe.available ? "" : `：${sandboxProbe.reason ?? "不可用"}`}`,
        ...(sandboxOk ? {} : { hint: sandboxHint() }),
    })

    const plugins = await ctx.loadPlugins()
    const disabled = plugins.filter((plugin) => plugin.status === "disabled").length
    checks.push({
        name: "plugins",
        ok: plugins.every((plugin) => plugin.status !== "failed"),
        detail: `${plugins.length} 个${disabled > 0 ? `（禁用 ${disabled}）` : ""}`,
    })

    for (const check of checks) {
        const tag = check.ok ? "[ OK  ]" : "[FAIL ]"
        ctx.elog.print(`${tag} ${check.name.padEnd(10)} ${check.detail}`)
        if (!check.ok && check.hint !== undefined) {
            ctx.elog.print(`${" ".repeat(19)}${check.hint}`)
        }
    }

    return success({ checks })
}
