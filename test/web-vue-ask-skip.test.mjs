/*
 * 提问卡片的跳过语义。
 *
 * 跳过必须回传空答案。草稿跨提问保留时，跳过会带上上一轮的答案，
 * 所以这里同时钉住两件事：跳过传 null、提交后清空草稿。
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const source = readFileSync(
    join(
        import.meta.dirname,
        "..",
        "plugins",
        "wellspring-web",
        "frontend",
        "src",
        "components",
        "AskCard.vue",
    ),
    "utf8",
)

/** 取 <script setup> 段 */
function script() {
    const start = source.indexOf("<script setup")
    const end = source.indexOf("</script>")
    assert.ok(start >= 0 && end > start, "缺少 script setup")
    return source.slice(start, end)
}

/** 取模板段 */
function template() {
    const start = source.indexOf("<template>")
    assert.ok(start >= 0, "缺少 template")
    return source.slice(start)
}

test("跳过与回答分别传 null 与草稿，不共用回落逻辑", () => {
    const body = script()
    /* answer ?? custom.value 会把 null 当成没传，回落到上一轮草稿 */
    assert.ok(!body.includes("answer ?? custom.value"), "submit 不得把 null 回落到草稿")
    assert.match(body, /function submit\(answer: string \| null\)/, "submit 只接受 null 或字符串")
    assert.match(body, /void answerAsk\(answer\)/, "原样交给 answerAsk")
})

test("模板里两个跳过按钮都传 null，回答按钮传草稿", () => {
    const tpl = template()
    const skips = tpl.match(/@click="submit\(null\)"/g) ?? []
    assert.equal(skips.length, 2, "跳过并关闭与跳过都应传 null")
    assert.ok(tpl.includes('@click="submit(custom)"'), "回答按钮传草稿")
})

test("提交后清空草稿，换提问时也清空", () => {
    const body = script()
    assert.ok(body.includes('custom.value = ""'), "提交后清空草稿")
    assert.match(body, /watch\(/, "需要监听提问变化")
})

test("answerAsk 把 null 折算成空答案", () => {
    const store = readFileSync(
        join(import.meta.dirname, "..", "plugins", "wellspring-web", "frontend", "src", "store.ts"),
        "utf8",
    )
    assert.match(store, /answer: answer \?\? ""/, "空答案应显式回传空字符串")
})
