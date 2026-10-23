/*
 * SandboxManager：选择 backend、准备 workspace/scratch、执行 agent-code、收集 artifact。
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import type { SandboxAccess } from "../config/types.ts"

import { auditSandbox } from "./audit.ts"
import { BwrapBackend } from "./backends/bwrap.ts"
import { DirectBackend } from "./backends/direct.ts"
import { startSandboxProcess, type SandboxProcessHandle } from "./supervisor.ts"
import {
    SandboxExecutionError,
    SandboxUnavailableError,
    type AgentCodeRequest,
    type AgentCodeResult,
    type SandboxArtifact,
    type SandboxBackend,
    type SandboxBackendStatus,
    type AgentCodeTaskHandle,
    type SandboxLimits,
    type SandboxManagerOptions,
    type StopMode,
} from "./types.ts"

const MAX_ARTIFACT_FILES = 32
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

interface ResolvedLimits extends SandboxLimits {
    readonly timeoutMs: number
    readonly memoryMB: number
    readonly pids: number
    readonly outputLimitBytes: number
}

function clampInteger(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.trunc(value)))
}

function baseEnv(): Record<string, string> {
    return {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TERM: "dumb",
    }
}

async function ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
}

function isInside(root: string, target: string): boolean {
    return target === root || target.startsWith(`${root}${sep}`)
}

async function collectArtifacts(
    scratchDir: string,
    sandboxDir: string,
): Promise<{ artifacts: SandboxArtifact[]; artifactDir: string | null }> {
    const source = join(scratchDir, "artifacts")
    const info = await stat(source).catch(() => null)
    if (info === null || !info.isDirectory()) {
        return { artifacts: [], artifactDir: null }
    }

    const destination = join(sandboxDir, "artifacts")
    await ensureDirectory(destination)
    const collected: SandboxArtifact[] = []
    let total = 0

    const entries = await readdir(source, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
        if (!entry.isFile() || collected.length >= MAX_ARTIFACT_FILES) {
            continue
        }
        const parent = entry.parentPath ?? source
        const absolute = join(parent, entry.name)
        const rel = relative(source, absolute)
        if (rel.startsWith("..") || resolve(absolute) === resolve(source)) {
            continue
        }
        const fileInfo = await stat(absolute)
        if (fileInfo.size > MAX_ARTIFACT_BYTES || total + fileInfo.size > MAX_ARTIFACT_BYTES) {
            continue
        }
        total += fileInfo.size
        const data = await readFile(absolute)
        const sha256 = createHash("sha256").update(data).digest("hex")
        const target = join(destination, rel)
        await ensureDirectory(dirname(target))
        await writeFile(target, data)
        collected.push({ path: rel.split(sep).join("/"), size: fileInfo.size, sha256 })
    }

    return { artifacts: collected, artifactDir: destination }
}

export class SandboxManager {
    readonly #options: SandboxManagerOptions
    #backend: SandboxBackend | null
    #resolved: Promise<SandboxBackend> | null = null
    #active = 0
    readonly #waiters: Array<() => void> = []

    constructor(options: SandboxManagerOptions) {
        this.#options = options
        this.#backend = options.backend ?? null
    }

    async probe(): Promise<SandboxBackendStatus> {
        if (this.#backend !== null) {
            return await this.#backend.probe()
        }
        if (this.#options.settings.backend === "nsjail") {
            return {
                available: false,
                backend: "nsjail",
                reason: "nsjail 后端尚未实现",
                version: null,
            }
        }
        return await new BwrapBackend().probe()
    }

    async #resolveBackend(access: SandboxAccess): Promise<SandboxBackend> {
        if (access === "danger-full-access") {
            return new DirectBackend()
        }
        if (this.#backend !== null) {
            return this.#backend
        }
        if (this.#resolved !== null) {
            return await this.#resolved
        }
        this.#resolved = (async (): Promise<SandboxBackend> => {
            const { settings, logger } = this.#options
            if (settings.mode === "off") {
                throw new SandboxUnavailableError("sandbox.mode = off，Agent 代码执行需要 sandbox")
            }

            const preferred = settings.backend
            const candidates: SandboxBackend[] = []
            if (preferred === "auto" || preferred === "bwrap") {
                candidates.push(new BwrapBackend())
            }
            if (preferred === "nsjail") {
                // nsjail 后端尚未实现，显式报告不可用
                throw new SandboxUnavailableError("nsjail 后端尚未实现")
            }

            for (const candidate of candidates) {
                const status = await candidate.probe()
                if (status.available) {
                    return candidate
                }
                logger?.warn(
                    { backend: candidate.name, reason: status.reason },
                    "sandbox backend 不可用",
                )
            }

            if (settings.mode === "best-effort") {
                logger?.warn(
                    { backend: "direct" },
                    "sandbox 降级为 direct（无隔离），仅限开发/受信环境",
                )
                return new DirectBackend()
            }
            throw new SandboxUnavailableError("没有可用的 OS 级 sandbox 后端")
        })()
        return await this.#resolved
    }

    async #acquireSlot(): Promise<void> {
        const max = this.#options.settings.maxConcurrent
        if (this.#active < max) {
            this.#active += 1
            return
        }
        await new Promise<void>((resolve) => {
            this.#waiters.push(resolve)
        })
        this.#active += 1
    }

    #releaseSlot(): void {
        this.#active -= 1
        const next = this.#waiters.shift()
        next?.()
    }

    #limits(request: AgentCodeRequest): ResolvedLimits {
        const settings = this.#options.settings
        return {
            timeoutMs: clampInteger(request.timeoutMs ?? settings.defaultTimeoutMs, 100, 600_000),
            memoryMB: clampInteger(request.memoryMB ?? settings.defaultMemoryMB, 32, 8_192),
            pids: clampInteger(64, 1, 512),
            outputLimitBytes: clampInteger(
                request.outputLimitBytes ?? settings.outputLimitBytes,
                1024,
                64 * 1024 * 1024,
            ),
        }
    }

    async startAgentCode(request: AgentCodeRequest): Promise<AgentCodeTaskHandle> {
        if (typeof request.command !== "string" || request.command.trim() === "") {
            throw new SandboxExecutionError("命令不能为空")
        }
        if (request.argv.some((item) => typeof item !== "string")) {
            throw new SandboxExecutionError("argv 必须是字符串数组")
        }

        const access = request.access ?? this.#options.settings.access
        if (
            access !== "read-only" &&
            access !== "workspace-write" &&
            access !== "danger-full-access"
        ) {
            throw new SandboxExecutionError(`未知 sandbox 权限：${String(access)}`)
        }
        const workspaceDir = resolve(request.workspaceDir ?? process.cwd())
        const cwd = resolve(request.cwd ?? workspaceDir)
        if (access !== "danger-full-access" && !isInside(workspaceDir, cwd)) {
            throw new SandboxExecutionError(`cwd 不在 workspace 内：${cwd}`)
        }
        const workspaceInfo = await stat(workspaceDir).catch(() => null)
        if (workspaceInfo === null || !workspaceInfo.isDirectory()) {
            throw new SandboxExecutionError(`workspace 不存在：${workspaceDir}`)
        }
        const cwdInfo = await stat(cwd).catch(() => null)
        if (cwdInfo === null || !cwdInfo.isDirectory()) {
            throw new SandboxExecutionError(`cwd 不存在：${cwd}`)
        }

        const backend = await this.#resolveBackend(access)
        await this.#acquireSlot()
        try {
            return await this.#startAgentCodeLocked(request, backend, workspaceDir, cwd, access)
        } catch (error) {
            this.#releaseSlot()
            throw error
        }
    }

    async runAgentCode(request: AgentCodeRequest): Promise<AgentCodeResult> {
        const task = await this.startAgentCode(request)
        return await task.wait()
    }

    async #startAgentCodeLocked(
        request: AgentCodeRequest,
        backend: SandboxBackend,
        workspaceDir: string,
        cwd: string,
        access: SandboxAccess,
    ): Promise<AgentCodeTaskHandle> {
        const limits = this.#limits(request)
        const sandboxId = randomUUID()
        const sandboxDir = join(this.#options.paths.dataDir, "sandbox", sandboxId)
        const scratchDir = join(sandboxDir, "scratch")
        await ensureDirectory(join(scratchDir, "tmp"))
        await ensureDirectory(join(scratchDir, "artifacts"))

        const env = baseEnv()
        if (backend.name === "bwrap") {
            env["HOME"] = "/scratch"
            env["TMPDIR"] = "/scratch/tmp"
            env["SCRATCH"] = "/scratch"
            env["WORKSPACE"] = "/workspace"
        } else {
            env["HOME"] = scratchDir
            env["TMPDIR"] = join(scratchDir, "tmp")
            env["SCRATCH"] = scratchDir
            env["WORKSPACE"] = workspaceDir
        }

        const spec = backend.buildAgentLaunch({
            workspaceDir,
            scratchDir,
            cwd,
            access,
            network: request.network,
            command: request.command,
            argv: request.argv,
            env,
            limits,
        })

        const processHandle: SandboxProcessHandle = startSandboxProcess(spec, limits, {
            stdin: request.stdin ?? "",
        })

        let finalize: Promise<AgentCodeResult> | null = null
        const wait = (): Promise<AgentCodeResult> => {
            finalize ??= (async (): Promise<AgentCodeResult> => {
                try {
                    const processResult = await processHandle.done
                    const { artifacts, artifactDir } = await collectArtifacts(
                        scratchDir,
                        sandboxDir,
                    )
                    await rm(scratchDir, { recursive: true, force: true })
                    auditSandbox(this.#options.paths, {
                        type: "sandbox.agent-code",
                        sandboxId,
                        backend: backend.name,
                        access,
                        exitCode: processResult.exitCode,
                        timedOut: processResult.timedOut,
                        durationMs: processResult.durationMs,
                        artifacts: artifacts.length,
                    })
                    this.#options.logger?.info(
                        {
                            sandboxId,
                            backend: backend.name,
                            command: basename(request.command),
                            exitCode: processResult.exitCode,
                            timedOut: processResult.timedOut,
                            durationMs: processResult.durationMs,
                        },
                        "sandbox agent-code 执行完成",
                    )
                    return {
                        sandboxId,
                        backend: backend.name,
                        access,
                        exitCode: processResult.exitCode,
                        signal: processResult.signal,
                        stdout: processResult.stdout,
                        stderr: processResult.stderr,
                        truncated: processResult.truncated,
                        timedOut: processResult.timedOut,
                        durationMs: processResult.durationMs,
                        artifacts,
                        artifactDir:
                            artifactDir === null
                                ? null
                                : backend.name === "bwrap"
                                  ? "/scratch/artifacts"
                                  : artifactDir,
                        sandboxDir: backend.name === "bwrap" ? "/scratch" : sandboxDir,
                        hostArtifactDir: artifactDir,
                        hostSandboxDir: sandboxDir,
                    }
                } finally {
                    this.#releaseSlot()
                }
            })()
            void finalize.catch(() => undefined)
            return finalize
        }

        return {
            sandboxId,
            backend: backend.name,
            access,
            get stdout() {
                return processHandle.stdout
            },
            get stderr() {
                return processHandle.stderr
            },
            stop(mode: StopMode) {
                processHandle.stop(mode)
            },
            wait,
        }
    }
}
