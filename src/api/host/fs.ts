/*
 * 宿主文件 API
 *
 * 插件通过 api.fs / ctx.fs 访问插件数据目录，通过 api.workspaceFs / ctx.workspaceFs 访问当前工作目录
 * 路径必须是相对路径，不能逃出对应根目录
 */

export type HostFileType = "file" | "directory" | "other"

export interface HostFileStat {
    readonly type: HostFileType
    readonly size: number
    readonly mtimeMs: number
}

export interface HostFileEntry extends HostFileStat {
    readonly name: string
}

/** 按绝对目录打开的文件 API；供编辑器等需要自选工作区的插件使用 */
export interface HostFileRootsApi {
    /**
     * 打开已存在的绝对目录
     *
     * 返回的 HostFileApi 以该目录为根，路径仍然只能是相对路径
     */
    open(root: string): Promise<HostFileApi>
}

export interface HostFileApi {
    /**
     * 该 API 的根目录（绝对路径）
     *
     * `workspaceFs.root` 为当前会话工作区，随工作区变化，宿主在应答中附带最新值
     * `fs.root` 为插件数据目录
     */
    readonly root: string
    readText(path: string): Promise<string | null>
    readBytes(path: string): Promise<Uint8Array | null>
    readJson<T = unknown>(path: string): Promise<T | null>
    writeText(path: string, text: string): Promise<void>
    writeBytes(path: string, bytes: Uint8Array): Promise<void>
    writeJson(path: string, value: unknown): Promise<void>
    list(path?: string): Promise<readonly HostFileEntry[]>
    stat(path: string): Promise<HostFileStat | null>
    mkdir(path: string): Promise<void>
    remove(path: string): Promise<void>
    exists(path: string): Promise<boolean>
}
