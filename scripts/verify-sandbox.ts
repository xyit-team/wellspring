#!/usr/bin/env node
/*
 * 真实 bwrap 隔离验证脚本。
 * 在允许非特权 user namespace 的 Linux 上运行：node scripts/verify-sandbox.ts
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import { getPaths, initPaths } from "../src/platform/path.ts"
import { SandboxManager } from "../src/sandbox/manager.ts"

initPaths()
const manager = new SandboxManager({
    settings: { ...DEFAULT_SETTINGS.sandbox, mode: "strict", backend: "auto" },
    paths: getPaths(),
})

const probe = await manager.probe()
console.log("probe:", probe)
if (!probe.available) {
    console.error("\nbwrap 不可用，先确认：")
    console.error("  unshare -Ur true")
    console.error("  bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc /bin/true")
    console.error(
        "Ubuntu 24.04 可能被 AppArmor 限制：sysctl kernel.apparmor_restrict_unprivileged_userns",
    )
    process.exit(1)
}

const workspace = await mkdtemp(join(tmpdir(), "wellspring-verify-"))
let failed = 0

async function run(
    name: string,
    command: string,
    argv: string[],
    expect: (exitCode: number | null, stdout: string, stderr: string) => boolean,
): Promise<void> {
    const result = await manager.runAgentCode({
        command,
        argv,
        workspaceDir: workspace,
        timeoutMs: 15_000,
    })
    const ok = expect(result.exitCode, result.stdout, result.stderr)
    if (!ok) {
        failed += 1
    }
    console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`)
    console.log(`  exit=${String(result.exitCode)} backend=${result.backend}`)
    console.log(`  stdout=${result.stdout.trim()}`)
    if (result.stderr.trim() !== "") {
        console.log(`  stderr=${result.stderr.trim()}`)
    }
}

try {
    await run("读取 /etc/shadow 应失败", "/usr/bin/cat", ["/etc/shadow"], (code) => code !== 0)

    await run(
        "写 workspace 应失败（只读挂载）",
        "/bin/sh",
        ["-c", "echo escape > escape.txt"],
        (code) => code !== 0,
    )

    await run(
        "写 scratch 应成功",
        "/bin/sh",
        ["-c", 'echo ok > "$SCRATCH/t.txt" && cat "$SCRATCH/t.txt"'],
        (_code, stdout) => stdout.includes("ok"),
    )

    await run(
        "网络应被拒绝",
        "node",
        [
            "-e",
            "fetch('http://1.1.1.1', {signal: AbortSignal.timeout(2000)}).then(() => { console.log('network-ok'); process.exit(2) }).catch((e) => { console.log('network-blocked:' + e.message); process.exit(0) })",
        ],
        (_code, stdout) => stdout.includes("network-blocked"),
    )

    await run(
        "读取宿主源码应失败",
        "/usr/bin/cat",
        [join(process.cwd(), "src", "index.ts")],
        (code) => code !== 0,
    )
} finally {
    await rm(workspace, { recursive: true, force: true })
}

console.log(failed === 0 ? "\n所有 sandbox 检查通过" : `\n${failed} 个检查失败`)
process.exit(failed === 0 ? 0 : 1)
