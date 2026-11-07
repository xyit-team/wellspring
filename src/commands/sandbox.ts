/*
 * sandbox 命令：维护沙盒在工作区上留下的 ACL
 *
 * 用法：
 *   wellspring sandbox cleanup [--workspace <path>]
 *
 * 默认清理当前目录；只对支持 cleanup 的后端（win-restricted）生效
 */

import { resolve } from "node:path"

import { Result } from "../api/result/result.ts"
import { USAGE_CODES } from "../input/codes.ts"
import { parseCommandArgs, stringValue } from "../input/parse-options.ts"
import { platform } from "../platform/os.ts"
import { SandboxManager } from "../sandbox/manager.ts"
import { failure, success, type CommandContext, type CommandOutcome } from "./shared.ts"

export async function runSandboxCommand(
    ctx: CommandContext,
    argv: readonly string[],
): Promise<CommandOutcome> {
    const subcommand = argv[0]
    if (subcommand === undefined) {
        return failure(USAGE_CODES.unknownSubcommand)
    }
    if (subcommand !== "cleanup") {
        return failure(`${USAGE_CODES.unknownSubcommand}:${subcommand}`)
    }
    return await cleanup(ctx, argv.slice(1))
}

async function cleanup(ctx: CommandContext, args: readonly string[]): Promise<CommandOutcome> {
    if (platform !== "windows") {
        return failure("sandbox.cleanup-unsupported")
    }
    const parsed = parseCommandArgs(args, {
        workspace: { type: "string" },
    })
    if (!parsed.isSuccess()) {
        return { result: Result.error<unknown>(parsed.getCode() ?? USAGE_CODES.invalidValue) }
    }
    const line = parsed.getData()
    if (line === null) {
        return failure(USAGE_CODES.invalidValue)
    }
    const requested = stringValue(line.values, "workspace") ?? line.positionals[0]
    const workspace = resolve(requested ?? process.cwd())
    const runner = new SandboxManager({
        settings: ctx.settings.sandbox,
        paths: ctx.paths,
        logger: ctx.logger,
    })
    try {
        await runner.cleanupWorkspace(workspace)
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return failure(`sandbox.cleanup-failed:${detail}`)
    }
    ctx.elog.info(`已清理 sandbox ACL：${workspace}`)
    return success({ workspace })
}
