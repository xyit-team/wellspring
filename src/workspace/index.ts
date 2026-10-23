// 工作区：会话与 Agent 工具的文件边界

import { basename, resolve } from "node:path"

export class Workspace {
    readonly root: string
    readonly name: string

    constructor(root: string) {
        this.root = resolve(root)
        this.name = basename(this.root)
    }

    static open(path = process.cwd()): Workspace {
        return new Workspace(path)
    }

    equals(other: Workspace): boolean {
        return this.root === other.root
    }
}
