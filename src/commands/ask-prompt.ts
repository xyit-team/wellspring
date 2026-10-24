// ask 工具的终端提问

import { createInterface } from "node:readline"

import type { HostAgentAskRequest } from "../api/host/agent.ts"

/** 选项序号 → 选项文本；非序号返回 null */
function optionByIndex(input: string, request: HostAgentAskRequest): string | null {
    const options = request.options ?? []
    if (!/^\d+$/.test(input)) {
        return null
    }
    const index = Number(input) - 1
    return index >= 0 && index < options.length ? (options[index] ?? null) : null
}

/**
 * 终端里回答 Agent 的提问。
 * 返回答案文本；null 表示取消（SIGINT 等），空串表示跳过。
 */
export async function promptAgentAsk(request: HostAgentAskRequest): Promise<string | null> {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        return null
    }
    const out = process.stdout
    out.write(`\n[Agent 提问] ${request.question}\n`)
    const options = request.options ?? []
    for (let index = 0; index < options.length; index += 1) {
        out.write(`  ${index + 1}. ${options[index] ?? ""}\n`)
    }
    const rl = createInterface({ input: process.stdin, output: out, terminal: false })
    try {
        const line = await new Promise<string | null>((resolvePromise) => {
            let settled = false
            const finish = (value: string | null): void => {
                if (settled) {
                    return
                }
                settled = true
                resolvePromise(value)
            }
            rl.once("SIGINT", () => finish(null))
            rl.question("回答（序号或文字，直接回车跳过）> ", (answer) => finish(answer))
        })
        if (line === null) {
            return null
        }
        return optionByIndex(line.trim(), request) ?? line
    } finally {
        rl.close()
    }
}
