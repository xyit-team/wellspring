/*
 * doctor：环境与配置诊断。
 */

import { existsSync } from "node:fs"

import { describePaths, platform } from "../platform/index.ts"
import { SandboxManager } from "../sandbox/manager.ts"
import { success, type CommandContext, type CommandOutcome } from "./shared.ts"

interface Check {
    readonly name: string
    readonly ok: boolean
    readonly detail: string
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
    checks.push({
        name: "openai-key",
        ok: (process.env["OPENAI_API_KEY"] ?? "").trim() !== "",
        detail: "OPENAI_API_KEY",
    })
    checks.push({
        name: "openai",
        ok: ctx.openai !== null,
        detail: ctx.openai === null ? "客户端未就绪" : ctx.settings.openai.model,
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
    }

    return success({ checks })
}
