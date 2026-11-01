/*
 * 侧栏「运行中」标志的样式约定。
 *
 * 会话行用底边滚动的脉冲条，工作区行仍是呼吸点——两者混用会让侧栏
 * 出现两条不同节奏的呼吸灯，看着像坏了。这里把这条约定钉住。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { STYLES } from "../plugins/wellspring-web/src/assets/styles.ts"

/** 取出选择器对应规则块（配对大括号，避免撞到 media 里的同名规则） */
function ruleBlock(css, selector) {
    const start = css.indexOf(`\n${selector} {`)
    assert.notEqual(start, -1, `找不到规则 ${selector}`)
    const open = css.indexOf("{", start)
    let depth = 0
    for (let index = open; index < css.length; index += 1) {
        if (css[index] === "{") depth += 1
        else if (css[index] === "}") {
            depth -= 1
            if (depth === 0) return css.slice(open + 1, index)
        }
    }
    assert.fail(`规则 ${selector} 的大括号没有配对`)
}

test("会话运行中标志：底边脉冲滚动，不再是呼吸灯", () => {
    const block = ruleBlock(STYLES, ".conv-running")
    // 贴底边的整行脉冲条，而不是行内的一个小圆点
    assert.match(block, /position:\s*absolute/)
    assert.match(block, /bottom:\s*0/)
    assert.match(block, /animation:\s*conv-running-sweep/)
    assert.doesNotMatch(block, /ws-running-pulse/)
    assert.doesNotMatch(block, /border-radius:\s*50%/)
})

test("会话运行中标志：脉冲真的从一侧滚到另一侧", () => {
    const keyframes = ruleBlock(STYLES, "@keyframes conv-running-sweep")
    // from 在极左外、to 在极右外：background-position 的百分比是相对可移动余量算的，
    // 取 -100% / 200% 才能保证全程进出画面，不会从中间凭空出现
    assert.match(keyframes, /from\s*{[^}]*background-position:\s*-100%/)
    assert.match(keyframes, /to\s*{[^}]*background-position:\s*200%/)
})

test("工作区运行中标志：保持呼吸点", () => {
    const block = ruleBlock(STYLES, ".ws-running")
    assert.match(block, /animation:\s*ws-running-pulse/)
    assert.match(block, /border-radius:\s*50%/)
    assert.doesNotMatch(block, /absolute/)
})

test("减少动效：两种标志都停动画，但会话行仍看得出在跑", () => {
    // 文件里有多个 reduce 块（全局降级 + 按组件微调），挑管这两个标志的那个
    const blocks = STYLES.split("prefers-reduced-motion: reduce")
        .slice(1)
        .map((part) => part.slice(part.indexOf("{"), part.lastIndexOf("}")))
    const media = blocks.find(
        (part) => part.includes(".conv-running") && part.includes(".ws-running"),
    )
    assert.ok(media !== undefined)
    assert.match(media, /\.ws-running\s*{[^}]*animation:\s*none/)
    const conv = media.slice(media.indexOf(".conv-running"))
    assert.match(conv, /animation:\s*none/)
    // 不滚动时得留一条静止的底线，否则「运行中」就完全看不见了
    assert.match(conv, /background-color:/)
})
