/*
 * 工作区文件服务：所有路径都是相对工作区根的 POSIX 路径，空串表示根目录。
 * 读写、目录列举、重命名、全文搜索与文件索引都经过这一层，HTTP 层只做校验和序列化。
 */

import { isAbsolute, relative, resolve, sep } from "node:path"

import { kindOf } from "./kinds.ts"
import { extractSymbols } from "./symbols.ts"

/*
 * 只声明用到的文件能力，避免文件服务依赖宿主 API 的具体类型。
 * HostFileApi 在结构上满足这些接口。
 */

export interface WorkspaceFsStat {
    readonly type: "file" | "directory" | "other"
    readonly size: number
    readonly mtimeMs: number
}

export interface WorkspaceFsEntry extends WorkspaceFsStat {
    readonly name: string
}

export interface WorkspaceFs {
    readonly root: string
    readText(path: string): Promise<string | null>
    readBytes(path: string): Promise<Uint8Array | null>
    writeText(path: string, text: string): Promise<void>
    writeBytes(path: string, bytes: Uint8Array): Promise<void>
    list(path?: string): Promise<readonly WorkspaceFsEntry[]>
    stat(path: string): Promise<WorkspaceFsStat | null>
    mkdir(path: string): Promise<void>
    remove(path: string): Promise<void>
}

/** 把绝对路径换算成 base 内的相对路径；不在 base 内返回 null。根目录返回空串 */
export function relativeInside(base: string, target: string): string | null {
    const absoluteBase = resolve(base)
    const absoluteTarget = resolve(target)
    const relativePath = relative(absoluteBase, absoluteTarget)
    if (relativePath === "") {
        return ""
    }
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        return null
    }
    return relativePath.split(sep).join("/")
}

/** 把宿主 workspaceFs 的某个子目录包装成独立工作区；prefix 为空表示根目录本身 */
export function createScopedFs(base: WorkspaceFs, prefix: string): WorkspaceFs {
    const scoped = (path: string): string => {
        if (prefix === "") {
            return path
        }
        return path === "" ? prefix : `${prefix}/${path}`
    }
    return {
        root: base.root,
        readText: (path) => base.readText(scoped(path)),
        readBytes: (path) => base.readBytes(scoped(path)),
        writeText: (path, text) => base.writeText(scoped(path), text),
        writeBytes: (path, bytes) => base.writeBytes(scoped(path), bytes),
        list: (path = "") => base.list(scoped(path)),
        stat: (path) => base.stat(scoped(path)),
        mkdir: (path) => base.mkdir(scoped(path)),
        remove: (path) => base.remove(scoped(path)),
    }
}

/** 编辑器可以打开的文本文件上限 */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024
/** 预览 / 下载二进制文件的上限 */
export const MAX_RAW_BYTES = 8 * 1024 * 1024
/** 重命名目录时最多复制多少个文件 */
export const MAX_RENAME_FILES = 2000
/** 一次请求最多查询多少个文件的 stat */
export const MAX_STAT_PATHS = 100

const INDEX_TTL_MS = 15_000
const MAX_INDEX_FILES = 5000
const MAX_INDEX_ENTRIES = 25_000
const MAX_INDEX_DEPTH = 16

const SYMBOL_CACHE_TTL_MS = 10_000
const MAX_SYMBOL_SCAN_FILES = 800
const MAX_SYMBOL_FILE_BYTES = 512 * 1024
const MAX_SYMBOL_TOTAL = 20000
const MAX_SYMBOL_RESULTS = 200
const SYMBOL_TIME_BUDGET_MS = 1200

const MAX_SEARCH_QUERY_CHARS = 200
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_SCAN_FILES = 800
const MAX_SEARCH_FILE_BYTES = 512 * 1024
const MAX_SEARCH_LINE_CHARS = 400
const SEARCH_TIME_BUDGET_MS = 6000

/** 索引与搜索都跳过的目录：体积大、生成物或版本库内部 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
    ".git",
    ".hg",
    ".svn",
    ".tmp",
    ".cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    ".venv",
    ".idea",
    ".pytest_cache",
    ".mypy_cache",
    "__pycache__",
    "node_modules",
    "bower_components",
    "vendor",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "working",
    ".wellspring",
])

export class WorkspaceError extends Error {
    readonly status: number

    constructor(status: number, message: string) {
        super(message)
        this.name = "WorkspaceError"
        this.status = status
    }
}

export interface WorkspaceEntry {
    readonly name: string
    readonly path: string
    readonly type: "file" | "directory" | "other"
    readonly size: number
    readonly mtimeMs: number
}

export interface IndexedFile {
    readonly path: string
    readonly size: number
}

interface WorkspaceIndex {
    readonly files: readonly IndexedFile[]
    readonly dirs: readonly string[]
    readonly truncated: boolean
    readonly builtAt: number
}

export interface WorkspaceSymbol {
    readonly path: string
    readonly name: string
    readonly kind: string
    readonly line: number
    readonly depth: number
}

export interface SymbolSearchResult {
    readonly symbols: readonly WorkspaceSymbol[]
    readonly total: number
    readonly truncated: boolean
    readonly scanned: number
}

interface SymbolCache {
    readonly symbols: readonly WorkspaceSymbol[]
    readonly truncated: boolean
    readonly scanned: number
    readonly builtAt: number
}

export interface ReadFileResult {
    readonly content: string
    readonly stat: WorkspaceFsStat
    readonly eol: "lf" | "crlf"
}

export interface StatResult {
    readonly path: string
    readonly exists: boolean
    readonly type: "file" | "directory" | "other" | "missing"
    readonly size: number
    readonly mtimeMs: number
}

export interface TextSearchMatch {
    readonly line: number
    readonly column: number
    readonly text: string
}

export interface TextSearchFile {
    readonly path: string
    readonly matches: readonly TextSearchMatch[]
}

export interface TextSearchResult {
    readonly files: readonly TextSearchFile[]
    readonly matchCount: number
    readonly scanned: number
    readonly totalFiles: number
    readonly truncated: boolean
    readonly elapsedMs: number
}

export interface TextSearchOptions {
    readonly caseSensitive?: boolean
    readonly regex?: boolean
}

export interface QuickOpenResult {
    readonly entries: readonly string[]
    readonly total: number
    readonly truncated: boolean
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** 把用户输入规范成工作区相对路径；拒绝绝对路径、穿越与控制字符 */
export function normalizePath(input: string): string {
    if (typeof input !== "string") {
        throw new WorkspaceError(400, "路径不合法")
    }
    let value = input.trim().replaceAll("\\", "/")
    if (value === "" || value === "." || value === "/") {
        return ""
    }
    if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
        throw new WorkspaceError(400, "不允许绝对路径")
    }
    const segments: string[] = []
    for (const segment of value.split("/")) {
        if (segment === "" || segment === ".") {
            continue
        }
        if (segment === "..") {
            throw new WorkspaceError(400, "路径不能越过工作区")
        }
        if (segment.includes("\0") || segment.includes("\n") || segment.includes("\r")) {
            throw new WorkspaceError(400, "路径含有非法字符")
        }
        segments.push(segment)
    }
    value = segments.join("/")
    if (value.length > 1024) {
        throw new WorkspaceError(400, "路径过长")
    }
    return value
}

/** 由父路径与名字拼出子路径；父路径为空时就是名字本身 */
export function childPath(parent: string, name: string): string {
    return parent === "" ? name : `${parent}/${name}`
}

/** 取父目录；根目录返回空串 */
export function parentPath(path: string): string {
    const slash = path.lastIndexOf("/")
    return slash === -1 ? "" : path.slice(0, slash)
}

/** 取路径最后一段 */
export function nameOf(path: string): string {
    const slash = path.lastIndexOf("/")
    return slash === -1 ? path : path.slice(slash + 1)
}

function baseNameOf(path: string): string {
    return nameOf(path)
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isTextKind(path: string): boolean {
    const kind = kindOf(path)
    return kind.media === "text" && kind.language !== "image"
}

/**
 * 模糊匹配文件路径：要求字符按顺序出现，按词首、连续命中与文件名命中加分。
 * 返回 null 表示不匹配。
 */
export function fuzzyScore(path: string, query: string): number | null {
    if (query === "") {
        return 0
    }
    const lowerPath = path.toLowerCase()
    const lowerQuery = query.toLowerCase()
    let score = 0
    let from = 0
    let previous = -2
    for (const character of lowerQuery) {
        const found = lowerPath.indexOf(character, from)
        if (found === -1) {
            return null
        }
        if (found === previous + 1) {
            score += 9
        }
        if (found === 0 || "/._-".includes(lowerPath[found - 1] ?? "")) {
            score += 14
        }
        score -= Math.min(found - from, 6)
        from = found + 1
        previous = found
    }
    const slash = lowerPath.lastIndexOf("/")
    const base = slash === -1 ? lowerPath : lowerPath.slice(slash + 1)
    if (base.startsWith(lowerQuery)) {
        score += 40
    } else if (base.includes(lowerQuery)) {
        score += 18
    }
    score -= Math.floor(path.length / 10)
    return score
}

/** 按模糊分排序，同分时短路径在前 */
export function rankFiles(
    files: readonly string[],
    query: string,
    limit: number,
): readonly string[] {
    if (query === "") {
        const sorted = [...files].sort((left, right) => left.localeCompare(right))
        return sorted.slice(0, limit)
    }
    const ranked: Array<{ path: string; score: number }> = []
    for (const path of files) {
        const score = fuzzyScore(path, query)
        if (score !== null) {
            ranked.push({ path, score })
        }
    }
    ranked.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score
        }
        return left.path.localeCompare(right.path)
    })
    return ranked.slice(0, limit).map((item) => item.path)
}

function detectEol(content: string): "lf" | "crlf" {
    return content.includes("\r\n") ? "crlf" : "lf"
}

/** 统计一段文本的缩进：优先返回制表符或空格数 */
export function detectIndent(content: string): string {
    const lines = content.split("\n", 200)
    for (const line of lines) {
        if (line.startsWith("\t")) {
            return "tab"
        }
        const match = /^( +)\S/.exec(line)
        if (match !== null) {
            const width = match[1]?.length ?? 0
            if (width >= 2 && width <= 8 && width % 2 === 0) {
                return String(width)
            }
            return String(width)
        }
    }
    return ""
}

/** 工作区文件服务；每个插件实例持有一个 */
export class WorkspaceService {
    readonly #fs: WorkspaceFs
    #index: WorkspaceIndex | null = null
    #indexTask: Promise<WorkspaceIndex> | null = null
    #symbols: SymbolCache | null = null
    #symbolTask: Promise<SymbolCache> | null = null
    #generation = 0

    constructor(fs: WorkspaceFs) {
        this.#fs = fs
    }

    get rootName(): string {
        return this.#fs.root
    }

    /** 文件变更后丢弃索引缓存 */
    invalidate(): void {
        this.#generation += 1
        this.#index = null
        this.#indexTask = null
        this.#symbols = null
        this.#symbolTask = null
    }

    async list(path: string): Promise<readonly WorkspaceEntry[]> {
        const relative = normalizePath(path)
        const stat = await this.#fs.stat(relative)
        if (stat === null) {
            throw new WorkspaceError(404, "目录不存在")
        }
        if (stat.type !== "directory") {
            throw new WorkspaceError(400, "不是目录")
        }
        const entries = await this.#fs.list(relative)
        const result: WorkspaceEntry[] = entries.map((entry) => ({
            name: entry.name,
            path: childPath(relative, entry.name),
            type: entry.type,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
        }))
        result.sort((left, right) => {
            const leftDirectory = left.type === "directory" ? 0 : 1
            const rightDirectory = right.type === "directory" ? 0 : 1
            if (leftDirectory !== rightDirectory) {
                return leftDirectory - rightDirectory
            }
            return left.name.localeCompare(right.name, "zh-Hans-CN")
        })
        return result
    }

    /** 读取工作区内的文本文件，不存在时返回 null；用于 .git/HEAD 这类小文件 */
    async readTextAtRoot(path: string): Promise<string | null> {
        return await this.#fs.readText(normalizePath(path))
    }

    async read(path: string): Promise<ReadFileResult> {
        const relative = normalizePath(path)
        const stat = await this.statInfo(relative)
        if (!stat.exists) {
            throw new WorkspaceError(404, "文件不存在")
        }
        if (stat.type !== "file") {
            throw new WorkspaceError(400, "不是文件")
        }
        if (stat.size > MAX_EDITABLE_BYTES) {
            throw new WorkspaceError(
                413,
                `文件超过 ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MiB，编辑器不打开`,
            )
        }
        const content = await this.#fs.readText(relative)
        if (content === null) {
            throw new WorkspaceError(404, "文件不存在")
        }
        return {
            content,
            stat: { type: "file", size: stat.size, mtimeMs: stat.mtimeMs },
            eol: detectEol(content),
        }
    }

    async readBytes(
        path: string,
    ): Promise<{ readonly bytes: Uint8Array; readonly stat: WorkspaceFsStat }> {
        const relative = normalizePath(path)
        const stat = await this.statInfo(relative)
        if (!stat.exists) {
            throw new WorkspaceError(404, "文件不存在")
        }
        if (stat.type !== "file") {
            throw new WorkspaceError(400, "不是文件")
        }
        if (stat.size > MAX_RAW_BYTES) {
            throw new WorkspaceError(
                413,
                `文件超过 ${Math.round(MAX_RAW_BYTES / 1024 / 1024)} MiB，不能预览`,
            )
        }
        const bytes = await this.#fs.readBytes(relative)
        if (bytes === null) {
            throw new WorkspaceError(404, "文件不存在")
        }
        return {
            bytes,
            stat: { type: "file", size: stat.size, mtimeMs: stat.mtimeMs },
        }
    }

    async write(
        path: string,
        content: string,
        baseMtimeMs?: number,
    ): Promise<{ readonly stat: WorkspaceFsStat }> {
        const relative = normalizePath(path)
        if (relative === "") {
            throw new WorkspaceError(400, "不能写入工作区根目录")
        }
        if (typeof content !== "string") {
            throw new WorkspaceError(400, "文件内容不合法")
        }
        if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_BYTES) {
            throw new WorkspaceError(413, "内容超过编辑器大小上限")
        }
        const current = await this.statInfo(relative)
        if (current.exists && current.type !== "file") {
            throw new WorkspaceError(400, "目标不是普通文件")
        }
        if (baseMtimeMs !== undefined && Number.isFinite(baseMtimeMs)) {
            if (!current.exists) {
                if (baseMtimeMs > 0) {
                    throw new WorkspaceError(409, "文件已被删除")
                }
            } else if (baseMtimeMs === 0) {
                throw new WorkspaceError(409, "文件已存在")
            } else if (Math.abs(current.mtimeMs - baseMtimeMs) > 1) {
                throw new WorkspaceError(409, "文件已在磁盘上被修改")
            }
        }
        await this.#fs.writeText(relative, content)
        const written = await this.#fs.stat(relative)
        this.invalidate()
        if (written === null) {
            throw new WorkspaceError(500, "写入后无法读取文件状态")
        }
        return { stat: written }
    }

    async create(path: string, type: "file" | "directory"): Promise<StatResult> {
        const relative = normalizePath(path)
        if (relative === "") {
            throw new WorkspaceError(400, "名称不能为空")
        }
        const existing = await this.statInfo(relative)
        if (existing.exists) {
            throw new WorkspaceError(409, "同名文件或目录已存在")
        }
        const parent = parentPath(relative)
        const parentStat = await this.statInfo(parent)
        if (!parentStat.exists) {
            throw new WorkspaceError(400, "父目录不存在")
        }
        if (parentStat.type !== "directory") {
            throw new WorkspaceError(400, "父路径不是目录")
        }
        if (type === "directory") {
            await this.#fs.mkdir(relative)
        } else {
            await this.#fs.writeText(relative, "")
        }
        this.invalidate()
        return await this.statInfo(relative)
    }

    async remove(path: string): Promise<void> {
        const relative = normalizePath(path)
        if (relative === "") {
            throw new WorkspaceError(400, "不能删除工作区根目录")
        }
        const stat = await this.statInfo(relative)
        if (!stat.exists) {
            throw new WorkspaceError(404, "文件或目录不存在")
        }
        await this.#fs.remove(relative)
        this.invalidate()
    }

    async rename(fromRaw: string, toRaw: string): Promise<{ from: string; to: string }> {
        const from = normalizePath(fromRaw)
        const to = normalizePath(toRaw)
        if (from === "" || to === "") {
            throw new WorkspaceError(400, "路径不能为空")
        }
        if (from === to) {
            return { from, to }
        }
        if (to.startsWith(`${from}/`)) {
            throw new WorkspaceError(400, "不能把目录移动到自己的子目录里")
        }
        const source = await this.statInfo(from)
        if (!source.exists) {
            throw new WorkspaceError(404, "源文件或目录不存在")
        }
        const target = await this.statInfo(to)
        if (target.exists) {
            throw new WorkspaceError(409, "目标名称已存在")
        }
        const targetParent = await this.statInfo(parentPath(to))
        if (!targetParent.exists || targetParent.type !== "directory") {
            throw new WorkspaceError(400, "目标父目录不存在")
        }
        const budget = { files: MAX_RENAME_FILES }
        await this.#copyTree(from, to, budget, 0)
        await this.#fs.remove(from)
        this.invalidate()
        return { from, to }
    }

    async statInfo(path: string): Promise<StatResult> {
        const relative = normalizePath(path)
        const stat = await this.#fs.stat(relative)
        if (stat === null) {
            return { path: relative, exists: false, type: "missing", size: 0, mtimeMs: 0 }
        }
        return {
            path: relative,
            exists: true,
            type: stat.type,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        }
    }

    async statMany(paths: readonly string[]): Promise<readonly StatResult[]> {
        const limited = paths.slice(0, MAX_STAT_PATHS)
        const result: StatResult[] = []
        for (const path of limited) {
            try {
                result.push(await this.statInfo(path))
            } catch {
                result.push({ path, exists: false, type: "missing", size: 0, mtimeMs: 0 })
            }
        }
        return result
    }

    async quickOpen(query: string, limit = 60): Promise<QuickOpenResult> {
        const index = await this.#getIndex()
        return {
            entries: rankFiles(
                index.files.map((file) => file.path),
                query,
                limit,
            ),
            total: index.files.length,
            truncated: index.truncated,
        }
    }

    async searchText(query: string, options: TextSearchOptions = {}): Promise<TextSearchResult> {
        const startedAt = Date.now()
        const raw = typeof query === "string" ? query.trim() : ""
        if (raw === "") {
            throw new WorkspaceError(400, "搜索内容不能为空")
        }
        if (raw.length > MAX_SEARCH_QUERY_CHARS) {
            throw new WorkspaceError(400, `搜索内容不能超过 ${MAX_SEARCH_QUERY_CHARS} 字符`)
        }
        let matcher: RegExp
        try {
            matcher = new RegExp(
                options.regex === true ? raw : escapeRegExp(raw),
                options.caseSensitive === true ? "g" : "gi",
            )
        } catch (error) {
            throw new WorkspaceError(400, `正则表达式不合法：${errorText(error)}`)
        }
        const index = await this.#getIndex()
        const files: TextSearchFile[] = []
        let matchCount = 0
        let scanned = 0
        let truncated = index.truncated || index.files.length > MAX_SEARCH_SCAN_FILES

        for (const file of index.files) {
            if (matchCount >= MAX_SEARCH_RESULTS) {
                truncated = true
                break
            }
            if (scanned >= MAX_SEARCH_SCAN_FILES) {
                truncated = true
                break
            }
            if (Date.now() - startedAt > SEARCH_TIME_BUDGET_MS) {
                truncated = true
                break
            }
            if (file.size > MAX_SEARCH_FILE_BYTES || !isTextKind(file.path)) {
                continue
            }
            let content: string | null
            try {
                content = await this.#fs.readText(file.path)
            } catch {
                continue
            }
            scanned += 1
            if (content === null || content.length > MAX_SEARCH_FILE_BYTES) {
                continue
            }
            const matches: TextSearchMatch[] = []
            const lines = content.split("\n")
            for (let indexLine = 0; indexLine < lines.length; indexLine += 1) {
                const rawLine = lines[indexLine] ?? ""
                const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
                matcher.lastIndex = 0
                const found = matcher.exec(line)
                if (found === null) {
                    continue
                }
                matches.push({
                    line: indexLine + 1,
                    column: found.index + 1,
                    text:
                        line.length > MAX_SEARCH_LINE_CHARS
                            ? `${line.slice(0, MAX_SEARCH_LINE_CHARS)}…`
                            : line,
                })
                matchCount += 1
                if (matchCount >= MAX_SEARCH_RESULTS) {
                    truncated = true
                    break
                }
            }
            if (matches.length > 0) {
                files.push({ path: file.path, matches })
            }
        }

        return {
            files,
            matchCount,
            scanned,
            totalFiles: index.files.length,
            truncated,
            elapsedMs: Date.now() - startedAt,
        }
    }

    async #copyTree(
        from: string,
        to: string,
        budget: { files: number },
        depth: number,
    ): Promise<void> {
        if (depth > MAX_INDEX_DEPTH) {
            throw new WorkspaceError(400, "目录层级过深")
        }
        if (budget.files <= 0) {
            throw new WorkspaceError(413, "要移动的文件过多，已取消")
        }
        const stat = await this.#fs.stat(from)
        if (stat === null) {
            throw new WorkspaceError(404, "源文件或目录不存在")
        }
        if (stat.type === "file") {
            const bytes = await this.#fs.readBytes(from)
            if (bytes === null) {
                throw new WorkspaceError(404, "源文件不存在")
            }
            await this.#fs.writeBytes(to, bytes)
            budget.files -= 1
            return
        }
        if (stat.type !== "directory") {
            throw new WorkspaceError(400, "不支持的条目类型")
        }
        await this.#fs.mkdir(to)
        const entries = await this.#fs.list(from)
        for (const entry of entries) {
            await this.#copyTree(
                childPath(from, entry.name),
                childPath(to, entry.name),
                budget,
                depth + 1,
            )
        }
    }

    /** 工作区符号搜索：扫描文本文件（受文件数/大小/时间预算限制），结果按名称排序 */
    async searchSymbols(query: string, limit = 60): Promise<SymbolSearchResult> {
        const raw = typeof query === "string" ? query.trim() : ""
        const cache = await this.#getSymbols()
        const needle = raw.toLowerCase()
        const matched = cache.symbols.filter((symbol) => {
            return needle === "" || symbol.name.toLowerCase().includes(needle)
        })
        matched.sort((left, right) => {
            const leftPrefix = needle !== "" && left.name.toLowerCase().startsWith(needle) ? 0 : 1
            const rightPrefix = needle !== "" && right.name.toLowerCase().startsWith(needle) ? 0 : 1
            if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix
            if (left.name.length !== right.name.length) return left.name.length - right.name.length
            const pathOrder = left.path.localeCompare(right.path)
            if (pathOrder !== 0) return pathOrder
            return left.line - right.line
        })
        const bounded = Math.max(
            1,
            Math.min(MAX_SYMBOL_RESULTS, Number.isInteger(limit) ? limit : 60),
        )
        return {
            symbols: matched.slice(0, bounded),
            total: matched.length,
            truncated: cache.truncated,
            scanned: cache.scanned,
        }
    }

    async #getSymbols(): Promise<SymbolCache> {
        const now = Date.now()
        if (this.#symbols !== null && now - this.#symbols.builtAt < SYMBOL_CACHE_TTL_MS) {
            return this.#symbols
        }
        if (this.#symbolTask !== null) {
            return await this.#symbolTask
        }
        const generation = this.#generation
        const task = this.#buildSymbols()
            .then((built) => {
                const cache: SymbolCache = { ...built, builtAt: Date.now() }
                if (generation === this.#generation) {
                    this.#symbols = cache
                }
                return cache
            })
            .finally(() => {
                if (generation === this.#generation) {
                    this.#symbolTask = null
                }
            })
        this.#symbolTask = task
        return await task
    }

    async #buildSymbols(): Promise<Omit<SymbolCache, "builtAt">> {
        const index = await this.#getIndex()
        const startedAt = Date.now()
        const symbols: WorkspaceSymbol[] = []
        let scanned = 0
        let truncated = index.truncated
        for (const file of index.files) {
            if (symbols.length >= MAX_SYMBOL_TOTAL) {
                truncated = true
                break
            }
            if (scanned >= MAX_SYMBOL_SCAN_FILES) {
                truncated = true
                break
            }
            if (Date.now() - startedAt > SYMBOL_TIME_BUDGET_MS) {
                truncated = true
                break
            }
            const kind = kindOf(file.path)
            if (kind.media !== "text" || file.size > MAX_SYMBOL_FILE_BYTES) {
                continue
            }
            let content: string | null
            try {
                content = await this.#fs.readText(file.path)
            } catch {
                continue
            }
            if (content === null) {
                continue
            }
            scanned += 1
            for (const symbol of extractSymbols(content, kind.language)) {
                symbols.push({
                    path: file.path,
                    name: symbol.name,
                    kind: symbol.kind,
                    line: symbol.line,
                    depth: symbol.depth,
                })
                if (symbols.length >= MAX_SYMBOL_TOTAL) {
                    truncated = true
                    break
                }
            }
        }
        return { symbols, truncated, scanned }
    }

    async #getIndex(): Promise<WorkspaceIndex> {
        const now = Date.now()
        if (this.#index !== null && now - this.#index.builtAt < INDEX_TTL_MS) {
            return this.#index
        }
        if (this.#indexTask !== null) {
            return await this.#indexTask
        }
        const generation = this.#generation
        const task = this.#buildIndex()
            .then((built) => {
                const index: WorkspaceIndex = { ...built, builtAt: Date.now() }
                if (generation === this.#generation) {
                    this.#index = index
                }
                return index
            })
            .finally(() => {
                if (generation === this.#generation) {
                    this.#indexTask = null
                }
            })
        this.#indexTask = task
        return await task
    }

    async #buildIndex(): Promise<Omit<WorkspaceIndex, "builtAt">> {
        const files: IndexedFile[] = []
        const dirs: string[] = []
        const queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }]
        let visited = 0
        let truncated = false
        let cursor = 0

        while (cursor < queue.length) {
            if (visited >= MAX_INDEX_ENTRIES || files.length >= MAX_INDEX_FILES) {
                truncated = true
                break
            }
            const current = queue[cursor]
            cursor += 1
            if (current === undefined) {
                break
            }
            let entries
            try {
                entries = await this.#fs.list(current.path)
            } catch {
                continue
            }
            visited += entries.length
            for (const entry of entries) {
                if (entry.type === "directory") {
                    if (IGNORED_DIRECTORIES.has(entry.name)) {
                        continue
                    }
                    const path = childPath(current.path, entry.name)
                    dirs.push(path)
                    if (current.depth < MAX_INDEX_DEPTH) {
                        queue.push({ path, depth: current.depth + 1 })
                    } else {
                        truncated = true
                    }
                } else if (entry.type === "file") {
                    files.push({ path: childPath(current.path, entry.name), size: entry.size })
                    if (files.length >= MAX_INDEX_FILES) {
                        truncated = true
                        break
                    }
                }
            }
        }

        return { files, dirs, truncated }
    }
}

/** 工作区名：取根路径最后一段，用于界面展示 */
export function workspaceNameOf(root: string): string {
    const trimmed = root.replace(/[/\\]+$/, "")
    if (trimmed === "") {
        return root
    }
    return baseNameOf(trimmed) || trimmed
}
