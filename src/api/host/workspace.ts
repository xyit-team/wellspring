/*
 * 宿主工作区 API
 *
 * 工作区是用户添加、供 Agent 与编辑器使用的目录
 * 注册表由宿主维护在 <dataDir>/workspaces.json，插件通过 api.workspaces 读写
 * 需要 hostApi: workspaces 权限
 */

/** 已添加的工作区；id 由目录路径派生，保持稳定 */
export interface HostWorkspaceEntry {
    readonly id: string
    readonly name: string
    /** 规范化后的绝对路径 */
    readonly root: string
    readonly createdAt: number
    readonly lastSeenAt: number
}

export interface HostWorkspaceListResult {
    readonly workspaces: readonly HostWorkspaceEntry[]
}

export interface HostWorkspaceAddInput {
    /** 绝对路径；必须已存在且是目录 */
    readonly root: string
    /** 默认取目录名 */
    readonly name?: string
}

export interface HostWorkspaceAddResult {
    readonly workspace: HostWorkspaceEntry
    /** 同一目录重复添加时为 true（会刷新 lastSeenAt） */
    readonly duplicate: boolean
}

export interface HostWorkspaceRemoveResult {
    readonly removed: boolean
}

export interface HostWorkspacesApi {
    /** 列出已添加的工作区；不会预置任何工作区 */
    list(): Promise<HostWorkspaceListResult>
    /** 添加目录；重复添加返回已有记录 */
    add(input: HostWorkspaceAddInput): Promise<HostWorkspaceAddResult>
    /** 移除工作区（只从注册表移除，不动目录本身） */
    remove(id: string): Promise<HostWorkspaceRemoveResult>
    /** 重命名；工作区不存在返回 null */
    rename(id: string, name: string): Promise<HostWorkspaceEntry | null>
    /** 刷新 lastSeenAt；工作区不存在返回 null */
    touch(id: string): Promise<HostWorkspaceEntry | null>
}
