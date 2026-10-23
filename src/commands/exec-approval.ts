// execute_code 交互审批

import { emitKeypressEvents } from "node:readline"

import type { ExecApprovalRequest } from "./agent-turn.ts"

// 是否批准
export function isExecApprovalYes(answer: string): boolean {
    const text = answer.trim().toLowerCase()
    return text === "y" || text === "yes"
}

// 选项渲染
function renderChoice(selected: number): void {
    const options = ["[允许]", "[拒绝]"]
    const color =
        process.stdout.isTTY === true &&
        process.env["NO_COLOR"] === undefined &&
        process.env["TERM"] !== "dumb"
    const rendered = options
        .map((option, index) => {
            if (index !== selected) {
                return option
            }
            return color ? `\x1b[7m${option}\x1b[0m` : `>${option}`
        })
        .join(" ")
    process.stdout.write(`\r\x1b[2K是否允许？${rendered}  ←/→ 切换 · Enter 确认`)
}

// 终端逐次审批
export async function promptExecApproval(_request: ExecApprovalRequest): Promise<boolean> {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        return false
    }

    const stdin = process.stdin
    const wasRaw = stdin.isRaw === true
    stdin.setRawMode(true)
    stdin.resume()
    emitKeypressEvents(stdin)

    let selected = 1
    renderChoice(selected)

    return await new Promise<boolean>((resolve) => {
        const finish = (value: boolean): void => {
            stdin.off("keypress", onKeypress)
            if (!wasRaw) {
                stdin.setRawMode(false)
            }
            stdin.pause()
            process.stdout.write("\n")
            resolve(value)
        }

        const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
            switch (key.name) {
                case "left":
                case "right":
                case "tab":
                    selected = selected === 0 ? 1 : 0
                    renderChoice(selected)
                    return
                case "return":
                case "enter":
                    finish(selected === 0)
                    return
                case "escape":
                    finish(false)
                    return
                case "y":
                    selected = 0
                    renderChoice(selected)
                    finish(true)
                    return
                case "n":
                    selected = 1
                    renderChoice(selected)
                    finish(false)
                    return
                default:
                    if (key.ctrl === true && key.name === "c") {
                        finish(false)
                    }
            }
        }

        stdin.on("keypress", onKeypress)
    })
}
