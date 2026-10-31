/*
 * 只读 Git 面板的数据层：只执行 status / rev-parse / diff，不做任何写操作。
 * 命令走宿主 api.exec（插件被 access-guard 禁止 child_process）。
 */

import { relative, resolve, sep } from "node:path"

const GIT_TIMEOUT_MS = 5000
const MAX_STATUS_FILES = 2000
const MAX_DIFF_CHARS = 300_000
const MAX_GIT_OUTPUT_CHARS = 600_000
const POLL_INTERVAL_MS = 25
const MAX_POLLS = 400

export interface GitExecSession {
    readonly sessionId: string
    readonly cwd: string
}

export interface GitExecChunk {
    readonly chunk: string
    readonly done: boolean
    readonly exitCode: number | null
    readonly timedOut: boolean
    readonly truncated: boolean
}

export interface GitExecApi {
    run(options: {
        readonly command: string
        readonly cwd: string
        readonly env?: Record<string, string>
        readonly timeoutMs?: number
    }): Promise<GitExecSession>
    poll(sessionId: string): Promise<GitExecChunk>
    stop(sessionId: string): Promise<void>
}

export interface GitApi {
    readonly exec: GitExecApi
}

export interface GitChange {
    /** 工作区相对路径 */
    readonly path: string
    readonly x: string
    readonly y: string
    /** 界面展示用的单字母状态：M / A / D / R / ? */
    readonly letter: string
    readonly staged: boolean
    readonly untracked: boolean
}

export interface GitStatusResult {
    readonly available: boolean
    readonly repo: boolean
    readonly root: string
    readonly branch: string
    readonly ahead: number
    readonly behind: number
    readonly changes: readonly GitChange[]
    readonly truncated: boolean
    readonly error: string
}

export interface GitDiffResult {
    readonly available: boolean
    readonly repo: boolean
    readonly staged: boolean
    readonly path: string
    readonly content: string
    readonly truncated: boolean
    readonly error: string
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
    return `'${value.replace(/'/g, `'\\''`)}'`
}

function trimOutput(output: string): string {
    return output.length > MAX_GIT_OUTPUT_CHARS ? output.slice(0, MAX_GIT_OUTPUT_CHARS) : output
}

async function runGit(
    api: GitApi,
    cwd: string,
    args: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
    const command = ["git", ...args.map(shellQuote)].join(" ")
    const session = await api.exec.run({
        command,
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        env: {
            GIT_PAGER: "cat",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            LC_ALL: "C",
        },
    })
    let output = ""
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        const chunk = await api.exec.poll(session.sessionId)
        output = trimOutput(output + chunk.chunk)
        if (chunk.done) {
            return { exitCode: chunk.exitCode, output }
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS))
    }
    await api.exec.stop(session.sessionId).catch(() => undefined)
    return { exitCode: null, output }
}

function gitMissing(output: string): boolean {
    const text = output.toLowerCase()
    return (
        text.includes("git: command not found") ||
        text.includes("'git' is not recognized") ||
        text.includes("git: not found") ||
        text.includes("不是内部或外部命令")
    )
}

function normalizeToPosix(path: string): string {
    return path.split(sep).join("/")
}

/** 仓库相对路径 → 工作区相对路径；不在工作区内返回 null */
export function workspaceRelativePath(
    repoRoot: string,
    workspaceRoot: string,
    repoPath: string,
): string | null {
    const absolute = resolve(repoRoot, repoPath)
    const relativePath = relative(resolve(workspaceRoot), absolute)
    if (relativePath === "") return ""
    if (
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        relativePath.startsWith("../")
    ) {
        return null
    }
    return normalizeToPosix(relativePath)
}

function statusLetter(x: string, y: string): string {
    if (x === "?" && y === "?") return "?"
    if (x === "R" || y === "R") return "R"
    if (x === "C" || y === "C") return "C"
    if (x === "A" || y === "A") return "A"
    if (x === "D" || y === "D") return "D"
    if (x === "U" || y === "U") return "U"
    return "M"
}

/** 解析 `git status --porcelain=v1 -z --branch` 的输出（纯函数，便于单测） */
export function parseGitStatus(
    output: string,
    repoRoot: string,
    workspaceRoot: string,
): {
    readonly branch: string
    readonly ahead: number
    readonly behind: number
    readonly changes: readonly GitChange[]
    readonly truncated: boolean
} {
    const tokens = output.split("\u0000")
    let branch = ""
    let ahead = 0
    let behind = 0
    const changes: GitChange[] = []
    let truncated = false
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ""
        if (token === "") continue
        if (token.startsWith("## ")) {
            const header = token.slice(3).trim()
            const bracket = /\[(.*)\]$/.exec(header)
            const namePart = (bracket === null ? header : header.slice(0, bracket.index)).trim()
            const first = namePart.split("...")[0] ?? namePart
            branch = first.replace(/^HEAD \(no branch\)$/, "HEAD")
            if (bracket !== null) {
                const aheadMatch = /ahead (\d+)/.exec(bracket[1] ?? "")
                const behindMatch = /behind (\d+)/.exec(bracket[1] ?? "")
                ahead = aheadMatch === null ? 0 : Number(aheadMatch[1])
                behind = behindMatch === null ? 0 : Number(behindMatch[1])
            }
            continue
        }
        if (token.length < 4) continue
        const x = token.charAt(0)
        const y = token.charAt(1)
        let repoPath = token.slice(3)
        if (x === "R" || x === "C" || y === "R" || y === "C") {
            /* -z 的改名格式：新路径后紧跟一个 NUL，再是旧路径 */
            index += 1
        }
        const workspacePath = workspaceRelativePath(repoRoot, workspaceRoot, repoPath)
        if (workspacePath === null) continue
        repoPath = workspacePath
        if (x === "!" && y === "!") continue
        if (changes.length >= MAX_STATUS_FILES) {
            truncated = true
            break
        }
        changes.push({
            path: repoPath,
            x,
            y,
            letter: statusLetter(x, y),
            staged: x !== " " && x !== "?" && x !== "!",
            untracked: x === "?" && y === "?",
        })
    }
    return { branch, ahead, behind, changes, truncated }
}

async function resolveRepo(
    api: GitApi,
    workspaceRoot: string,
): Promise<{
    readonly available: boolean
    readonly repo: boolean
    readonly root: string
    readonly error: string
}> {
    const result = await runGit(api, workspaceRoot, ["rev-parse", "--show-toplevel"])
    if (result.exitCode === 0) {
        const root = result.output.trim().split("\n").pop() ?? ""
        if (root !== "") return { available: true, repo: true, root, error: "" }
    }
    if (gitMissing(result.output) || result.exitCode === 127) {
        return { available: false, repo: false, root: "", error: "没有找到 git 命令" }
    }
    return { available: true, repo: false, root: "", error: "当前工作区不在 git 仓库里" }
}

export async function readGitStatus(api: GitApi, workspaceRoot: string): Promise<GitStatusResult> {
    const repo = await resolveRepo(api, workspaceRoot)
    if (repo.available !== true || repo.repo !== true) {
        return {
            available: repo.available,
            repo: repo.repo,
            root: repo.root,
            branch: "",
            ahead: 0,
            behind: 0,
            changes: [],
            truncated: false,
            error: repo.error,
        }
    }
    const status = await runGit(api, workspaceRoot, [
        "-C",
        repo.root,
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
        "--untracked-files=all",
    ])
    if (status.exitCode !== 0) {
        return {
            available: true,
            repo: true,
            root: repo.root,
            branch: "",
            ahead: 0,
            behind: 0,
            changes: [],
            truncated: false,
            error: (status.output.trim() || "git status 执行失败").slice(0, 300),
        }
    }
    const parsed = parseGitStatus(status.output, repo.root, workspaceRoot)
    return {
        available: true,
        repo: true,
        root: repo.root,
        branch: parsed.branch,
        ahead: parsed.ahead,
        behind: parsed.behind,
        changes: parsed.changes,
        truncated: parsed.truncated,
        error: "",
    }
}

/** 读取某个文件的 unified diff；未跟踪文件没有 diff */
export async function readGitDiff(
    api: GitApi,
    workspaceRoot: string,
    path: string,
    staged: boolean,
): Promise<GitDiffResult> {
    const repo = await resolveRepo(api, workspaceRoot)
    if (repo.available !== true || repo.repo !== true) {
        return {
            available: repo.available,
            repo: repo.repo,
            staged,
            path,
            content: "",
            truncated: false,
            error: repo.error,
        }
    }
    const repoPath = relative(resolve(repo.root), resolve(workspaceRoot, path))
    if (repoPath === "" || repoPath.startsWith("..") || repoPath.startsWith(`..${sep}`)) {
        return {
            available: true,
            repo: true,
            staged,
            path,
            content: "",
            truncated: false,
            error: "路径不在 git 仓库内",
        }
    }
    const args = ["-C", repo.root, "diff", "--no-color", "--unified=3"]
    if (staged) args.push("--cached")
    args.push("--", normalizeToPosix(repoPath))
    const result = await runGit(api, workspaceRoot, args)
    if (result.exitCode !== 0) {
        return {
            available: true,
            repo: true,
            staged,
            path,
            content: "",
            truncated: false,
            error: (result.output.trim() || "git diff 执行失败").slice(0, 300),
        }
    }
    const content =
        result.output.length > MAX_DIFF_CHARS
            ? result.output.slice(0, MAX_DIFF_CHARS)
            : result.output
    return {
        available: true,
        repo: true,
        staged,
        path,
        content,
        truncated: result.output.length > MAX_DIFF_CHARS,
        error: "",
    }
}

export interface GitStageResult {
    readonly available: boolean
    readonly repo: boolean
    readonly ok: boolean
    readonly error: string
}

function repoRelativePath(
    repoRoot: string,
    workspaceRoot: string,
    workspacePath: string,
): string | null {
    const relativePath = relative(resolve(repoRoot), resolve(workspaceRoot, workspacePath))
    if (
        relativePath === "" ||
        relativePath.startsWith("..") ||
        relativePath.startsWith(`..${sep}`)
    ) {
        return null
    }
    return normalizeToPosix(relativePath)
}

/** 暂存 / 取消暂存：只动 index，不做提交、不切换分支 */
async function changeIndex(
    api: GitApi,
    workspaceRoot: string,
    paths: readonly string[],
    unstage: boolean,
): Promise<GitStageResult> {
    const repo = await resolveRepo(api, workspaceRoot)
    if (repo.available !== true || repo.repo !== true) {
        return { available: repo.available, repo: repo.repo, ok: false, error: repo.error }
    }
    const list: string[] = []
    for (const path of paths) {
        const target = repoRelativePath(repo.root, workspaceRoot, path)
        if (target === null) {
            return {
                available: true,
                repo: true,
                ok: false,
                error: `路径不在 git 仓库内：${path}`,
            }
        }
        if (!list.includes(target)) list.push(target)
    }
    if (list.length === 0) {
        return { available: true, repo: true, ok: false, error: "没有要操作的路径" }
    }
    if (unstage !== true) {
        const result = await runGit(api, workspaceRoot, ["-C", repo.root, "add", "--", ...list])
        if (result.exitCode !== 0) {
            return {
                available: true,
                repo: true,
                ok: false,
                error: (result.output.trim() || "git add 失败").slice(0, 300),
            }
        }
        return { available: true, repo: true, ok: true, error: "" }
    }
    /* restore 需要 git 2.23+；老版本或还没有提交时依次回退 */
    const restore = await runGit(api, workspaceRoot, [
        "-C",
        repo.root,
        "restore",
        "--staged",
        "--",
        ...list,
    ])
    if (restore.exitCode === 0) {
        return { available: true, repo: true, ok: true, error: "" }
    }
    const reset = await runGit(api, workspaceRoot, [
        "-C",
        repo.root,
        "reset",
        "-q",
        "HEAD",
        "--",
        ...list,
    ])
    if (reset.exitCode === 0) {
        return { available: true, repo: true, ok: true, error: "" }
    }
    /* 空仓库（还没有 HEAD）里只能把新增文件从 index 移除 */
    const rm = await runGit(api, workspaceRoot, [
        "-C",
        repo.root,
        "rm",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...list,
    ])
    if (rm.exitCode !== 0) {
        return {
            available: true,
            repo: true,
            ok: false,
            error: (rm.output.trim() || restore.output.trim() || "取消暂存失败").slice(0, 300),
        }
    }
    return { available: true, repo: true, ok: true, error: "" }
}

export async function stageGitPaths(
    api: GitApi,
    workspaceRoot: string,
    paths: readonly string[],
): Promise<GitStageResult> {
    return await changeIndex(api, workspaceRoot, paths, false)
}

export async function unstageGitPaths(
    api: GitApi,
    workspaceRoot: string,
    paths: readonly string[],
): Promise<GitStageResult> {
    return await changeIndex(api, workspaceRoot, paths, true)
}
