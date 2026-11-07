#!/usr/bin/env node
/*
 * PTY 可用性探测：node-pty 与 python3 两条后端各拉起一次真实会话
 *
 * 终端打不开有两种根因：原生模块 ABI 不匹配、python3 不可用
 * 本脚本开 shell 并读回显，两条后端分别判定
 *
 * 用法：node scripts/check-pty.mjs [--json]
 * 退出码：0 至少一条后端可用；1 两条都不可用
 */

import { spawn } from "node:child_process"
import { join } from "node:path"

const BRIDGE = join(import.meta.dirname, "..", "src", "sandbox", "pty-bridge.py")
const MARKER = "wellspring-pty-probe"
const TIMEOUT_MS = 9000

const results = []

function shellPath() {
    for (const candidate of [process.env.SHELL, "/bin/bash", "/bin/sh"]) {
        if (typeof candidate === "string" && candidate !== "") return candidate
    }
    return "/bin/sh"
}

function record(backend, ok, detail) {
    results.push({ backend, ok, detail })
}

// 等到 marker 出现或超时
function untilMarker(onData, timeoutMs = TIMEOUT_MS) {
    let buffer = ""
    let settle = () => {}
    const promise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(buffer), timeoutMs)
        settle = () => {
            clearTimeout(timer)
            resolve(buffer)
        }
        onData((chunk) => {
            buffer += chunk
            if (buffer.includes(MARKER)) settle()
        })
    })
    return { promise, stop: settle }
}

async function checkNodePty() {
    let mod
    try {
        mod = await import("node-pty")
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        record("node-pty", false, `import 失败：${reason}`)
        return
    }
    const spawnPty = mod.spawn ?? mod.default?.spawn
    if (typeof spawnPty !== "function") {
        record("node-pty", false, "已加载但没有导出 spawn")
        return
    }

    const shell = shellPath()
    let pty
    try {
        pty = spawnPty(shell, [], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        record("node-pty", false, `spawn 失败：${reason}`)
        return
    }

    const waiter = untilMarker((cb) => pty.onData(cb))
    setTimeout(() => {
        try {
            pty.write(`echo ${MARKER}\r`)
        } catch {
            // 已退出
        }
    }, 300)
    const output = await waiter.promise
    try {
        pty.kill()
    } catch {
        // 已退出
    }
    if (output.includes(MARKER)) {
        record("node-pty", true, `spawn ${shell} 并读回显成功`)
    } else {
        const head = output.trim().slice(0, 120)
        record("node-pty", false, `无回显${head === "" ? "" : `：${head}`}`)
    }
}

async function probePython() {
    for (const candidate of ["python3", "python"]) {
        const ok = await new Promise((resolve) => {
            try {
                const probe = spawn(candidate, ["-c", "import pty, termios"], { stdio: "ignore" })
                probe.on("error", () => resolve(false))
                probe.on("close", (code) => resolve(code === 0))
            } catch {
                resolve(false)
            }
        })
        if (ok) return candidate
    }
    return null
}

async function checkPythonPty() {
    const python = await probePython()
    if (python === null) {
        record(
            "python-pty",
            false,
            process.platform === "darwin"
                ? "python3 与 python 都不可用；macOS 需 xcode-select --install"
                : "python3 与 python 都不可用",
        )
        return
    }

    const shell = shellPath()
    const config = { shell, cwd: process.cwd(), cols: 80, rows: 24 }
    let child
    try {
        child = spawn(python, [BRIDGE, JSON.stringify(config)], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: process.cwd(),
            env: process.env,
            detached: process.platform !== "win32",
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        record("python-pty", false, `启动 pty-bridge 失败：${reason}`)
        return
    }

    let stderr = ""
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8")
    })

    const waiter = untilMarker((cb) =>
        child.stdout.on("data", (chunk) => cb(chunk.toString("utf8"))),
    )
    setTimeout(() => {
        try {
            child.stdin.write(`${JSON.stringify({ type: "input", data: `echo ${MARKER}\r` })}\n`)
        } catch {
            // 已退出
        }
    }, 500)
    const output = await waiter.promise

    try {
        child.stdin.write(`${JSON.stringify({ type: "kill" })}\n`)
        child.kill()
    } catch {
        // 已退出
    }

    if (output.includes(MARKER)) {
        record("python-pty", true, `${python} + pty-bridge 回显正常`)
        return
    }
    const firstError = stderr.trim().split("\n")[0] ?? ""
    record("python-pty", false, `pty-bridge 无回显${firstError === "" ? "" : `：${firstError}`}`)
}

await checkNodePty()
await checkPythonPty()

const usable = results.filter((item) => item.ok)
const summary = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    shell: process.env.SHELL ?? null,
    results,
    usable: usable.map((item) => item.backend),
}

if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 4))
} else {
    console.log(
        `平台 ${summary.platform}/${summary.arch}  Node ${summary.node}  SHELL ${summary.shell ?? "(未设置)"}`,
    )
    for (const item of results) {
        console.log(`  [${item.ok ? "ok  " : "FAIL"}] ${item.backend.padEnd(12)} ${item.detail}`)
    }
    console.log(
        usable.length === 0
            ? "两条后端都不可用，终端无法打开"
            : `可用后端：${summary.usable.join(", ")}`,
    )
}

process.exit(usable.length === 0 ? 1 : 0)
