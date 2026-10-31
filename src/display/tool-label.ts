/*
 * 工具调用的终端展示：中文动作名 + 一行参数摘要。
 * 与网页里的工具行保持一致（执行命令 / 读取文件 / 搜索网页 …）。
 */

const TOOL_LABELS: Readonly<Record<string, string>> = {
    execute_code: "执行命令",
    read: "读取文件",
    delete_file: "移入回收站",
    web_search: "搜索网页",
    web_fetch: "抓取网页",
    query_task: "查询任务",
    stop_task: "停止任务",
    ask: "询问用户",
    skill_list: "列出技能",
    skill_read: "读取技能",
    skill_install: "安装技能",
    skill_modify: "修改技能",
}

const SUMMARY_LIMIT = 160

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : ""
}

function truncate(value: string): string {
    const line = value.split(/\r?\n/)[0]?.trim() ?? ""
    return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT)}…` : line
}

/** 工具名 → 中文动作名；未知工具直接显示原名 */
export function toolLabel(name: string): string {
    return TOOL_LABELS[name] ?? name
}

/** 工具参数 → 一行摘要（命令、路径、搜索词等） */
export function toolSummary(name: string, args: Record<string, unknown>): string {
    if (name === "execute_code") {
        const command = text(args["command"])
        const rawArgv = args["argv"]
        const argv = Array.isArray(rawArgv)
            ? rawArgv.filter((item): item is string => typeof item === "string")
            : []
        return truncate([command, ...argv].filter((item) => item !== "").join(" "))
    }
    if (name === "delete_file") {
        return text(args["path"])
    }
    if (name === "read") {
        return truncate(text(args["file_path"]))
    }
    if (name === "web_search") {
        return truncate(text(args["query"]))
    }
    if (name === "web_fetch") {
        return truncate(text(args["url"]))
    }
    if (name === "query_task") {
        return truncate(text(args["task_id"]))
    }
    if (name === "stop_task") {
        return truncate([text(args["task_id"]), text(args["type"])].filter(Boolean).join(" "))
    }
    if (name === "ask") {
        return truncate(text(args["question"]))
    }
    if (name === "skill_read" || name === "skill_install" || name === "skill_modify") {
        return truncate(text(args["name"]) || text(args["path"]))
    }
    const first = Object.values(args).find((value): value is string => typeof value === "string")
    return truncate(first ?? "")
}

/** 参数是 JSON 字符串时先解析，失败按空对象处理 */
export function toolArgs(raw: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(raw)
        return isRecord(value) ? value : {}
    } catch {
        return {}
    }
}
