/* @ 引用解析（从旧客户端 app.ts 迁移，纯函数）。 */

export var REFERENCE_TERMINATORS = "，。；：！？、（）【】《》「」『』“”‘’…—～)]}>\"'"

export var REFERENCE_TRAILING_PUNCTUATION = /[\s.,;:!?，。；：！？、（）()【】\[\]<>《》"'“”‘’]+$/

/**
 * 草稿里的 @ 引用区间（含 @ 与引号），引用提取与输入框高亮共用。
 * 语法与 Harness 一致：@path；带空格的路径写成 @"path with spaces"。
 */

export var MENTION_BOUNDARY_PUNCTUATION = ",;:!?()[]{}<>\"'，。；：！？、（）【】《》「」『』“”‘’…—～·"

export var MENTION_BOUNDARY_CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 中文聊天里常把 @ 紧跟在汉字或中文标点后面，这些都算合法起点 */

export function isMentionBoundary(character) {
    if (character === "") return true
    if (/\s/.test(character)) return true
    if (MENTION_BOUNDARY_PUNCTUATION.indexOf(character) !== -1) return true
    return MENTION_BOUNDARY_CJK.test(character)
}

/** 从 index 开始取到空白为止的触发词，没有空白才可能是指令 / 引用 */

export function isTriggerTokenBoundary(text, index) {
    return index === 0 || isMentionBoundary(text.charAt(index - 1))
}

/** 当前输入框里光标前的触发词（@ 或 /） */

export function mentionRanges(text) {
    var ranges = []
    if (typeof text !== "string" || text === "") return ranges
    var index = 0
    while (index < text.length) {
        var at = text.indexOf("@", index)
        if (at === -1) break
        index = at + 1
        if (!isTriggerTokenBoundary(text, at)) continue
        var end = at + 1
        if (text.charAt(end) === "\"") {
            var closing = text.indexOf("\"", end + 1)
            var lineEnd = text.indexOf("\n", end + 1)
            if (closing !== -1 && (lineEnd === -1 || closing < lineEnd)) end = closing + 1
            else end = lineEnd === -1 ? text.length : lineEnd
        } else {
            while (end < text.length) {
                var character = text.charAt(end)
                if (/\s/.test(character) || character === "@") break
                if (REFERENCE_TERMINATORS.indexOf(character) !== -1) break
                end += 1
            }
            var unquoted = text.slice(at + 1, end).replace(REFERENCE_TRAILING_PUNCTUATION, "")
            end = at + 1 + unquoted.length
        }
        if (end > at + 1) ranges.push({ start: at, end: end })
        index = end
    }
    return ranges
}

/** 引用区间的内容（去掉首尾引号与尾随标点） */

export function mentionRangeValue(text, range) {
    var value = text.slice(range.start + 1, range.end)
    if (value.charAt(0) === "\"") value = value.slice(1)
    if (value.length > 1 && value.charAt(value.length - 1) === "\"") {
        value = value.slice(0, value.length - 1)
    }
    return value.replace(REFERENCE_TRAILING_PUNCTUATION, "")
}

/** 从消息里提取 @ 引用的工作区路径（去重、截断） */

export function extractReferences(text) {
    var matches = []
    var ranges = mentionRanges(text)
    for (var index = 0; index < ranges.length; index += 1) {
        var value = mentionRangeValue(text, ranges[index])
        if (value === "" || matches.indexOf(value) !== -1) continue
        matches.push(value)
        if (matches.length >= 20) break
    }
    return matches
}

/** 选中项插入草稿的引用文本；带空格的路径用引号（Harness 语法） */

export function formatMention(entry) {
    var path = entry.type === "directory" ? entry.path + "/" : entry.path
    if (/[\u0000-\u001f\u007f"]/.test(path)) return null
    if (!/\s/.test(path)) return "@" + path
    return "@\"" + path + "\""
}

/** 去掉被更长引用覆盖的片段（my file.txt 会被空白切成 my） */

export function dropCoveredReferences(references) {
    var kept = []
    for (var index = 0; index < references.length; index += 1) {
        var candidate = references[index]
        var covered = false
        for (var other = 0; other < references.length; other += 1) {
            var longer = references[other]
            if (other === index || longer.length <= candidate.length) continue
            if (longer.indexOf(candidate) !== 0) continue
            if (/\s/.test(longer.charAt(candidate.length))) {
                covered = true
                break
            }
        }
        if (!covered) kept.push(candidate)
    }
    return kept
}

/**
 * 发送时附给 Agent 的引用：文本里能扫到的 @ 路径，加上从触发菜单里选中过的路径。
 * 后者用于带空格的文件名（my file.txt 无法只靠空白分词还原），且只在原文里仍能找到时生效。
 */


/** 发送时附给 Agent 的引用：文本里扫到的 @ 路径 + 从菜单选中过的路径（去重/去被覆盖项） */
export function collectReferences(text: string, picked: string[]): string[] {
    const references = extractReferences(text)
    for (const path of picked) {
        if (path === "" || references.includes(path)) continue
        if (typeof text !== "string" || text.indexOf(path) === -1) continue
        references.push(path)
        if (references.length >= 20) break
    }
    return dropCoveredReferences(references)
}
