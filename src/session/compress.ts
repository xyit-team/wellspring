/*
 * 会话段编解码。
 * 每轮一个 zstd frame：解压后是 JSONL 事件流，一行一个事件。
 */

import { zstdCompressSync, zstdDecompressSync } from "node:zlib"

import type { SessionEvent } from "./types.ts"

export function encodeEvents(events: readonly SessionEvent[]): Buffer {
    const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
    return zstdCompressSync(Buffer.from(text, "utf8"))
}

export function decodeEvents(data: Buffer): SessionEvent[] {
    let text: string
    try {
        text = zstdDecompressSync(data).toString("utf8")
    } catch (error) {
        throw new Error("会话段解压失败", { cause: error })
    }

    const events: SessionEvent[] = []
    for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (trimmed === "") {
            continue
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch (error) {
            throw new Error("会话段包含无法解析的行", { cause: error })
        }
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            typeof (parsed as { type?: unknown }).type !== "string" ||
            typeof (parsed as { seq?: unknown }).seq !== "number" ||
            typeof (parsed as { time?: unknown }).time !== "number"
        ) {
            throw new Error("会话事件缺少 type/seq/time")
        }
        events.push(parsed as SessionEvent)
    }
    return events
}
