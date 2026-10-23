/*
 * 宿主文件 API。
 * 插件通过 api.fs / ctx.fs（插件数据目录）或 api.workspaceFs / ctx.workspaceFs（当前工作目录）访问文件。
 * 路径必须是相对路径，且不能逃出对应根目录。
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

export interface HostFileApi {
    /** 该 API 的根目录，仅用于展示/诊断 */
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
