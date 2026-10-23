// 宿主会话 API

import { getHostBridge } from "../../sandbox/bridge-state.ts"
import { getSession as findSession } from "../../session/registry.ts"
import { Session, SessionMessage } from "../../session/session.ts"
import type { SessionData } from "../../session/store.ts"
import type { SessionMeta } from "../../session/types.ts"

export { Session, SessionMessage } from "../../session/session.ts"
export { Workspace } from "../../workspace/index.ts"

class RemoteSession extends Session {
    constructor(id: string) {
        const meta: SessionMeta = {
            type: "session",
            version: 1,
            id,
            createdAt: 0,
            cwd: "",
            workspace: "",
            metadata: {},
            app: "wellspring",
            appVersion: "1.0.0",
            model: "",
        }
        const data: SessionData = {
            meta,
            header: { type: "session", metadata: {}, workspace: "" },
            dir: "",
            events: [],
            turns: [],
        }
        super(data)
    }

    override async message(
        content: string | readonly string[],
        type = "message",
    ): Promise<SessionMessage> {
        const bridge = getHostBridge()
        if (bridge === null) {
            return await super.message(content, type)
        }
        await bridge.request("host.session.message", {
            id: this.id,
            content: typeof content === "string" ? [content] : [...content],
            type,
        })
        return new SessionMessage({ sessionId: this.id, content, type })
    }
}

/** 获取活跃会话；sandbox 插件通过 bridge 访问宿主注册表 */
export async function getSession(id: string): Promise<Session | null> {
    const bridge = getHostBridge()
    if (bridge === null) {
        return findSession(id)
    }
    const exists = (await bridge.request("host.session.exists", { id })) as boolean
    return exists ? new RemoteSession(id) : null
}
