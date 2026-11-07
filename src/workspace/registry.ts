/*
 * 宿主级工作区注册表
 *
 * 工作区（用户手动添加的目录）由宿主统一管理，存在 <dataDir>/workspaces.json
 * 插件通过 `api.workspaces` 读写
 *
 * 首次加载时兼容迁移旧版 wellspring-web 插件数据目录里的 workspaces.json：
 * 只读取 id / name / root / createdAt / lastSeenAt 这些索引字段，不涉及会话正文与认证数据
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import type { ResolvedPaths } from "../platform/path.ts"
import { getPaths } from "../platform/path.ts"
import type {
    HostWorkspaceAddResult,
    HostWorkspaceEntry,
    HostWorkspaceListResult,
} from "../api/host/workspace.ts"

const REGISTRY_VERSION = 1
const REGISTRY_FILE = "workspaces.json"
const LEGACY_PLUGIN_DIR = "wellspring-web"

export const MAX_WORKSPACES = 40
export const MAX_WORKSPACE_NAME_CHARS = 60
export const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

interface RegistryFile {
    readonly v: number
    readonly workspaces: readonly HostWorkspaceEntry[]
}

interface RegistryState {
    readonly file: string
    readonly legacyFile: string
    workspaces: HostWorkspaceEntry[]
    loaded: boolean
    queue: Promise<unknown>
}

const states = new Map<string, RegistryState>()

export function workspaceRegistryFile(paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, REGISTRY_FILE)
}

export function legacyWorkspaceRegistryFile(paths: ResolvedPaths = getPaths()): string {
    return join(paths.dataDir, "plugin-data", LEGACY_PLUGIN_DIR, REGISTRY_FILE)
}

// 由工作目录派生稳定 id；算法与旧版 wellspring-web 一致，会话目录可对应
export function workspaceIdFor(root: string): string {
    const slug = basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24)
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 10)
    return slug === "" ? `workspace-${hash}` : `${slug}-${hash}`
}

export function normalizeWorkspaceName(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }
    const name = value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (name === "" || name.length > MAX_WORKSPACE_NAME_CHARS) {
        return null
    }
    return name
}

function finiteTimestamp(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : fallback
}

function normalizeEntry(value: unknown, fallbackId: string): HostWorkspaceEntry | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null
    }
    const record = value as Record<string, unknown>
    const rootRaw = record["root"]
    if (typeof rootRaw !== "string" || rootRaw.trim() === "") {
        return null
    }
    const root = resolve(rootRaw.trim())
    const rawId = record["id"]
    const id = typeof rawId === "string" && WORKSPACE_ID.test(rawId) ? rawId : fallbackId
    const rawName = record["name"]
    const name =
        normalizeWorkspaceName(rawName) ?? (basename(root) === "" ? "工作区" : basename(root))
    const now = Date.now()
    return {
        id,
        name,
        root,
        createdAt: finiteTimestamp(record["createdAt"], now),
        lastSeenAt: finiteTimestamp(record["lastSeenAt"], now),
    }
}

/** 解析注册表文件；接受 { v, workspaces } 与旧版纯数组，非法条目忽略 */
export function parseWorkspaceEntries(value: unknown): HostWorkspaceEntry[] {
    let list: unknown = value
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        list = (value as Record<string, unknown>)["workspaces"]
    }
    if (!Array.isArray(list)) {
        return []
    }
    const entries: HostWorkspaceEntry[] = []
    const seenIds = new Set<string>()
    const seenRoots = new Set<string>()
    for (const item of list) {
        if (entries.length >= MAX_WORKSPACES) {
            break
        }
        const rawRoot =
            typeof item === "object" && item !== null
                ? (item as Record<string, unknown>)["root"]
                : undefined
        const fallbackId = typeof rawRoot === "string" ? workspaceIdFor(resolve(rawRoot)) : ""
        const entry = normalizeEntry(item, fallbackId)
        if (entry === null || entry.id === "") {
            continue
        }
        if (seenIds.has(entry.id) || seenRoots.has(entry.root)) {
            continue
        }
        seenIds.add(entry.id)
        seenRoots.add(entry.root)
        entries.push(entry)
    }
    return entries
}

function stateFor(paths: ResolvedPaths): RegistryState {
    const file = workspaceRegistryFile(paths)
    const existing = states.get(file)
    if (existing !== undefined) {
        return existing
    }
    const state: RegistryState = {
        file,
        legacyFile: legacyWorkspaceRegistryFile(paths),
        workspaces: [],
        loaded: false,
        queue: Promise.resolve(),
    }
    states.set(file, state)
    return state
}

async function readJson(path: string): Promise<unknown> {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw)
}

async function writeRegistry(state: RegistryState): Promise<void> {
    await mkdir(dirname(state.file), { recursive: true })
    const payload: RegistryFile = { v: REGISTRY_VERSION, workspaces: state.workspaces }
    const temporary = `${state.file}.tmp`
    await writeFile(temporary, `${JSON.stringify(payload, null, 4)}\n`, "utf8")
    await rename(temporary, state.file)
}

// 注册表损坏时改名为 .broken，按空表启动
async function quarantine(state: RegistryState): Promise<void> {
    try {
        await rename(state.file, `${state.file}.broken`)
    } catch {
        /* 文件可能已经不存在 */
    }
}

// 只导入旧版 wellspring-web 的索引；旧文件损坏就跳过，不影响启动
async function migrateLegacy(state: RegistryState): Promise<void> {
    let raw: unknown
    try {
        raw = await readJson(state.legacyFile)
    } catch {
        return
    }
    const entries = parseWorkspaceEntries(raw)
    if (entries.length === 0) {
        return
    }
    state.workspaces = entries
    await writeRegistry(state)
}

async function ensureLoaded(state: RegistryState): Promise<void> {
    if (state.loaded) {
        return
    }
    try {
        const raw = await readJson(state.file)
        state.workspaces = parseWorkspaceEntries(raw)
    } catch (error) {
        const missing =
            typeof error === "object" &&
            error !== null &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
        if (missing) {
            await migrateLegacy(state)
        } else {
            await quarantine(state)
        }
    }
    state.loaded = true
}

function enqueue<T>(state: RegistryState, task: () => Promise<T>): Promise<T> {
    const run = state.queue.then(task, task)
    state.queue = run.catch(() => undefined)
    return run
}

/** 宿主内部：重置内存里的注册表（测试 / 重新配置路径时用） */
export function resetWorkspaceRegistry(paths?: ResolvedPaths): void {
    if (paths === undefined) {
        states.clear()
        return
    }
    states.delete(workspaceRegistryFile(paths))
}

export async function listWorkspaces(
    paths: ResolvedPaths = getPaths(),
): Promise<HostWorkspaceListResult> {
    const state = stateFor(paths)
    await ensureLoaded(state)
    return { workspaces: state.workspaces.map((entry) => ({ ...entry })) }
}

function isDirectory(path: string): Promise<boolean> {
    return stat(path).then(
        (info) => info.isDirectory(),
        () => false,
    )
}

/** root 必须是已存在的目录；重复添加返回已有记录并刷新 lastSeenAt */
export async function addWorkspace(
    options: { readonly root: string; readonly name?: string },
    paths: ResolvedPaths = getPaths(),
): Promise<HostWorkspaceAddResult> {
    const rootRaw = typeof options.root === "string" ? options.root.trim() : ""
    if (rootRaw === "") {
        throw new Error("工作区路径不能为空")
    }
    const root = resolve(rootRaw)
    if (!isAbsolute(root)) {
        throw new Error("工作区路径必须是绝对路径")
    }
    if (!(await isDirectory(root))) {
        throw new Error(`工作区目录不存在或不是目录：${root}`)
    }
    const requestedName = normalizeWorkspaceName(options.name)
    if (options.name !== undefined && options.name !== "" && requestedName === null) {
        throw new Error(`工作区名称需要 1-${MAX_WORKSPACE_NAME_CHARS} 个字符`)
    }
    const state = stateFor(paths)
    await ensureLoaded(state)
    return await enqueue(state, async () => {
        const existing = state.workspaces.find((entry) => entry.root === root)
        if (existing !== undefined) {
            const touched: HostWorkspaceEntry = { ...existing, lastSeenAt: Date.now() }
            state.workspaces = state.workspaces.map((entry) =>
                entry.id === existing.id ? touched : entry,
            )
            await writeRegistry(state)
            return { workspace: { ...touched }, duplicate: true }
        }
        if (state.workspaces.length >= MAX_WORKSPACES) {
            throw new Error(`工作区数量已达上限（${MAX_WORKSPACES}）`)
        }
        const now = Date.now()
        const entry: HostWorkspaceEntry = {
            id: workspaceIdFor(root),
            name: requestedName ?? (basename(root) === "" ? "工作区" : basename(root)),
            root,
            createdAt: now,
            lastSeenAt: now,
        }
        state.workspaces = [entry, ...state.workspaces]
        await writeRegistry(state)
        return { workspace: { ...entry }, duplicate: false }
    })
}

export async function removeWorkspace(
    id: string,
    paths: ResolvedPaths = getPaths(),
): Promise<{ readonly removed: boolean }> {
    const state = stateFor(paths)
    await ensureLoaded(state)
    return await enqueue(state, async () => {
        const before = state.workspaces.length
        state.workspaces = state.workspaces.filter((entry) => entry.id !== id)
        const removed = state.workspaces.length !== before
        if (removed) {
            await writeRegistry(state)
        }
        return { removed }
    })
}

export async function renameWorkspace(
    id: string,
    name: string,
    paths: ResolvedPaths = getPaths(),
): Promise<HostWorkspaceEntry | null> {
    const normalized = normalizeWorkspaceName(name)
    if (normalized === null) {
        throw new Error(`工作区名称需要 1-${MAX_WORKSPACE_NAME_CHARS} 个字符`)
    }
    const state = stateFor(paths)
    await ensureLoaded(state)
    return await enqueue(state, async () => {
        const existing = state.workspaces.find((entry) => entry.id === id)
        if (existing === undefined) {
            return null
        }
        const updated: HostWorkspaceEntry = { ...existing, name: normalized }
        state.workspaces = state.workspaces.map((entry) => (entry.id === id ? updated : entry))
        await writeRegistry(state)
        return { ...updated }
    })
}

export async function touchWorkspace(
    id: string,
    paths: ResolvedPaths = getPaths(),
): Promise<HostWorkspaceEntry | null> {
    const state = stateFor(paths)
    await ensureLoaded(state)
    return await enqueue(state, async () => {
        const existing = state.workspaces.find((entry) => entry.id === id)
        if (existing === undefined) {
            return null
        }
        const updated: HostWorkspaceEntry = { ...existing, lastSeenAt: Date.now() }
        state.workspaces = state.workspaces.map((entry) => (entry.id === id ? updated : entry))
        await writeRegistry(state)
        return { ...updated }
    })
}
