/*
 * 宿主 Agent 服务：给 sandbox 插件提供聊天入口。
 * 复用 CLI 的会话存储与 Agent 轮次，不经过 stdout/readline。
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"

import type {
    HostAgentApi,
    HostAgentApprovalRequest,
    HostAgentAskRequest,
    HostAgentChatInput,
    HostAgentChatResult,
    HostAgentOpenMode,
    HostAgentStreamEvent,
    HostAgentToolEvent,
    HostWorkspaceCheck,
    HostWorkspaceFileEntry,
    HostWorkspaceFilesResult,
} from "../api/host/agent.ts"
import type { ExecApprovalRequest } from "../commands/agent-turn.ts"
import type { CommandContext } from "../commands/shared.ts"
import { executeTurn } from "../commands/conversation.ts"
import { answerAsk, cancelSessionAsks } from "../agent/pending-asks.ts"
import { credentialsFile } from "../config/credentials.ts"
import { findExecutable } from "../platform/executable.ts"
import { readTextIfExists } from "../platform/file.ts"
import { openExternal, revealExternal } from "../platform/open-external.ts"
import { DEFAULT_SETTINGS } from "../config/defaults.ts"
import { loadSettings, SETTING_FILE_NAME } from "../config/loader.ts"
import {
    effectiveModel,
    effectiveReasoning,
    providerApiKey,
    providerOpenAISettings,
    requestProvider,
    type ResolvedModelProvider,
} from "../config/providers.ts"
import type { AppSetting, SandboxAccess } from "../config/types.ts"
import { getElog } from "../logger/elog4js.ts"
import type { Logger } from "pino"
import { OpenAIClient } from "../network/openai.ts"
import { createProxyFetch } from "../network/proxy.ts"
import type { ResolvedPaths } from "../platform/path.ts"
import type { AgentToolRegistry } from "./agent-tools.ts"
import type { PluginRegistry } from "./registry.ts"
import { getSession, registerSession } from "../session/registry.ts"
import { Session } from "../session/session.ts"
import { SessionStore } from "../session/store.ts"

export interface HostAgentServiceOptions {
    readonly settings: AppSetting
    readonly paths: ResolvedPaths
    readonly logger: Logger
    readonly registry: PluginRegistry
    readonly agentTools: AgentToolRegistry
    readonly cwd?: string
}

const SANDBOX_ACCESS_VALUES: readonly SandboxAccess[] = [
    "read-only",
    "workspace-write",
    "danger-full-access",
]

/** 插件的 host.agent.* RPC 可能带上来路不明的 permission，这里按白名单校验 */
function turnPermission(input: HostAgentChatInput, fallback: SandboxAccess): SandboxAccess {
    const value: unknown = input.permission
    if (value === undefined || value === null) {
        return fallback
    }
    if (!SANDBOX_ACCESS_VALUES.includes(value as SandboxAccess)) {
        throw new Error(`permission 不合法：${String(value)}`)
    }
    return value as SandboxAccess
}

export interface HostAgentService extends HostAgentApi {
    chat(input: HostAgentChatInput): Promise<HostAgentChatResult>
}

/** 打开宿主系统的目录选择对话框；浏览器无法提供原生对话框的绝对路径 */
interface NativeCommandResult {
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
}

function runNativeCommand(command: string, args: readonly string[]): Promise<NativeCommandResult> {
    return new Promise((resolvePromise) => {
        let settled = false
        let stdout = ""
        let stderr = ""
        const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] })
        const timer = setTimeout(() => {
            child.kill("SIGTERM")
        }, 120_000)
        const finish = (code: number | null): void => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timer)
            resolvePromise({ code, stdout, stderr })
        }
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8")
        })
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8")
        })
        child.once("error", () => {
            finish(null)
        })
        child.once("close", (code) => {
            finish(code)
        })
    })
}

function hasExecutable(name: string): boolean {
    return findExecutable(name) !== null
}

/**
 * 目录选择框没返回路径时，区分「用户取消」与「对话框根本没起来」
 *
 * 以前所有失败都报「已取消」，界面因此什么都不提示：
 * zenity 打不开显示器时会带着退出码 0 和空的 stdout 退出（只往 stderr 写一行 GTK 警告），
 * 看起来和用户按了取消一模一样。这里按退出码归因，让上层能把真因说出来。
 */
function pickerOutcome(command: string, result: NativeCommandResult): HostWorkspaceCheck {
    const cancelled: HostWorkspaceCheck = { ok: false, root: "", name: "", error: "已取消" }
    // 用户关掉窗口：zenity / kdialog 退出码 1；osascript 是 AppleScript 的 -128
    if (result.code === 1 || result.stderr.includes("-128")) {
        return cancelled
    }
    if (result.code === null) {
        return { ok: false, root: "", name: "", error: `无法启动 ${command}（未找到或不可执行）` }
    }
    const detail =
        result.stderr
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")
            .pop() ?? ""
    return {
        ok: false,
        root: "",
        name: "",
        error:
            detail === ""
                ? `${command} 没有返回目录（退出码 ${result.code}）`
                : `${command} 无法显示选择框：${detail}`,
    }
}

const IGNORED_DIRECTORIES = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".pnpm-store",
    ".yarn",
    ".npm",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".output",
    ".vercel",
    ".expo",
    ".dart_tool",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".gradle",
    ".mvn",
    ".venv",
    "venv",
    "Pods",
    ".terraform",
    "__pycache__",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".idea",
    ".vscode",
])

const MAX_FILE_SCAN_ENTRIES = 20_000
const MAX_FILE_RESULTS = 30
const MAX_FILE_CANDIDATES = 2_000
const MAX_SEARCH_DEPTH = 12
const MAX_SEARCH_QUERY_CHARS = 200
const MAX_INTERJECT_CHARS = 32_000
/** 单次搜索的时间软上限：慢盘或超大仓库里不拖住宿主事件循环 */
const MAX_SEARCH_MILLISECONDS = 500
/** 浏览单个目录时最多列出的条目数 */
const MAX_BROWSE_ENTRIES = 200

async function validateWorkspacePath(path: string): Promise<HostWorkspaceCheck> {
    const value = typeof path === "string" ? path.trim() : ""
    if (value === "") {
        return { ok: false, root: "", name: "", error: "路径不能为空" }
    }
    const resolved = resolve(value)
    const name = basename(resolved)
    try {
        const info = await stat(resolved)
        if (!info.isDirectory()) {
            return { ok: false, root: resolved, name, error: "不是目录" }
        }
    } catch {
        return { ok: false, root: resolved, name, error: "目录不存在" }
    }
    return { ok: true, root: resolved, name: name === "" ? resolved : name }
}

/** query 的字符是否按顺序出现在 text 里（大小写已归一） */
function isSubsequence(query: string, text: string): boolean {
    let cursor = 0
    for (const char of text) {
        if (char === query[cursor]) {
            cursor += 1
            if (cursor === query.length) {
                return true
            }
        }
    }
    return false
}

/** 路径段匹配等级：0 全等、1 前缀、2 包含；allowSubsequence 时再加 3 子序列 */
function segmentScore(segment: string, needle: string, allowSubsequence: boolean): number | null {
    if (segment === needle) {
        return 0
    }
    if (segment.startsWith(needle)) {
        return 1
    }
    if (segment.includes(needle)) {
        return 2
    }
    if (allowSubsequence && isSubsequence(needle, segment)) {
        return 3
    }
    return null
}

/**
 * 单一关键字的打分：越小越靠前。
 * 0 文件名全等、1 文件名前缀、2 文件名某段前缀 / 扩展名、3 文件名包含、
 * 4 路径段命中、5 路径包含、6 文件名子序列；不匹配返回 null。
 * 路径子序列（任何文件都能拼出短查询）噪声太大，不参与匹配。
 */
function singleKeyScore(name: string, path: string, query: string): number | null {
    const needle = query.toLowerCase()
    if (needle === "") {
        return 0
    }
    const nameLower = name.toLowerCase()
    if (nameLower === needle) {
        return 0
    }
    if (nameLower.startsWith(needle)) {
        return 1
    }
    const segments = nameLower.split(/[.\-_\s]+/).filter((segment) => segment !== "")
    if (segments.some((segment) => segment.startsWith(needle))) {
        return 2
    }
    // ".ts" 这类只写扩展名的查询
    if (needle.startsWith(".") && nameLower.endsWith(needle)) {
        return 2
    }
    if (nameLower.includes(needle)) {
        return 3
    }
    const pathLower = path.toLowerCase()
    if (
        pathLower.startsWith(needle) ||
        pathLower.split("/").some((segment) => segment.startsWith(needle))
    ) {
        return 4
    }
    if (pathLower.includes(needle)) {
        return 5
    }
    if (isSubsequence(needle, nameLower)) {
        return 6
    }
    return null
}

/**
 * 带斜杠的查询按路径段链式匹配（a/b/c）：前几段必须依次命中目录段，
 * 最后一段命中文件名或目录名。这样 `@assets/app` 也能找到 `src/assets/app.ts`，
 * 不必先输入工作区根目录下的完整路径。
 */
function chainScore(
    pathSegments: readonly string[],
    querySegments: readonly string[],
): number | null {
    const nameSegment = pathSegments[pathSegments.length - 1]
    const lastQuery = querySegments[querySegments.length - 1]
    if (nameSegment === undefined || lastQuery === undefined) {
        return null
    }
    const lastNameScore = segmentScore(nameSegment, lastQuery, true)
    if (lastNameScore === null) {
        return null
    }
    let score = lastNameScore
    let cursor = 0
    for (let index = 0; index < querySegments.length - 1; index += 1) {
        const needle = querySegments[index]
        if (needle === undefined) {
            return null
        }
        let matched = -1
        for (let position = cursor; position < pathSegments.length - 1; position += 1) {
            const segment = pathSegments[position]
            if (segment === undefined) {
                continue
            }
            const matchedScore = segmentScore(segment, needle, false)
            if (matchedScore === null) {
                continue
            }
            matched = position
            score += matchedScore
            break
        }
        if (matched === -1) {
            return null
        }
        cursor = matched + 1
    }
    return score
}

interface FileCandidate extends HostWorkspaceFileEntry {
    readonly depth: number
    readonly score: number
}

/** 目录浏览：只列一层，目录在前，按名称排序 */
async function browseDirectory(root: string, directory: string): Promise<HostWorkspaceFilesResult> {
    let dirents
    try {
        dirents = await readdir(directory, { withFileTypes: true })
    } catch {
        return { ok: true, root, entries: [], truncated: false }
    }
    dirents.sort((left, right) => {
        const leftRank = left.isDirectory() ? 0 : 1
        const rightRank = right.isDirectory() ? 0 : 1
        if (leftRank !== rightRank) {
            return leftRank - rightRank
        }
        return left.name.localeCompare(right.name)
    })
    const entries: HostWorkspaceFileEntry[] = []
    let truncated = false
    for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) {
            continue
        }
        if (dirent.name === "." || dirent.name === "..") {
            continue
        }
        const isDirectory = dirent.isDirectory()
        // 根目录一层里藏起来的依赖/构建目录不展示；显式进入时仍可浏览
        if (isDirectory && directory === root && IGNORED_DIRECTORIES.has(dirent.name)) {
            continue
        }
        if (entries.length >= MAX_BROWSE_ENTRIES) {
            truncated = true
            break
        }
        entries.push({
            path: relative(root, join(directory, dirent.name)).split(sep).join("/"),
            name: dirent.name,
            type: isDirectory ? "directory" : "file",
        })
    }
    return { ok: true, root, entries, truncated }
}

function compareCandidates(left: FileCandidate, right: FileCandidate): number {
    if (left.score !== right.score) {
        return left.score - right.score
    }
    if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1
    }
    if (left.depth !== right.depth) {
        return left.depth - right.depth
    }
    return left.path.localeCompare(right.path)
}

/**
 * 在工作区里按文件名 / 路径搜索（广度优先，浅层条目优先进入扫描预算）。
 * - query 为空或以 `/` 结尾且路径存在：只列该目录一层
 * - 单关键字（`app`）：文件名优先，其次路径段 / 路径包含 / 子序列
 * - 带斜杠（`assets/app`）：按路径段链式匹配，不要求前缀目录真实存在
 */
export async function searchWorkspaceFiles(
    rootPath: string,
    query: string,
): Promise<HostWorkspaceFilesResult> {
    const check = await validateWorkspacePath(rootPath)
    if (!check.ok) {
        return {
            ok: false,
            root: "",
            entries: [],
            truncated: false,
            error: check.error ?? "目录不可用",
        }
    }
    const root = check.root
    const raw = (typeof query === "string" ? query : "").trim().replaceAll("\\", "/")
    if (raw.length > MAX_SEARCH_QUERY_CHARS) {
        return {
            ok: false,
            root,
            entries: [],
            truncated: false,
            error: "搜索词过长",
        }
    }
    const withoutLeading = raw.replace(/^\/+/, "")
    const segments = withoutLeading
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".")
    if (segments.length === 0) {
        return await browseDirectory(root, root)
    }

    // 输入了完整目录路径（以 / 结尾）时直接列出它的内容
    if (withoutLeading.endsWith("/")) {
        const target = resolve(root, segments.join("/"))
        const rel = relative(root, target)
        if (!rel.startsWith("..") && !isAbsolute(rel)) {
            try {
                const info = await stat(target)
                if (info.isDirectory()) {
                    return await browseDirectory(root, target)
                }
            } catch {
                /* 目录不存在，退回模糊搜索 */
            }
        }
    }

    const querySegments = segments.map((segment) => segment.toLowerCase())
    const singleNeedle = querySegments.length === 1 ? (querySegments[0] ?? null) : null
    const candidates: FileCandidate[] = []
    const deadline = performance.now() + MAX_SEARCH_MILLISECONDS
    let visited = 0
    let truncated = false
    const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: root, depth: 0 }]
    while (queue.length > 0) {
        if (visited >= MAX_FILE_SCAN_ENTRIES || performance.now() > deadline) {
            truncated = true
            break
        }
        const current = queue.shift()
        if (current === undefined) {
            break
        }
        let dirents
        try {
            dirents = await readdir(current.dir, { withFileTypes: true })
        } catch {
            continue
        }
        dirents.sort((left, right) => left.name.localeCompare(right.name))
        for (const dirent of dirents) {
            if (visited >= MAX_FILE_SCAN_ENTRIES || candidates.length >= MAX_FILE_CANDIDATES) {
                truncated = true
                break
            }
            visited += 1
            if (dirent.isSymbolicLink()) {
                continue
            }
            const isDirectory = dirent.isDirectory()
            if (isDirectory && IGNORED_DIRECTORIES.has(dirent.name)) {
                continue
            }
            const rel = relative(root, join(current.dir, dirent.name)).split(sep).join("/")
            const score =
                singleNeedle === null
                    ? chainScore(rel.split("/"), querySegments)
                    : singleKeyScore(dirent.name, rel, singleNeedle)
            if (score !== null) {
                candidates.push({
                    path: rel,
                    name: dirent.name,
                    type: isDirectory ? "directory" : "file",
                    depth: current.depth,
                    score,
                })
            }
            if (isDirectory && current.depth < MAX_SEARCH_DEPTH) {
                queue.push({ dir: join(current.dir, dirent.name), depth: current.depth + 1 })
            }
        }
    }
    candidates.sort(compareCandidates)
    const entries = candidates.slice(0, MAX_FILE_RESULTS).map((entry) => ({
        path: entry.path,
        name: entry.name,
        type: entry.type,
    }))
    const limited = candidates.length > MAX_FILE_RESULTS
    return { ok: true, root, entries, truncated: truncated || limited }
}

export function createHostAgentService(options: HostAgentServiceOptions): HostAgentService {
    const cwd = options.cwd ?? process.cwd()
    const store = new SessionStore()
    const queues = new Map<string, Promise<unknown>>()
    /**
     * 每个会话当前这一轮的 AbortController
     *
     * stop() 除了标记停止，还要把正在进行的模型请求打断——
     * 否则「停止」只是等这一轮自己跑完，慢模型要等很久。
     */
    const turnAborts = new Map<string, AbortController>()
    const pendingApprovals = new Map<
        string,
        {
            readonly sessionId: string
            readonly resolve: (approved: boolean) => void
            readonly timer: ReturnType<typeof setTimeout>
        }
    >()
    const APPROVAL_TIMEOUT_MS = 120_000

    const settleApproval = (approvalId: string, approved: boolean): boolean => {
        const pending = pendingApprovals.get(approvalId)
        if (pending === undefined) {
            return false
        }
        pendingApprovals.delete(approvalId)
        clearTimeout(pending.timer)
        pending.resolve(approved)
        return true
    }

    /** 停止一轮时把它挂着的提权请求按拒绝了结，避免循环卡在等待里 */
    const settleSessionApprovals = (sessionId: string): void => {
        for (const [approvalId, pending] of [...pendingApprovals]) {
            if (pending.sessionId !== sessionId) {
                continue
            }
            pendingApprovals.delete(approvalId)
            clearTimeout(pending.timer)
            pending.resolve(false)
        }
    }

    const settingsPath = join(options.paths.configDir, SETTING_FILE_NAME)

    // 每轮都读一次配置与凭据：网页/CLI 改供应商、模型、Key 后不需要重启服务。
    // 配置文件不存在时用启动时传入的配置（测试与 --config 覆盖场景依赖这一点）。
    const currentSettings = async (): Promise<AppSetting> => {
        try {
            if ((await readTextIfExists(settingsPath)) === null) {
                return options.settings ?? DEFAULT_SETTINGS
            }
            const loaded = await loadSettings(settingsPath)
            return loaded.getData() ?? options.settings ?? DEFAULT_SETTINGS
        } catch {
            return options.settings ?? DEFAULT_SETTINGS
        }
    }

    const createProviderClient = (
        settings: AppSetting,
        provider: ResolvedModelProvider,
    ): OpenAIClient => {
        let proxyFetch: ReturnType<typeof createProxyFetch> | undefined
        try {
            proxyFetch = createProxyFetch(settings.network.proxy)
        } catch {
            proxyFetch = undefined
        }
        // 自定义供应商没有 key 时不能悄悄回落到内置 OpenAI key：显式传空串让创建失败
        const apiKey = providerApiKey(provider, options.paths.configDir) ?? ""
        const result = OpenAIClient.create({
            settings: providerOpenAISettings(settings, provider),
            apiKey,
            credentialsFile: credentialsFile(options.paths.configDir),
            logger: options.logger.child({ module: "openai" }),
            fetch: proxyFetch,
        })
        const created = result.getData()
        if (!result.isSuccess() || created === null) {
            throw new Error(result.getCode() ?? "openai.missing-api-key")
        }
        return created
    }

    const context = (
        settings: AppSetting,
        client: OpenAIClient,
        model: string,
        provider: ResolvedModelProvider,
    ): CommandContext => ({
        global: { json: true, quiet: true, help: false, version: false },
        settings,
        settingsFile: settingsPath,
        configCode: null,
        paths: options.paths,
        logger: options.logger,
        elog: getElog(),
        registry: options.registry,
        agentTools: options.agentTools,
        openai: client,
        activeProvider: provider.id,
        activeModel: model,
        loadPlugins: async () => [],
    })

    /** 校验工作目录：存在且是目录 */
    const validateWorkspace = async (path: string): Promise<HostWorkspaceCheck> => {
        return await validateWorkspacePath(path)
    }

    /**
     * 用宿主系统打开路径
     *
     * 只接受绝对路径：界面传入的路径可能来自模型输出，以 "-" 开头的相对名会被系统命令当成参数
     */
    const openPath = async (path: string, mode: HostAgentOpenMode = "default"): Promise<void> => {
        const target = typeof path === "string" ? path.trim() : ""
        if (target === "" || !isAbsolute(target)) {
            throw new Error(`只能打开绝对路径：${target === "" ? "（空）" : target}`)
        }
        if (mode === "reveal") {
            await revealExternal(target)
            return
        }
        await openExternal(target)
    }

    /** 打开原生目录选择对话框：Linux 用 zenity/kdialog，macOS 用 osascript，Windows 用 FolderBrowserDialog */
    const pickDirectory = async (): Promise<HostWorkspaceCheck> => {
        const title = "选择工作区文件夹"
        if (process.platform === "darwin") {
            const result = await runNativeCommand("osascript", [
                "-e",
                `POSIX path of (choose folder with prompt "${title}")`,
            ])
            const selected = result.stdout.trim()
            if (result.code === 0 && selected !== "") {
                return await validateWorkspace(selected)
            }
            return pickerOutcome("osascript", result)
        }
        if (process.platform === "win32") {
            const script = [
                "Add-Type -AssemblyName System.Windows.Forms",
                "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
                `$dialog.Description = '${title}'`,
                "if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }",
            ].join("; ")
            const result = await runNativeCommand("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            const selected = result.stdout.trim()
            if (result.code === 0 && selected !== "") {
                return await validateWorkspace(selected)
            }
            return pickerOutcome("powershell", result)
        }
        if (hasExecutable("zenity")) {
            const result = await runNativeCommand("zenity", [
                "--file-selection",
                "--directory",
                "--title",
                title,
            ])
            const selected = result.stdout.trim()
            return result.code === 0 && selected !== ""
                ? await validateWorkspace(selected)
                : pickerOutcome("zenity", result)
        }
        if (hasExecutable("kdialog")) {
            const result = await runNativeCommand("kdialog", [
                "--getexistingdirectory",
                homedir(),
                "--title",
                title,
            ])
            const selected = result.stdout.trim()
            return result.code === 0 && selected !== ""
                ? await validateWorkspace(selected)
                : pickerOutcome("kdialog", result)
        }
        return {
            ok: false,
            root: "",
            name: "",
            error: "没有可用的系统文件夹对话框（Linux 需要 zenity 或 kdialog）",
        }
    }

    const chatOnce = async (
        input: HostAgentChatInput,
        onDelta?: (text: string) => void,
        onStep?: (event: { readonly turn: number; readonly step: number }) => void,
        onApproval?: (request: HostAgentApprovalRequest) => void,
        onReasoning?: (text: string) => void,
        onTool?: (event: HostAgentToolEvent) => void,
        onAsk?: (request: HostAgentAskRequest) => void,
        onSession?: (sessionId: string) => void,
    ): Promise<HostAgentChatResult> => {
        const message = input.message.trim()
        if (message === "") {
            throw new Error("消息不能为空")
        }
        const settings = await currentSettings()
        const provider = requestProvider(settings, input.provider)
        const model = effectiveModel(settings, provider, input.model)
        const reasoning = effectiveReasoning(settings, provider, input.reasoning)
        const client = createProviderClient(settings, provider)
        const permission = turnPermission(input, settings.sandbox.access)
        if (permission !== settings.sandbox.access) {
            // 插件可以在单轮里提升权限（例如网页的权限切换器）；记录下来便于审计
            options.logger.warn(
                {
                    requested: permission,
                    configured: settings.sandbox.access,
                    sessionId: input.sessionId ?? null,
                },
                permission === "danger-full-access"
                    ? "插件本轮请求 danger-full-access 权限"
                    : "插件本轮覆盖 sandbox 权限",
            )
        }
        let turnCwd = cwd
        if (input.cwd !== undefined) {
            const workspace = await validateWorkspace(input.cwd)
            if (!workspace.ok) {
                throw new Error(`工作区不可用：${workspace.error ?? "目录不存在"}`)
            }
            turnCwd = workspace.root
        }
        const references = Array.isArray(input.references)
            ? input.references
                  .filter(
                      (item): item is string =>
                          typeof item === "string" && item !== "" && item.length <= 512,
                  )
                  .slice(0, 20)
            : []
        const messageForAgent =
            references.length === 0
                ? message
                : `${message}\n\n引用的工作区路径：\n${references.map((item) => `- ${item}`).join("\n")}\n需要时请按路径读取。`
        const data =
            input.sessionId === undefined
                ? await store.create({ cwd: turnCwd, model })
                : await store.open(input.sessionId, turnCwd)
        registerSession(new Session(data, store))
        onSession?.(data.meta.id)
        const requestApproval =
            onApproval === undefined
                ? undefined
                : async (request: ExecApprovalRequest): Promise<boolean> => {
                      const approvalId = `apv_${randomUUID()}`
                      return await new Promise<boolean>((resolvePromise) => {
                          const timer = setTimeout(() => {
                              pendingApprovals.delete(approvalId)
                              resolvePromise(false)
                          }, APPROVAL_TIMEOUT_MS)
                          pendingApprovals.set(approvalId, {
                              sessionId: data.meta.id,
                              resolve: (approved) => resolvePromise(approved),
                              timer,
                          })
                          try {
                              onApproval({
                                  approvalId,
                                  command: request.command,
                                  argv: request.argv,
                                  cwd: request.cwd,
                                  currentPermission: request.currentPermission,
                                  requestedPermission: request.requestedPermission,
                                  justification: request.justification,
                                  ...(request.network === true ? { network: true } : {}),
                                  ...(request.background === true ? { background: true } : {}),
                                  ...(typeof request.stdin === "string" && request.stdin !== ""
                                      ? { stdin: request.stdin }
                                      : {}),
                                  ...(typeof request.timeoutMs === "number"
                                      ? { timeoutMs: request.timeoutMs }
                                      : {}),
                              })
                          } catch {
                              pendingApprovals.delete(approvalId)
                              clearTimeout(timer)
                              resolvePromise(false)
                          }
                      })
                  }
        const turnAbort = new AbortController()
        turnAborts.set(data.meta.id, turnAbort)
        let result
        try {
            result = await executeTurn({
                ctx: context(settings, client, model, provider),
                signal: turnAbort.signal,
                client,
                store,
                session: data,
                mode: "run",
                input: messageForAgent,
                model,
                reasoning,
                system: input.system,
                stream: false,
                display: false,
                allowExec: false,
                permission,
                onDelta,
                onReasoning,
                onTool,
                onStep,
                approveExec: requestApproval,
                ...(onAsk === undefined
                    ? // 没有界面通道（agent.chat）时立即跳过提问，避免一轮对话挂到超时
                      { askUser: async () => null }
                    : { onAsk }),
            })
        } finally {
            turnAborts.delete(data.meta.id)
        }
        if (!result.isSuccess()) {
            throw new Error(result.getCode() ?? "agent.failed")
        }
        const turn = result.getData()
        if (turn === null) {
            throw new Error("agent.empty-result")
        }
        return {
            sessionId: turn.sessionId,
            turn: turn.turn,
            steps: turn.steps,
            reply: turn.reply,
            model: turn.model,
            usage: turn.usage,
        }
    }

    const enqueue = async (
        input: HostAgentChatInput,
        onDelta?: (text: string) => void,
        onStep?: (event: { readonly turn: number; readonly step: number }) => void,
        onApproval?: (request: HostAgentApprovalRequest) => void,
        onReasoning?: (text: string) => void,
        onTool?: (event: HostAgentToolEvent) => void,
        onAsk?: (request: HostAgentAskRequest) => void,
        onSession?: (sessionId: string) => void,
    ): Promise<HostAgentChatResult> => {
        const key = `${input.cwd ?? ""}|${input.sessionId ?? "new"}`
        const previous = queues.get(key) ?? Promise.resolve()
        const next = previous.then(
            async () =>
                await chatOnce(
                    input,
                    onDelta,
                    onStep,
                    onApproval,
                    onReasoning,
                    onTool,
                    onAsk,
                    onSession,
                ),
            async () =>
                await chatOnce(
                    input,
                    onDelta,
                    onStep,
                    onApproval,
                    onReasoning,
                    onTool,
                    onAsk,
                    onSession,
                ),
        )
        queues.set(
            key,
            next.catch(() => undefined),
        )
        const result = await next
        if (input.sessionId === undefined) {
            queues.delete(key)
            queues.set(result.sessionId, Promise.resolve(result))
        }
        return result
    }

    return {
        async chat(input) {
            return await enqueue(input)
        },
        validateWorkspace,
        pickDirectory,
        openPath,
        async searchWorkspaceFiles(root, query) {
            return await searchWorkspaceFiles(root, query)
        },
        async stream(input, onEvent: (event: HostAgentStreamEvent) => void) {
            return await enqueue(
                input,
                (text) => onEvent({ type: "delta", text }),
                (event) => onEvent({ type: "step", turn: event.turn, step: event.step }),
                (request) => onEvent({ type: "approval", request }),
                (text) => onEvent({ type: "reasoning", text }),
                (event) => onEvent({ type: "tool", ...event }),
                (request) => onEvent({ type: "ask", request }),
                (sessionId) => onEvent({ type: "session", sessionId }),
            )
        },
        async interject(sessionId, message) {
            const content = typeof message === "string" ? message.trim() : ""
            if (content === "") {
                return false
            }
            const session = getSession(sessionId)
            // 只有正在跑的一轮才能插话；其余情况交给调用方按新一轮处理
            if (session === null || !session.active) {
                return false
            }
            await session.message(content.slice(0, MAX_INTERJECT_CHARS), "interject")
            return true
        },
        async stop(sessionId) {
            const session = getSession(sessionId)
            if (session === null || !session.active) {
                return false
            }
            session.requestStop()
            // 挂着等人的请求就地了结，循环才能读到停止标记
            cancelSessionAsks(sessionId)
            settleSessionApprovals(sessionId)
            // 打断正在进行的模型请求：已收到的正文照常保留，本轮按「已停止」收尾
            turnAborts.get(sessionId)?.abort()
            return true
        },
        async respondApproval(approvalId, approved) {
            return settleApproval(approvalId, approved)
        },
        async respondAsk(askId, answer) {
            return answerAsk(askId, answer)
        },
    }
}
