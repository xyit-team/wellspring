/*
 * 网页输入框的 @ 引用触发与路径提取。
 * 客户端脚本是一个 IIFE，测试时把末尾的 boot() 换成调试钩子，用 vm 跑在假 DOM 上。
 */

import assert from "node:assert/strict"
import vm from "node:vm"
import { test } from "node:test"

import { CLIENT_SCRIPT } from "../plugins/wellspring-web/src/assets/index.ts"

interface FakeInput {
    readonly value: string
    readonly selectionStart: number
    readonly selectionEnd: number
}

interface TriggerContext {
    readonly kind: string
    readonly query: string
    readonly start: number
    readonly end: number
}

interface MentionRange {
    readonly start: number
    readonly end: number
}

interface StoredMessage {
    readonly role: string
    readonly text: string
    readonly at: number
    readonly stopped?: boolean
    readonly interrupted?: boolean
    readonly process?: Array<Record<string, unknown>>
}

interface StoredConversation {
    readonly id: string
    readonly serverSessionId: string | null
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
    readonly messages: StoredMessage[]
}

interface MentionHooks {
    triggerContext(): TriggerContext | null
    extractReferences(text: string): string[]
    collectReferences(text: string): string[]
    isMentionBoundary(character: string): boolean
    highlightNeedles(query: string): string[]
    mentionRanges(text: string): MentionRange[]
    formatMention(entry: { path: string; type: string }): string | null
    conversationPayload(conv: Record<string, unknown>): {
        messages: Array<Record<string, unknown>>
    }
    normalizeConversation(value: unknown): StoredConversation | null
    setPicked(paths: readonly string[]): void
}

const HOOKS = `globalThis.__mention = {
    triggerContext: triggerContext,
    extractReferences: extractReferences,
    collectReferences: collectReferences,
    isMentionBoundary: isMentionBoundary,
    highlightNeedles: highlightNeedles,
    mentionRanges: mentionRanges,
    formatMention: formatMention,
    conversationPayload: conversationPayload,
    normalizeConversation: normalizeConversation,
    setPicked: function (paths) { pickedReferences = paths.slice() },
}`

function loadClient(input: FakeInput): MentionHooks {
    const body = CLIENT_SCRIPT.replace(/\nboot\(\)\s*\n/, `\n${HOOKS}\n`)
    assert.notEqual(body, CLIENT_SCRIPT, "需要把 boot() 替换成测试钩子")
    const context: Record<string, unknown> = {
        document: {
            getElementById: (id: string) => (id === "composer-input" ? input : null),
        },
    }
    context["globalThis"] = context
    vm.createContext(context)
    vm.runInContext(body, context, { filename: "wellspring-app.js" })
    const hooks = context["__mention"]
    assert.ok(hooks !== undefined, "调试钩子应挂到 globalThis 上")
    return hooks as MentionHooks
}

/** vm 里的对象/数组原型来自另一个 realm，比较前转成普通值 */
function plain<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

function composer(value: string, cursor?: number): FakeInput {
    const position = cursor === undefined ? value.length : cursor
    return { value, selectionStart: position, selectionEnd: position }
}

test("web 插件：@ 触发在中文与标点之后也生效", () => {
    const cases: Array<{ text: string; query: string; start: number }> = [
        { text: "@src/app", query: "src/app", start: 0 },
        { text: "帮我看下@src/app", query: "src/app", start: 4 },
        { text: "看下，@assets/app", query: "assets/app", start: 3 },
        { text: "看下（@src/", query: "src/", start: 3 },
        { text: "第一行\n@README", query: "README", start: 4 },
    ]
    for (const item of cases) {
        const context = plain(loadClient(composer(item.text)).triggerContext())
        assert.deepEqual(
            context,
            {
                kind: "mention",
                query: item.query,
                start: item.start,
                end: item.text.length,
            },
            item.text,
        )
    }

    const hooks = loadClient(composer("@"))
    assert.deepEqual(plain(hooks.triggerContext()), {
        kind: "mention",
        query: "",
        start: 0,
        end: 1,
    })

    // 邮箱里的 @ 不是引用：前一个字符是 ASCII 字母
    const email = plain(loadClient(composer("mail a@b.com")).triggerContext())
    assert.equal(email, null)
    assert.equal(plain(loadClient(composer("Tom@jack")).triggerContext()), null)
})

test("web 插件：/ 指令仍只从行首或空白后触发", () => {
    assert.deepEqual(plain(loadClient(composer("/mod")).triggerContext()), {
        kind: "slash",
        query: "mod",
        start: 0,
        end: 4,
    })
    assert.deepEqual(plain(loadClient(composer("看下 /help")).triggerContext()), {
        kind: "slash",
        query: "help",
        start: 3,
        end: 8,
    })
    assert.equal(plain(loadClient(composer("src/app")).triggerContext()), null)
    assert.equal(plain(loadClient(composer("and/or")).triggerContext()), null)
})

test("web 插件：@ 引用路径提取", () => {
    const hooks = loadClient(composer(""))
    assert.deepEqual(plain(hooks.extractReferences("帮我看看@src/app.ts")), ["src/app.ts"])
    assert.deepEqual(plain(hooks.extractReferences("看@src/a.ts，再看@src/b.ts。")), [
        "src/a.ts",
        "src/b.ts",
    ])
    assert.deepEqual(plain(hooks.extractReferences("@src/a.ts @src/b.ts")), [
        "src/a.ts",
        "src/b.ts",
    ])
    assert.deepEqual(plain(hooks.extractReferences("(@src/app.ts)")), ["src/app.ts"])
    assert.deepEqual(plain(hooks.extractReferences("mail a@b.com 和 @ok.ts")), ["ok.ts"])
    assert.deepEqual(plain(hooks.extractReferences("@src/a.ts 和 @src/a.ts")), ["src/a.ts"])
    assert.deepEqual(plain(hooks.extractReferences("没有引用")), [])
})

test("web 插件：带空格的文件名靠选中的路径补进 references", () => {
    const hooks = loadClient(composer(""))
    hooks.setPicked(["src/my file.txt", "docs/guide.md"])
    assert.deepEqual(plain(hooks.collectReferences("@src/my file.txt 看下")), ["src/my file.txt"])

    hooks.setPicked(["src/my file.txt"])
    assert.deepEqual(plain(hooks.collectReferences("@src/my 没有选中路径")), ["src/my"])

    hooks.setPicked([])
    assert.deepEqual(plain(hooks.collectReferences("@src/a.ts 和 @src/b.ts")), [
        "src/a.ts",
        "src/b.ts",
    ])
})

test("web 插件：多段查询逐段高亮", () => {
    const hooks = loadClient(composer(""))
    assert.deepEqual(plain(hooks.highlightNeedles("src/assets/ap")), ["src", "assets", "ap"])
    assert.deepEqual(plain(hooks.highlightNeedles("./src/")), ["src"])
    assert.deepEqual(plain(hooks.highlightNeedles("")), [])
    assert.equal(hooks.isMentionBoundary("看"), true)
    assert.equal(hooks.isMentionBoundary("，"), true)
    assert.equal(hooks.isMentionBoundary("a"), false)
    assert.equal(hooks.isMentionBoundary(""), true)
})

test("web 插件：输入框 @ 引用高亮区间", () => {
    const hooks = loadClient(composer(""))
    const ranges = (text: string) =>
        plain(hooks.mentionRanges(text)).map((range) => text.slice(range.start, range.end))

    assert.deepEqual(ranges("看 @src/app.ts 和 @README.md，还有 @plugins/ 里"), [
        "@src/app.ts",
        "@README.md",
        "@plugins/",
    ])
    assert.deepEqual(ranges('看 @"my file.txt" 和 @src/app.ts'), ['@"my file.txt"', "@src/app.ts"])
    assert.deepEqual(ranges("看@src/app.ts"), ["@src/app.ts"])
    assert.deepEqual(ranges("@src/app.ts."), ["@src/app.ts"], "尾随英文标点不算引用")
    assert.deepEqual(ranges('未闭合 @"abc/def'), ['@"abc/def'])
    assert.deepEqual(ranges('引号不跨行 @"abc\n普通文本'), ['@"abc'])
    assert.deepEqual(ranges("mail a@b.com"), [])
    assert.deepEqual(ranges("@"), [])
    assert.deepEqual(ranges(""), [])
})

test("web 插件：带空格的路径按 Harness 引号语法插入", () => {
    const hooks = loadClient(composer(""))
    assert.equal(hooks.formatMention({ path: "src/app.ts", type: "file" }), "@src/app.ts")
    assert.equal(hooks.formatMention({ path: "src", type: "directory" }), "@src/")
    assert.equal(hooks.formatMention({ path: "my file.txt", type: "file" }), '@"my file.txt"')
    assert.equal(hooks.formatMention({ path: "my dir", type: "directory" }), '@"my dir/"')
    assert.equal(hooks.formatMention({ path: 'bad"name.txt', type: "file" }), null)
})

test("web 插件：引号引用直接提取与发送", () => {
    const hooks = loadClient(composer(""))
    assert.deepEqual(plain(hooks.extractReferences('看 @"my file.txt" 和 @src/app.ts')), [
        "my file.txt",
        "src/app.ts",
    ])
    hooks.setPicked([])
    assert.deepEqual(plain(hooks.collectReferences('@"my file.txt" 看下')), ["my file.txt"])
})

test("web 插件：刷新中断标记随会话保存与恢复", () => {
    const hooks = loadClient(composer(""))
    const conv = {
        id: "c_resume_1",
        serverSessionId: "session-1",
        title: "测试",
        createdAt: 1,
        updatedAt: 2,
        provider: null,
        model: null,
        reasoning: null,
        permission: null,
        workspaceRoot: "/workspace",
        messages: [
            { role: "user", text: "帮我看下", at: 1 },
            { role: "assistant", text: "半截回复", at: 2, streaming: true, interrupted: true },
        ],
    }
    const payload = plain(hooks.conversationPayload(conv))
    const assistant = payload.messages[1] as Record<string, unknown>
    assert.equal(assistant["stopped"], true, "流式中的回复按已停止落盘")
    assert.equal(assistant["interrupted"], true, "刷新中断标记要落盘")

    const restored = plain(hooks.normalizeConversation(payload))
    assert.ok(restored !== null)
    assert.equal(restored.messages[1]?.interrupted, true, "重新打开后仍是待续接状态")

    // 正常完成的回复不写 interrupted 标记
    const finished = plain(
        hooks.conversationPayload({
            ...conv,
            messages: [{ role: "assistant", text: "完成", at: 3 }],
        }),
    )
    assert.equal("interrupted" in (finished.messages[0] as Record<string, unknown>), false)
})

test("web 插件：插话过程条目的保存与恢复", () => {
    const hooks = loadClient(composer(""))
    const conv = {
        id: "c_steer",
        serverSessionId: "session-1",
        title: "插话",
        createdAt: 1,
        updatedAt: 2,
        provider: null,
        model: null,
        reasoning: null,
        permission: null,
        workspaceRoot: "/workspace",
        messages: [
            { role: "user", text: "开始", at: 1 },
            {
                role: "assistant",
                text: "第一段正文",
                at: 2,
                process: [{ kind: "steer", text: "顺便看下 README", at: 3 }],
            },
        ],
    }
    const payload = plain(hooks.conversationPayload(conv))
    const process = (payload.messages[1] as { process?: Array<Record<string, unknown>> }).process
    assert.deepEqual(process, [{ kind: "steer", text: "顺便看下 README", at: 3 }])

    const restored = plain(hooks.normalizeConversation(payload))
    assert.ok(restored !== null)
    assert.equal(restored.messages[1]?.process?.[0]?.kind, "steer")
    assert.equal(restored.messages[1]?.process?.[0]?.text, "顺便看下 README")
})
