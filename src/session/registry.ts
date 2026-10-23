// 活跃会话注册表

import type { Session } from "./session.ts"

const sessions = new Map<string, Session>()

export function registerSession(session: Session): void {
    sessions.set(session.id, session)
}

export function unregisterSession(id: string): void {
    sessions.delete(id)
}

export function getSession(id: string): Session | null {
    return sessions.get(id) ?? null
}
