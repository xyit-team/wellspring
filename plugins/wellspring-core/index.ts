// 核心 Agent 工具插件：read / delete_file（移入回收站）/ execute_code / web_search / web_fetch / SKILL 管理

import {
    getHost,
    onSessionStart,
    type AgentTool,
    type AgentToolParamSpec,
    type PluginApi,
} from "wellspring/api/host/index.ts"

import { buildSessionSystemPrompt } from "./session-prompt.ts"
import { registerSkillTools } from "./skills.ts"
import { moveToTrash, trashRoot } from "./trash.ts"

const READ_LIMIT = 2000
const MAX_LINE = 2000

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readText(api: PluginApi, args: Record<string, unknown>): string {
    const path = typeof args["file_path"] === "string" ? args["file_path"].trim() : ""
    if (path === "") {
        throw new Error("file_path 不能为空")
    }
    return path
}

async function readTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const filePath = readText(api, args)
    const text = await api.workspaceFs.readText(filePath)
    if (text === null) {
        return { success: false, data: { error: `文件不存在：${filePath}` } }
    }
    const lines = text.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop()
    }
    const offsetValue = Number(args["offset"] ?? 1)
    const limitValue = Number(args["limit"] ?? READ_LIMIT)
    const offset = Number.isInteger(offsetValue) ? Math.max(1, offsetValue) : 1
    const limit = Number.isInteger(limitValue)
        ? Math.max(1, Math.min(READ_LIMIT, limitValue))
        : READ_LIMIT
    const start = offset - 1
    const end = Math.min(lines.length, start + limit)
    const width = String(lines.length).length
    const out: string[] = []
    for (let index = start; index < end; index += 1) {
        const line = lines[index] ?? ""
        const textLine = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line
        out.push(`${String(index + 1).padStart(width)}│ ${textLine}`)
    }
    out.push("")
    out.push(`[lines ${start + 1}-${end} of ${lines.length}]`)
    if (end < lines.length) {
        out.push(`[继续读取：offset=${end + 1}]`)
    }
    return { success: true, data: { content: out.join("\n") } }
}

function deletePathOf(args: Record<string, unknown>): string {
    const path = typeof args["path"] === "string" ? args["path"].trim() : ""
    if (path === "") {
        throw new Error("path 不能为空")
    }
    const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "")
    if (normalized === "" || normalized === "." || normalized.split("/").includes("..")) {
        throw new Error("不能删除工作区根目录，路径也不能包含 ..")
    }
    return path
}

async function deleteFileTool(
    api: PluginApi,
    args: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const filePath = deletePathOf(args)
    const recursive = args["recursive"] === true || args["recursive"] === "true"
    const info = await api.workspaceFs.stat(filePath)
    if (info === null) {
        return { success: false, data: { error: `路径不存在：${filePath}` } }
    }
    if (info.type === "directory" && !recursive) {
        return {
            success: false,
            data: { error: `${filePath} 是目录；删除目录需要 recursive:true` },
        }
    }
    if (info.type === "other") {
        return { success: false, data: { error: `不支持的路径类型：${filePath}` } }
    }
    const moved = await moveToTrash(api, filePath, info.type)
    const label = info.type === "directory" ? "目录" : "文件"
    return {
        success: true,
        data: {
            path: filePath,
            type: info.type,
            trashPath: moved.absolutePath,
            trashItem: moved.itemPath,
            trashRoot: trashRoot(api),
            files: moved.files,
            bytes: moved.bytes,
            content: `已把${label}移到回收站：${filePath}（${moved.itemPath}）`,
        },
    }
}

async function callCapability(
    api: PluginApi,
    name: string,
    args: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
    try {
        if (name === "web_search") {
            const results = await api.capabilities.webSearch(
                String(args["query"] ?? ""),
                typeof args["count"] === "number" ? args["count"] : undefined,
            )
            return { success: true, data: { results } }
        }
        if (name === "web_fetch") {
            const page = await api.capabilities.webFetch(String(args["url"] ?? ""))
            return { success: true, data: { title: page.title, content: page.content } }
        }
        if (name === "execute_code") {
            const background = args["background"] === true || args["background"] === "true"
            const network = args["network"] === true || args["network"] === "true"
            const rawArgv = args["argv"]
            const argv = Array.isArray(rawArgv)
                ? rawArgv.filter((item): item is string => typeof item === "string")
                : typeof rawArgv === "string"
                  ? (JSON.parse(rawArgv) as unknown[]).filter(
                        (item): item is string => typeof item === "string",
                    )
                  : []
            const access: "read-only" | "workspace-write" | "danger-full-access" | undefined =
                args["sandbox_permissions"] === "workspace-write" ||
                args["sandbox_permissions"] === "danger-full-access" ||
                args["sandbox_permissions"] === "read-only"
                    ? args["sandbox_permissions"]
                    : undefined
            const request = {
                command: String(args["command"] ?? ""),
                argv,
                cwd: typeof args["cwd"] === "string" ? args["cwd"] : undefined,
                stdin: typeof args["stdin"] === "string" ? args["stdin"] : undefined,
                timeoutMs: Number.isFinite(Number(args["timeoutMs"]))
                    ? Number(args["timeoutMs"])
                    : undefined,
                memoryMB: Number.isFinite(Number(args["memoryMB"]))
                    ? Number(args["memoryMB"])
                    : undefined,
                network,
                access,
                justification:
                    typeof args["justification"] === "string" ? args["justification"] : undefined,
            }
            if (background) {
                const task = await api.capabilities.startBackgroundCode(request)
                return { success: true, data: { ...task } }
            }
            const result = await api.capabilities.executeCode(request)
            const { hostArtifactDir: _artifact, hostSandboxDir: _sandbox, ...safe } = result
            return { success: result.exitCode === 0, data: { ...safe } }
        }
        if (name === "query_task") {
            const taskId =
                typeof args["task_id"] === "string" && args["task_id"] !== ""
                    ? args["task_id"]
                    : undefined
            const task = await api.capabilities.queryTask(taskId)
            if (task === null) {
                return { success: false, data: { error: "没有任务" } }
            }
            if (task.result === null) {
                return { success: true, data: { ...task } }
            }
            const {
                hostArtifactDir: _artifact,
                hostSandboxDir: _sandbox,
                ...safeResult
            } = task.result
            return { success: true, data: { ...task, result: safeResult } }
        }
        if (name === "stop_task") {
            const taskId =
                typeof args["task_id"] === "string" && args["task_id"] !== ""
                    ? args["task_id"]
                    : undefined
            const type = args["type"] === "ctrl_c" ? "ctrl_c" : "kill"
            const stopped = await api.capabilities.stopTask(taskId, type)
            return { success: stopped, data: { stopped, type, taskId: taskId ?? null } }
        }
        return { success: false, data: { error: `未知工具：${name}` } }
    } catch (error) {
        return {
            success: false,
            data: { error: error instanceof Error ? error.message : String(error) },
        }
    }
}

function tool(
    name: string,
    content: string,
    params: Record<string, AgentToolParamSpec>,
    call: (
        args: Record<string, unknown>,
    ) => Promise<{ success: boolean; data: Record<string, unknown> }>,
): AgentTool {
    return {
        name,
        introduction: { params, content },
        call: async (...values: unknown[]) => {
            const input = isObject(values[0]) ? values[0] : {}
            return await call(input)
        },
    }
}

export function setup() {
    let api: PluginApi | null = null
    return {
        id: "wellspring-core",
        name: "Wellspring Core",
        version: "1.1.0",
        status: "ok" as const,
        init(pluginApi: PluginApi) {
            api = pluginApi
            // 新会话第一轮注入一次运行环境与可用工具列表
            onSessionStart((event) => {
                event.prompt.push(buildSessionSystemPrompt(event, getHost().getOS()))
            })
            registerSkillTools(api)
            api.registerAgentTool?.(
                tool(
                    "read",
                    "读取 workspace 内 UTF-8 文本，返回带行号内容",
                    {
                        file_path: "路径",
                        offset: { type: "integer", description: "起始行", optional: true },
                        limit: { type: "integer", description: "行数", optional: true },
                    },
                    async (args) => await readTool(api as PluginApi, args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "delete_file",
                    "把 workspace 内的文件或目录移到回收站（插件数据目录的 trash/），不会永久删除；目录需要 recursive:true",
                    {
                        path: "工作区相对路径",
                        recursive: {
                            type: "boolean",
                            description: "true 时连同目录内容一起移入回收站",
                            optional: true,
                        },
                    },
                    async (args) => await deleteFileTool(api as PluginApi, args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "web_search",
                    "使用 DeepSeek 搜索网页",
                    {
                        query: "搜索词",
                        count: { type: "integer", description: "结果数", optional: true },
                    },
                    async (args) => await callCapability(api as PluginApi, "web_search", args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "web_fetch",
                    "抓取网页 Markdown 正文",
                    { url: "网页地址" },
                    async (args) => await callCapability(api as PluginApi, "web_fetch", args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "query_task",
                    "查询后台 execute_code 任务状态与输出",
                    {
                        task_id: { type: "string", description: "任务 id，可留空", optional: true },
                    },
                    async (args) => await callCapability(api as PluginApi, "query_task", args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "stop_task",
                    "停止后台任务：ctrl_c 发 SIGINT，kill 发 SIGKILL",
                    {
                        type: {
                            type: "string",
                            enum: ["ctrl_c", "kill"],
                            description: "停止方式",
                        },
                        task_id: { type: "string", description: "任务 id，可留空", optional: true },
                    },
                    async (args) => await callCapability(api as PluginApi, "stop_task", args),
                ),
            )
            api.registerAgentTool?.(
                tool(
                    "execute_code",
                    "在 sandbox 中执行命令",
                    {
                        command: "可执行文件",
                        argv: {
                            type: "array",
                            items: { type: "string" },
                            description: "参数",
                            optional: true,
                        },
                        cwd: { type: "string", description: "工作目录", optional: true },
                        stdin: { type: "string", description: "标准输入", optional: true },
                        timeoutMs: {
                            type: "integer",
                            description: "超时毫秒",
                            optional: true,
                        },
                        memoryMB: {
                            type: "integer",
                            description: "物理内存上限 MB（cgroup，默认取 sandbox.defaultMemoryMB）",
                            optional: true,
                        },
                        background: {
                            type: "boolean",
                            description: "true 时后台执行",
                            optional: true,
                        },
                        network: {
                            type: "boolean",
                            description: "true 时允许网络",
                            optional: true,
                        },
                        sandbox_permissions: {
                            type: "string",
                            enum: ["read-only", "workspace-write", "danger-full-access"],
                            description: "请求权限",
                            optional: true,
                        },
                        justification: {
                            type: "string",
                            description: "申请更宽权限的理由",
                            optional: true,
                        },
                    },
                    async (args) => await callCapability(api as PluginApi, "execute_code", args),
                ),
            )
        },
    }
}
