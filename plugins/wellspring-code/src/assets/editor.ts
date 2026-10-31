/*
 * 客户端编辑器片段，与 highlight / app 片段拼进同一个 IIFE。
 * 约束：String.raw 原始字符串，不能出现反引号和美元花括号插值。
 *
 * 渲染方式是经典 textarea + 高亮层叠：textarea 负责输入、选择与滚动，
 * 下面的 pre 负责着色，右侧 canvas 画缩略图。
 */

export const EDITOR_JS = String.raw`
/* ── 编辑器 ───────────────────────────────────────────────── */

var EDITOR_PAD_TOP = 10
var EDITOR_PAD_LEFT = 20
var MAX_FIND_MATCHES = 2000
/* IME 组合期间单行 textarea 的上下文：光标前保留的字符数、光标后保留的字符数 */
var IME_CONTEXT_CHARS = 240
var IME_TRAILING_CHARS = 1200

function byId(id) {
    return document.getElementById(id)
}

function countNewlines(text) {
    var count = 0
    var index = -1
    while ((index = text.indexOf("\n", index + 1)) !== -1) count += 1
    return count
}

function lineColumnOf(value, position) {
    var before = value.slice(0, position)
    var line = countNewlines(before) + 1
    var column = position - before.lastIndexOf("\n")
    return { line: line, column: column }
}

function lineStartOf(value, position) {
    var index = value.lastIndexOf("\n", position - 1)
    return index + 1
}

function lineEndOf(value, position) {
    var index = value.indexOf("\n", position)
    return index === -1 ? value.length : index
}

/* 缩略图排版：每行最多占 2.4px，短文件只占上面一段，长文件才压缩到容器高度 */
var MINIMAP_ROW_HEIGHT = 2.4

function minimapRowHeightFor(count, height) {
    return Math.min(MINIMAP_ROW_HEIGHT, height / Math.max(1, count))
}

function minimapContentHeightFor(count, height) {
    return minimapRowHeightFor(count, height) * Math.max(1, count)
}

function minimapTargetLine(offsetY, rowHeight, count) {
    var line = Math.floor(offsetY / Math.max(rowHeight, 0.0001))
    return Math.max(0, Math.min(Math.max(1, count) - 1, line))
}

/* ── 自动补全：候选与排序（纯函数） ───────────────────────── */

var COMPLETION_LIMIT = 50
/* 输一个标识符字符就弹候选，和 VS Code 默认的手感一致 */
var COMPLETION_MIN_PREFIX = 1
var COMPLETION_MAX_WORDS = 4000
var COMPLETION_MAX_WORD_LENGTH = 40
var COMPLETION_MAX_SCAN_CHARS = 400000

/*
 * 语言词表复用高亮片段的定义（同一 IIFE 里的 var，取值放在函数里，
 * 单独求值 editor 片段也能跑）：关键字 + 类型 + 字面量都算候选。
 */
var COMPLETION_VOCABULARY = Object.create(null)

function collectVocabularyWords(target, seen, set) {
    if (set === null || set === undefined) return
    for (var key in set) {
        if (seen[key] === true) continue
        seen[key] = true
        target.push(key)
    }
}

function completionVocabulary(language) {
    var cached = COMPLETION_VOCABULARY[language]
    if (cached !== undefined) return cached
    var words = []
    var seen = Object.create(null)
    var family = C_FAMILIES[language]
    if (family !== undefined && family !== null) {
        collectVocabularyWords(words, seen, family.keywords)
        collectVocabularyWords(words, seen, family.extra)
        collectVocabularyWords(words, seen, family.types)
        collectVocabularyWords(words, seen, family.literals)
    } else if (language === "python") {
        collectVocabularyWords(words, seen, PYTHON_KEYWORDS)
        collectVocabularyWords(words, seen, PYTHON_BUILTINS)
    } else if (language === "shell" || language === "powershell") {
        collectVocabularyWords(words, seen, SHELL_KEYWORDS)
    }
    COMPLETION_VOCABULARY[language] = words
    return words
}

var COMPLETION_WORD_REGEX = /[A-Za-z_$][A-Za-z0-9_$]*/g

/** 光标前的标识符片段；prefix 为空表示光标不在词里 */
function completionPrefixRange(value, position) {
    var start = position
    while (start > 0) {
        var character = value.charAt(start - 1)
        if (!/[A-Za-z0-9_$]/.test(character)) break
        start -= 1
    }
    return { start: start, prefix: value.slice(start, position) }
}

/** 文档里出现过的标识符，按首次出现顺序去重 */
function collectDocumentWords(text, limit) {
    var words = []
    var seen = Object.create(null)
    var capped = text.length > COMPLETION_MAX_SCAN_CHARS ? text.slice(0, COMPLETION_MAX_SCAN_CHARS) : text
    COMPLETION_WORD_REGEX.lastIndex = 0
    var match
    while ((match = COMPLETION_WORD_REGEX.exec(capped)) !== null) {
        var word = match[0]
        if (word.length < 2 || word.length > COMPLETION_MAX_WORD_LENGTH) continue
        if (seen[word] === true) continue
        seen[word] = true
        words.push(word)
        if (words.length >= limit) break
    }
    return words
}

/** 前缀匹配等级：0 大小写一致、1 忽略大小写、-1 不匹配 */
function completionMatchWeight(label, prefix) {
    if (prefix === "") return 2
    if (label.slice(0, prefix.length) === prefix) return 0
    if (label.toLowerCase().slice(0, prefix.length) === prefix.toLowerCase()) return 1
    return -1
}

/** 候选 = 当前语言关键字 + 文档词，按前缀匹配程度排序 */
function buildCompletions(input) {
    var prefix = typeof input.prefix === "string" ? input.prefix : ""
    var words = Array.isArray(input.words) ? input.words : []
    var vocabulary = completionVocabulary(input.language)
    var candidates = []
    var seen = Object.create(null)
    function push(label, keyword) {
        if (label === "" || label === prefix || seen[label] === true) return
        var weight = completionMatchWeight(label, prefix)
        if (weight < 0) return
        seen[label] = true
        candidates.push({ label: label, keyword: keyword, weight: weight })
    }
    for (var index = 0; index < vocabulary.length; index += 1) push(vocabulary[index], true)
    for (var wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
        push(words[wordIndex], false)
    }
    candidates.sort(function (left, right) {
        if (left.weight !== right.weight) return left.weight - right.weight
        if (left.keyword !== right.keyword) {
            /* 有前缀时关键字优先；手动打开的空前缀先列文件里出现过的词 */
            if (prefix === "") return left.keyword ? 1 : -1
            return left.keyword ? -1 : 1
        }
        if (left.label.length !== right.label.length) return left.label.length - right.label.length
        return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
    })
    return candidates.slice(0, COMPLETION_LIMIT)
}

/*
 * 组合期间 textarea 只装光标行里的一个窗口（超长行时窗口比行短）。
 * composeLine 把窗口文本拼回整行，composeDocument 再把整行拼回全文。
 */
function composeLine(full, lineStart, lineEnd, windowStart, windowEnd, windowText) {
    return full.slice(lineStart, windowStart) + windowText + full.slice(windowEnd, lineEnd)
}

function composeDocument(full, lineStart, lineEnd, windowStart, windowEnd, windowText) {
    return (
        full.slice(0, lineStart) +
        composeLine(full, lineStart, lineEnd, windowStart, windowEnd, windowText) +
        full.slice(lineEnd)
    )
}

/** 组合提交后要插入的文本：行内 [caretColumn, committedEnd) 这一段就是输入法的产出 */
function composedInsertedText(lineText, caretColumn, committedEnd) {
    if (committedEnd <= caretColumn) return ""
    return lineText.slice(caretColumn, committedEnd)
}

/** 文本偏移 → 0 基行号（数前面有几个换行） */
function lineIndexOfOffset(value, offset) {
    var line = 0
    var index = -1
    while ((index = value.indexOf("\n", index + 1)) !== -1 && index < offset) line += 1
    return line
}

/**
 * 比较两版文本，返回需要重新分词的行范围（0 基，end 为开区间）。
 * 先找公共前缀/后缀，再把字符偏移换算成行号；多算一行无害，少算会留下旧颜色。
 */
function changedLineRange(oldValue, newValue, oldLineCount, newLineCount) {
    var oldLength = oldValue.length
    var newLength = newValue.length
    var maxPrefix = Math.min(oldLength, newLength)
    var prefix = 0
    while (prefix < maxPrefix && oldValue.charCodeAt(prefix) === newValue.charCodeAt(prefix)) {
        prefix += 1
    }
    var maxSuffix = maxPrefix - prefix
    var suffix = 0
    while (
        suffix < maxSuffix &&
        oldValue.charCodeAt(oldLength - 1 - suffix) === newValue.charCodeAt(newLength - 1 - suffix)
    ) {
        suffix += 1
    }
    var startLine = lineIndexOfOffset(oldValue, prefix)
    var oldEndLine = Math.min(oldLineCount, lineIndexOfOffset(oldValue, oldLength - suffix) + 1)
    var newEndLine = Math.min(newLineCount, lineIndexOfOffset(newValue, newLength - suffix) + 1)
    if (oldEndLine <= startLine) oldEndLine = Math.min(oldLineCount, startLine + 1)
    if (newEndLine <= startLine) newEndLine = Math.min(newLineCount, startLine + 1)
    return { startLine: startLine, oldEndLine: oldEndLine, newEndLine: newEndLine }
}

function createEditor(options) {
    var ta = byId("code-input")
    // 高亮层就是那个负责平移的 pre，内容直接挂在 pre 里。
    // 不要套内层 <code>：UA 样式会给 code 换成 monospace 字体，
    // 字形度量和 textarea 不一致，字号放大后文字会和选区、当前行高亮错位。
    var pre = byId("code-highlight")
    var layer = pre
    var gutterText = byId("gutter-text")
    var gutter = byId("gutter")
    var activeLine = byId("active-line")
    var minimap = byId("minimap")
    var codeView = byId("code-view")
    var findBar = byId("find-bar")
    var findInput = byId("find-input")
    var findCount = byId("find-count")
    var findPrev = byId("find-prev")
    var findNext = byId("find-next")
    var findClose = byId("find-close")
    var findReplaceRow = byId("find-replace-row")
    var findToggle = byId("find-toggle-replace")
    var replaceInput = byId("replace-input")
    var replaceOne = byId("replace-one")
    var replaceAllButton = byId("replace-all")

    var model = null
    var settings = { fontSize: 13, tabSize: 4, minimap: true }
    var lineHeight = 21
    var highlightTimer = null
    var highlightFrame = 0
    var viewportFrame = 0
    var viewNotifyTimer = null
    /** 高亮层只装视口附近的行：[viewStart, viewEnd) 是已渲染的行范围 */
    var viewStart = 0
    var viewEnd = 0
    /** 视口上方多渲染的上下文行：跨行注释/字符串的着色状态要能接上 */
    var VIEWPORT_CONTEXT_LINES = 240
    /** 视口下方多渲染的缓冲行：滚动时少几次重渲染 */
    var VIEWPORT_BUFFER_LINES = 160
    /** C 家族按行增量着色：视口上下各多渲染多少行（换片时不重分词） */
    var LINE_VIEW_BUFFER = 120
    /** 行级分词缓存：html[i] 是第 i 行的着色结果，state[i] 是第 i 行的行首状态 */
    var lineCache = null
    var lineCacheDirty = true
    var lineViewNodes = []
    var lineViewMode = false
    var pendingLineChange = null
    /** 行数或字符数超过阈值就启用中文组合输入的单行 textarea 快路径 */
    var LARGE_FILE_LINES = 1200
    var LARGE_FILE_CHARS = 60000
    var minimapTimer = null
    /** 镜像层当前是否只装了纯文本（还没上色） */
    var layerPlain = false
    /** 已渲染的行号数；行数没变时跳过重建 */
    var gutterLines = -1
    var padTop = EDITOR_PAD_TOP
    var padLeft = EDITOR_PAD_LEFT
    var padded = false
    var composing = false
    /*
     * IME 组合期间的单行代理状态。原生 textarea 一旦装进几千行，Chromium 每次
     * 组合更新都要重排整篇文本（4000 行、光标在文档后段时单次可达 1s 以上），
     * 与高亮层、分片这些优化无关。这里照 VS Code 的思路：组合期间 textarea 只装
     * 光标所在行，并贴到该行的真实位置，正文继续由高亮层负责显示。
     * 组合结束（或取消）时把行文本拼回全文并还原 textarea。null 表示走原生路径。
     */
    var composition = null
    /*
     * 极小概率下，某些输入法/浏览器会在组合期间换 textarea.value 时取消组合。
     * 连续两次「刚进组合就结束且没有任何输入事件」就判定这条快路径不可用，
     * 退回原生路径（慢，但至少能输入），直到页面刷新。
     */
    var imeFastPathDisabled = false
    var imeFastPathFailures = 0
    var imeCompositionStartedAt = 0
    var imeCompositionInputs = 0
    /** 组合期间点在高亮层上的位置：组合结束后补一次光标定位 */
    var pendingCompositionClick = null
    /** 组合期间盖住高亮层里当前行的那一条，避免和单行 textarea 重字 */
    var imeCover = document.createElement("div")
    imeCover.className = "ime-line-cover"
    imeCover.setAttribute("aria-hidden", "true")
    codeView.insertBefore(imeCover, ta)
    var find = { open: false, query: "", matches: [], index: 0 }

    function applySettings(next) {
        settings = next
        closeCompletion()
        lineHeight = Math.round(settings.fontSize * 1.62)
        var root = document.documentElement
        root.style.setProperty("--code-size", settings.fontSize + "px")
        root.style.setProperty("--line-height", lineHeight + "px")
        root.style.setProperty("--tab-size", String(settings.tabSize))
        minimap.classList.toggle("is-hidden", settings.minimap !== true)
        refreshPadding()
        spaceWidth = measureTextWidth(" ")
        scheduleMinimap()
        syncScroll()
        renderDiagnostics()
        scheduleBracketMatch()
        scheduleIndentGuides()
    }

    /* ── IME 组合：组合期间 textarea 只装光标行 ─────────────── */

    /** 文档全文：组合期间 textarea 只装光标行，全文留在 composition.full */
    function documentText() {
        return composition === null ? ta.value : composition.full
    }

    /** 组合进行中的正文（全文 + 光标行窗口里已被输入法改过的文本） */
    function compositionDocument() {
        if (composition === null) return ta.value
        return composeDocument(
            composition.full,
            composition.lineStart,
            composition.lineEnd,
            composition.windowStart,
            composition.windowEnd,
            ta.value
        )
    }

    function imeScrollTop() {
        return composition === null ? ta.scrollTop : composition.scrollTop
    }

    function imeScrollLeft() {
        return composition === null ? ta.scrollLeft : composition.scrollLeft
    }

    /*
     * 进入组合：把 textarea 缩成当前行。条件不满足（小文件、只读、带选区）返回 false，
     * 调用方退回原来的「隐藏高亮层、显示 textarea 全文」策略。
     */
    function beginComposition() {
        composition = null
        if (imeFastPathDisabled) return false
        if (model === null || model.readOnly === true) return false
        if (ta.selectionStart !== ta.selectionEnd) return false
        var value = ta.value
        if (!isLargeDocument(value)) return false
        try {
            var caret = ta.selectionStart
            var lineStart = lineStartOf(value, caret)
            var lineEnd = lineEndOf(value, caret)
            var column = caret - lineStart
            /* 超长行只取光标附近一段：视口外的字符看不见，没必要塞进 textarea */
            var windowStart = column > IME_CONTEXT_CHARS ? caret - IME_CONTEXT_CHARS : lineStart
            var windowEnd = Math.min(lineEnd, caret + IME_TRAILING_CHARS)
            composition = {
                full: value,
                lineStart: lineStart,
                lineEnd: lineEnd,
                lineNumber: lineColumnAt(caret).line,
                windowStart: windowStart,
                windowEnd: windowEnd,
                caret: caret,
                scrollTop: ta.scrollTop,
                scrollLeft: ta.scrollLeft,
                line: value.slice(windowStart, windowEnd)
            }
            positionComposition()
        } catch (error) {
            composition = null
            return false
        }
        return true
    }

    /** 把单行 textarea 贴到光标行的真实位置，并盖上高亮层里这一行 */
    function positionComposition() {
        var lineText = composition.line
        var lineLeft = paddingLeft() - composition.scrollLeft
        var dropped =
            composition.windowStart > composition.lineStart
                ? measureTextWidth(
                      composition.full.slice(composition.lineStart, composition.windowStart)
                  )
                : 0
        var width = measureTextWidth(lineText) + lineHeight * 4
        var visibleWidth = codeView.clientWidth - (lineLeft + dropped) + lineHeight * 2
        if (width < visibleWidth) width = visibleWidth
        if (width < 120) width = 120
        var top = paddingTop() + (composition.lineNumber - 1) * lineHeight - composition.scrollTop
        imeCover.style.top = Math.round(top) + "px"
        ta.style.inset = "auto"
        ta.style.left = Math.round(lineLeft + dropped) + "px"
        ta.style.top = Math.round(top) + "px"
        ta.style.width = Math.round(width) + "px"
        ta.style.height = lineHeight + "px"
        ta.style.padding = "0"
        ta.style.border = "0"
        ta.style.margin = "0"
        ta.style.overflow = "hidden"
        ta.style.scrollbarGutter = "auto"
        ta.value = lineText
        /* 换值若让浏览器立刻取消了组合，还原流程已经跑完，不要继续动样式 */
        if (composition === null) {
            resetCompositionTextarea()
            return
        }
        var column = composition.caret - composition.windowStart
        ta.setSelectionRange(column, column)
        ta.scrollTop = 0
        ta.scrollLeft = 0
        imeCover.classList.add("is-visible")
        codeView.classList.add("is-ime-composing")
    }

    function resetCompositionTextarea() {
        imeCover.classList.remove("is-visible")
        codeView.classList.remove("is-ime-composing")
        ta.removeAttribute("style")
    }

    function resetComposition() {
        composition = null
        composing = false
        pendingCompositionClick = null
        ta.classList.remove("is-composing")
        resetCompositionTextarea()
        layer.classList.remove("is-hidden")
    }

    function updateCompositionCursor() {
        if (composition === null) {
            updateCursor()
            return
        }
        /* windowStart 已经是全文里的绝对位置，不能再加 lineStart */
        var caret = composition.windowStart + ta.selectionStart
        var location = lineColumnAt(caret)
        renderActiveLine(location)
        var grew = ta.value.length - composition.line.length
        options.onStatus({
            line: location.line,
            column: location.column,
            selected: 0,
            lines: ensureLineStarts().length,
            characters: composition.full.length + grew,
            readonly: false
        })
    }

    /** 屏幕坐标 → 字符位置；组合期间点走时全尺寸 textarea 不存在，只能自己量 */
    function placeCaretAtPoint(clientX, clientY) {
        var rect = ta.getBoundingClientRect()
        var starts = ensureLineStarts()
        var line = Math.floor((clientY - rect.top + ta.scrollTop - paddingTop()) / lineHeight)
        if (line < 0) line = 0
        if (line > starts.length - 1) line = starts.length - 1
        var start = starts[line]
        var end = line + 1 < starts.length ? starts[line + 1] - 1 : ta.value.length
        var lineText = ta.value.slice(start, end)
        var offsetX = clientX - rect.left + ta.scrollLeft - paddingLeft()
        var low = 0
        var high = lineText.length
        while (low < high) {
            var middle = Math.ceil((low + high) / 2)
            if (measureTextWidth(lineText.slice(0, middle)) <= offsetX) low = middle
            else high = middle - 1
        }
        var position = start + low
        ta.setSelectionRange(position, position)
        scrollToLine(line + 1)
        updateCursor()
    }

    function endComposition() {
        resetCompositionTextarea()
        if (composition === null) {
            /* 原生路径：把组合开始时藏起来的层放回来 */
            layer.classList.remove("is-hidden")
            renderGutter()
            scheduleMinimap()
            scheduleHighlight()
            updateCursor()
            if (model !== null && typeof options.onChange === "function") options.onChange(ta.value)
            return
        }
        var state = composition
        composition = null
        var lineText = ta.value
        var caretInWindow = state.caret - state.windowStart
        var inserted = composedInsertedText(lineText, caretInWindow, ta.selectionStart)
        var nextValue = composeDocument(
            state.full,
            state.lineStart,
            state.lineEnd,
            state.windowStart,
            state.windowEnd,
            lineText
        )
        /*
         * 先还原成组合前的全文，再用 execCommand 重放这次组合结果：
         * 直接赋值 value 会清空原生撤销栈，重放能让这次中文输入仍可 Ctrl+Z。
         */
        ta.value = state.full
        ta.setSelectionRange(state.caret, state.caret)
        ta.scrollTop = state.scrollTop
        ta.scrollLeft = state.scrollLeft
        if (inserted !== "") {
            try {
                document.execCommand("insertText", false, inserted)
            } catch (error) {
                /* 交回下面的兜底分支 */
            }
        }
        if (ta.value !== nextValue) ta.value = nextValue
        var caretAfter = state.caret + inserted.length
        ta.setSelectionRange(caretAfter, caretAfter)
        ta.scrollTop = state.scrollTop
        ta.scrollLeft = state.scrollLeft
        /* execCommand 成功时输入事件已经刷新过一遍；这里补一次保证没有输入事件也一致 */
        afterEdit()
        renderGutter()
        syncScroll()
    }

    function setModel(next) {
        model = next
        closeCompletion()
        resetComposition()
        lineCache = null
        lineCacheDirty = true
        pendingLineChange = null
        lineViewNodes = []
        lineViewMode = false
        find.open = false
        findBar.hidden = true
        find.matches = []
        ta.value = next.content
        ta.readOnly = next.readOnly === true
        ta.classList.toggle("is-readonly", next.readOnly === true)
        pre.classList.remove("is-hidden")
        ta.classList.remove("is-composing")
        ta.scrollTop = 0
        ta.scrollLeft = 0
        ta.setSelectionRange(0, 0)
        renderAll()
        setDiagnostics([])
        buildLineStarts()
        renderBracketMatch()
        scheduleIndentGuides()
        syncScroll()
        updateCursor()
    }

    function clear() {
        closeCompletion()
        resetComposition()
        model = null
        lineCache = null
        lineCacheDirty = true
        pendingLineChange = null
        lineViewNodes = []
        lineViewMode = false
        ta.value = ""
        ta.readOnly = true
        find.open = false
        findBar.hidden = true
        setDiagnostics([])
        buildLineStarts()
        renderBracketMatch()
        scheduleIndentGuides()
        renderAll()
    }

    function setView(view) {
        if (view === null || view === undefined) return
        var length = ta.value.length
        var targetTop = typeof view.scrollTop === "number" ? Math.max(0, view.scrollTop) : 0
        var targetLeft = typeof view.scrollLeft === "number" ? Math.max(0, view.scrollLeft) : 0
        var start = typeof view.selectionStart === "number" ? Math.min(Math.max(0, view.selectionStart), length) : 0
        var end = typeof view.selectionEnd === "number" ? Math.min(Math.max(start, view.selectionEnd), length) : start
        var expectedModel = model
        var applyScroll = function () {
            /* 大文件刚设置 value 时布局可能还没算好，scrollTop 会被夹到 0；下一帧再补一次 */
            ta.scrollTop = targetTop
            ta.scrollLeft = targetLeft
        }
        applyScroll()
        renderHighlight()
        ta.setSelectionRange(start, end)
        syncScroll()
        updateCursor()
        if (targetTop > 0 || targetLeft > 0) {
            requestAnimationFrame(function () {
                if (model !== expectedModel) return
                if (Math.abs(ta.scrollTop - targetTop) <= 2 && Math.abs(ta.scrollLeft - targetLeft) <= 2) {
                    return
                }
                applyScroll()
                renderHighlight()
                syncScroll()
                updateCursor()
            })
        }
    }

    function getValue() {
        return compositionDocument()
    }

    function setReadOnly(value) {
        ta.readOnly = value
        ta.classList.toggle("is-readonly", value)
        if (model !== null) model.readOnly = value
    }

    function focus() {
        ta.focus()
    }

    function renderAll() {
        renderHighlight()
        renderGutter()
        renderActiveLine()
        scheduleMinimap()
        updateCursor()
    }

    function cancelPendingHighlight() {
        if (highlightTimer !== null) {
            clearTimeout(highlightTimer)
            highlightTimer = null
        }
        if (viewportFrame !== 0) {
            cancelAnimationFrame(viewportFrame)
            viewportFrame = 0
        }
    }

    function isLargeDocument(value) {
        return value.length > LARGE_FILE_CHARS || countNewlines(value) > LARGE_FILE_LINES
    }

    /* ── C 家族：按行增量着色（VS Code 式行状态缓存） ─────────
     * 行首状态 + 每行着色结果都缓存：改哪行只重分词哪行并只更新这一行的 DOM；
     * 只有跨行结构（块注释、模板字符串）变化时才沿行状态向后传播。
     */

    function incrementalLanguage(language) {
        if (language === "markdown" && typeof tokenizeMarkdownLine === "function") {
            return true
        }
        return (
            typeof tokenizeCFamilyLine === "function" &&
            typeof C_FAMILIES === "object" &&
            C_FAMILIES[language] !== undefined
        )
    }

    /** 行状态既可能是 C 家族的整数，也可能是 Markdown 的状态对象 */
    function lineStateEquals(left, right) {
        if (left === right) return true
        if (
            left !== null &&
            right !== null &&
            typeof left === "object" &&
            typeof right === "object"
        ) {
            return left.fence === right.fence && left.language === right.language
        }
        return false
    }

    function resetLineCache(language, value, starts) {
        lineCache = {
            language: language,
            value: value,
            lineCount: starts.length,
            html: new Array(starts.length),
            state: new Array(starts.length + 1),
            tokenizedTo: 0,
            repaintedTo: 0
        }
        for (var index = 0; index < lineCache.state.length; index += 1) lineCache.state[index] = -1
        lineCache.state[0] =
            language === "markdown" ? { fence: "", language: "" } : LINE_STATE_CODE
        lineViewNodes = []
        lineViewMode = false
        pendingLineChange = null
    }

    /** 分词 cache.tokenizedTo 这一行，结果写进缓存（不动 DOM） */
    function tokenizeCacheLine(starts) {
        var cache = lineCache
        var line = cache.tokenizedTo
        var value = cache.value
        var startOffset = starts[line]
        var endOffset = line + 1 < starts.length ? starts[line + 1] - 1 : value.length
        var text = endOffset > startOffset ? value.slice(startOffset, endOffset) : ""
        var state = cache.state[line]
        var result
        if (cache.language === "markdown" && typeof tokenizeMarkdownLine === "function") {
            result = tokenizeMarkdownLine(text, state)
        } else {
            if (
                state !== LINE_STATE_CODE &&
                state !== LINE_STATE_BLOCK_COMMENT &&
                state !== LINE_STATE_STRING
            ) {
                state = LINE_STATE_CODE
            }
            result = tokenizeCFamilyLine(text, state, cache.language)
        }
        var previousNextState = cache.state[line + 1]
        cache.html[line] = result.html
        cache.state[line + 1] = result.state
        cache.tokenizedTo = line + 1
        if (line + 1 > cache.repaintedTo) cache.repaintedTo = line + 1
        return { previousNextState: previousNextState, state: result.state, line: line }
    }

    /**
     * 把缓存推进到 target 行之前。分词完一行后如果「下一行的行首状态和缓存旧值一致」，
     * 说明后面所有行仍然成立，直接标记整篇有效：普通输入只分词 1 行，
     * 只有输入块注释开头、未闭合字符串这类会改变后续状态的情况才向后传播。
     */
    function ensureTokenizedUpTo(target, starts) {
        var cache = lineCache
        if (cache === null) return
        if (target > cache.lineCount) target = cache.lineCount
        while (cache.tokenizedTo < target) {
            var info = tokenizeCacheLine(starts)
            if (cache.tokenizedTo >= cache.lineCount) break
            var nextHtml = cache.html[cache.tokenizedTo]
            if (
                nextHtml !== undefined &&
                nextHtml !== null &&
                lineStateEquals(info.previousNextState, info.state)
            ) {
                cache.tokenizedTo = cache.lineCount
                break
            }
        }
    }

    /** 把「旧文本 → 新文本」的差异落到行缓存：中段置空，尾部整体平移 */
    function applyLineCacheEdit(diff, value, starts) {
        var cache = lineCache
        var start = diff.startLine
        var oldEnd = diff.oldEndLine
        var newEnd = diff.newEndLine
        var oldCount = cache.lineCount
        var newCount = starts.length
        var html = cache.html.slice(0, start)
        for (var line = start; line < newEnd; line += 1) html.push(null)
        for (var tail = oldEnd; tail < oldCount; tail += 1) html.push(cache.html[tail])
        var state = cache.state.slice(0, start + 1)
        for (var unknown = start + 1; unknown < newEnd; unknown += 1) state.push(-1)
        for (var oldState = oldEnd; oldState <= oldCount; oldState += 1) state.push(cache.state[oldState])
        cache.html = html
        cache.state = state
        cache.lineCount = newCount
        cache.value = value
        cache.tokenizedTo = start
        cache.repaintedTo = start
        pendingLineChange = diff
    }

    /** 文本变过就按差异更新行缓存；返回是否能用增量着色 */
    function syncLineCache() {
        if (model === null || !incrementalLanguage(model.language)) {
            lineCache = null
            lineViewNodes = []
            lineViewMode = false
            pendingLineChange = null
            return false
        }
        var starts = ensureLineStarts()
        if (lineCache === null || lineCache.language !== model.language) {
            resetLineCache(model.language, ta.value, starts)
            lineCacheDirty = false
            return true
        }
        if (!lineCacheDirty) return true
        var value = ta.value
        if (lineCache.value !== value) {
            var diff = changedLineRange(lineCache.value, value, lineCache.lineCount, starts.length)
            applyLineCacheEdit(diff, value, starts)
        }
        lineCacheDirty = false
        return true
    }

    function buildLineViewNodes(start, end) {
        var fragment = document.createDocumentFragment()
        var nodes = []
        for (var line = start; line < end; line += 1) {
            var node = document.createElement("span")
            node.className = "view-line"
            var html = lineCache.html[line]
            node.innerHTML = html === undefined || html === null ? "" : html
            fragment.appendChild(node)
            nodes.push(node)
        }
        layer.replaceChildren(fragment)
        lineViewNodes = nodes
        lineViewMode = true
    }

    /** 按行缓存渲染视口；只更新改动到的行，别的行 DOM 不动 */
    function renderLineView() {
        var starts = ensureLineStarts()
        var visible = visibleLineRange()
        var start = visible.first - LINE_VIEW_BUFFER
        if (start < 0) start = 0
        var end = visible.last + 1 + LINE_VIEW_BUFFER
        if (end > starts.length) end = starts.length
        ensureTokenizedUpTo(end, starts)
        var changed = pendingLineChange
        var windowUnchanged =
            lineViewMode === true &&
            start === viewStart &&
            end === viewEnd &&
            lineViewNodes.length === end - start
        if (windowUnchanged && changed !== null) {
            var changedOld = changed.oldEndLine - changed.startLine
            var changedNew = changed.newEndLine - changed.startLine
            if (changedOld !== changedNew) {
                /* 行数变了，后面行的 DOM 位置整体平移，这一屏重建 */
                buildLineViewNodes(start, end)
            } else {
                var updateEnd = changed.newEndLine
                if (lineCache.repaintedTo > updateEnd) updateEnd = lineCache.repaintedTo
                var from = changed.startLine > start ? changed.startLine : start
                var to = updateEnd < end ? updateEnd : end
                for (var line = from; line < to; line += 1) {
                    var node = lineViewNodes[line - start]
                    if (node === undefined) continue
                    var html = lineCache.html[line]
                    node.innerHTML = html === undefined || html === null ? "" : html
                }
            }
        } else if (!windowUnchanged) {
            buildLineViewNodes(start, end)
        }
        pendingLineChange = null
        viewStart = start
        viewEnd = end
        positionViewLayer()
        scheduleIndentGuides()
    }

    /** 其余语言：视口范围整片重新分词（没有行状态可缓存） */
    function renderSliceView() {
        lineViewMode = false
        lineViewNodes = []
        var range = highlightRange()
        var text = rangeText(range)
        var html = text === "" ? " " : highlightCode(text, model.language)
        layer.innerHTML = html
        layerPlain = false
        viewStart = range.start
        viewEnd = range.end
        positionViewLayer()
        buildLineStarts()
        scheduleIndentGuides()
    }

    /*
     * 高亮层只渲染视口附近的行。
     * 整篇文档几十万字符时，DOM 里堆几万个 span 再换 innerHTML，浏览器要重排整篇文本：
     * 4000 行实测一次输入后要 1s 才能重新上色。只给视口上下几百行上色，输入和滚动时
     * 重排的范围都限定在这个窗口里，整篇高度仍由 textarea 自己的滚动条决定。
     */

    /** 视口可见的行范围 */
    function visibleLineRange() {
        var starts = ensureLineStarts()
        var count = starts.length
        var height = ta.clientHeight
        var first = Math.floor((ta.scrollTop - paddingTop()) / lineHeight)
        var last = Math.ceil((ta.scrollTop + height - paddingTop()) / lineHeight)
        if (first < 0) first = 0
        if (last > count - 1) last = count - 1
        if (last < first) last = first
        return { first: first, last: last }
    }

    /** 要渲染的行范围：视口 + 上方上下文 + 下方缓冲 */
    function highlightRange() {
        var starts = ensureLineStarts()
        var count = starts.length
        var visible = visibleLineRange()
        var start = visible.first - VIEWPORT_CONTEXT_LINES
        if (start < 0) start = 0
        var end = visible.last + 1 + VIEWPORT_BUFFER_LINES
        if (end > count) end = count
        if (end <= start) end = Math.min(count, start + 1)
        return { start: start, end: end, starts: starts }
    }

    /** 行范围 → 文本；末尾不带换行，避免多渲染一行空行 */
    function rangeText(range) {
        var value = ta.value
        var startOffset = range.starts[range.start]
        var endOffset = range.end < range.starts.length ? range.starts[range.end] - 1 : value.length
        if (endOffset <= startOffset) return ""
        return value.slice(startOffset, endOffset)
    }

    /** 把视口高亮层平移到位：行首对齐 padding-left，行号对齐 padding-top */
    function positionViewLayer() {
        var x = paddingLeft() - ta.scrollLeft
        var y = paddingTop() + viewStart * lineHeight - ta.scrollTop
        layer.style.transform = "translate(" + x + "px, " + y + "px)"
    }

    function renderHighlight() {
        if (model === null) {
            layer.innerHTML = ""
            layerPlain = false
            lineViewMode = false
            lineViewNodes = []
            viewStart = 0
            viewEnd = 0
            return
        }
        if (composing) return
        cancelPendingHighlight()
        if (syncLineCache()) {
            renderLineView()
            return
        }
        renderSliceView()
    }

    /** 视口是否已被当前渲染范围覆盖：滚动时范围内只需要平移，不用重渲染 */
    function viewCoversVisible() {
        var visible = visibleLineRange()
        return visible.first >= viewStart && visible.last < viewEnd
    }

    /** 滚动到未渲染区域时下一帧补渲染，避免拖动滚动条看到空白 */
    function scheduleViewportRender() {
        if (viewportFrame !== 0 || composing) return
        viewportFrame = requestAnimationFrame(function () {
            viewportFrame = 0
            if (composing) return
            renderHighlight()
        })
    }

    function renderGutter() {
        var lines = countNewlines(documentText()) + 1
        if (lines === gutterLines) return
        gutterLines = lines
        var text = ""
        for (var index = 1; index <= lines; index += 1) {
            text += index === lines ? String(index) : index + "\n"
        }
        gutterText.textContent = text
    }

    /** 镜像层只填视口纯文本：textarea 的文字透明，可见文字全靠这一层 */
    function syncLayerText() {
        if (model === null || composing) return
        var range = highlightRange()
        var text = rangeText(range)
        var plainText = text === "" ? " " : text
        viewStart = range.start
        viewEnd = range.end
        if (!(layerPlain && layer.textContent === plainText)) {
            layer.textContent = plainText
            layerPlain = true
        }
        positionViewLayer()
    }

    /* C 家族与 Markdown 有行状态缓存：只需重分词改动的行，下一帧就能带着颜色更新，不需要防抖。
       其余语言没有行状态，只能整片重分词：每帧先铺纯文本保证内容跟上，停顿后再上色。 */
    function scheduleHighlight() {
        if (composing) return
        lineCacheDirty = true
        if (incrementalLanguage(model === null ? "" : model.language)) {
            if (highlightFrame === 0) {
                highlightFrame = requestAnimationFrame(function () {
                    highlightFrame = 0
                    if (composing) return
                    renderHighlight()
                })
            }
            return
        }
        if (highlightFrame === 0) {
            highlightFrame = requestAnimationFrame(function () {
                highlightFrame = 0
                if (composing) return
                syncLayerText()
            })
        }
        if (highlightTimer !== null) clearTimeout(highlightTimer)
        highlightTimer = setTimeout(function () {
            highlightTimer = null
            renderHighlight()
        }, 60)
    }

    function scheduleMinimap() {
        if (minimapTimer !== null) clearTimeout(minimapTimer)
        minimapTimer = setTimeout(function () {
            minimapTimer = null
            drawMinimap()
        }, 90)
    }

    function notifyViewChange() {
        if (typeof options.onViewChange !== "function") return
        if (viewNotifyTimer !== null) return
        viewNotifyTimer = setTimeout(function () {
            viewNotifyTimer = null
            if (typeof options.onViewChange === "function") options.onViewChange()
        }, 250)
    }

    function syncScroll() {
        /* 组合期间 textarea 只有一行、位置也不代表视口，滚动量以组合开始时的快照为准 */
        if (composition !== null) return
        var x = ta.scrollLeft
        var y = ta.scrollTop
        gutterText.style.transform = "translateY(" + -y + "px)"
        diagnosticLayer.style.transform = "translate(" + -x + "px, " + -y + "px)"
        bracketLayer.style.transform = "translate(" + -x + "px, " + -y + "px)"
        positionViewLayer()
        if (!viewCoversVisible()) scheduleViewportRender()
        scheduleIndentGuides()
        renderActiveLine()
        scheduleMinimap()
        notifyViewChange()
    }

    /* 内边距只在字号或主题变化时才会变。每次按键都读 getComputedStyle 会触发同步样式重算，
       在刚改过 gutter 文本之后代价尤其高 */
    function refreshPadding() {
        /* 组合期间 textarea 被压成单行、padding 临时改成 0，量出来的值不能用 */
        if (composition !== null) return
        var style = getComputedStyle(ta)
        var top = parseFloat(style.paddingTop)
        var left = parseFloat(style.paddingLeft)
        /* 元素隐藏时量到 0，保持未测量状态，等可见后再取 */
        if (isNaN(top) || top <= 0 || isNaN(left) || left <= 0) return
        padTop = top
        padLeft = left
        padded = true
    }

    function paddingTop() {
        if (!padded) refreshPadding()
        return padTop
    }

    function paddingLeft() {
        if (!padded) refreshPadding()
        return padLeft
    }

    /** caret 可传入，省掉一次整篇扫描 */
    function renderActiveLine(caret) {
        if (model === null || document.activeElement !== ta) {
            activeLine.classList.remove("is-visible")
            return
        }
        if (caret === undefined) caret = lineColumnAt(ta.selectionEnd)
        var scrollTop = imeScrollTop()
        var viewHeight = composition === null ? ta.clientHeight : codeView.clientHeight
        var top = paddingTop() + (caret.line - 1) * lineHeight - scrollTop
        if (top < 0 || top > viewHeight) {
            activeLine.classList.remove("is-visible")
            return
        }
        activeLine.classList.add("is-visible")
        activeLine.style.top = top + "px"
        activeLine.style.height = lineHeight + "px"
        /* 左边缘对齐文本行首：padding-left 减去横向滚动量。
           固定 left: 0 会让高亮条从容器最左开始，比行首往前多出一段 padding。 */
        activeLine.style.left = paddingLeft() - imeScrollLeft() + "px"
    }

    function updateCursor() {
        if (model === null) return
        if (composition !== null) {
            updateCompositionCursor()
            return
        }
        var value = ta.value
        var start = ta.selectionStart
        var end = ta.selectionEnd
        var caret = lineColumnAt(end)
        var selected = end - start
        renderActiveLine(caret)
        scheduleBracketMatch()
        options.onStatus({
            line: caret.line,
            column: caret.column,
            selected: selected,
            lines: ensureLineStarts().length,
            characters: value.length,
            readonly: model.readOnly === true
        })
        notifyViewChange()
    }

    function selectionLines() {
        var start = lineStartOf(ta.value, ta.selectionStart)
        var end = lineEndOf(ta.value, ta.selectionEnd)
        return { start: start, end: end, block: ta.value.slice(start, end) }
    }

    function insertAtCursor(text) {
        var start = ta.selectionStart
        var end = ta.selectionEnd
        var applied = false
        try {
            applied = document.execCommand("insertText", false, text)
        } catch (error) {
            applied = false
        }
        if (!applied) {
            var value = ta.value
            ta.value = value.slice(0, start) + text + value.slice(end)
            ta.selectionStart = start + text.length
            ta.selectionEnd = start + text.length
        }
        afterEdit()
    }

    function replaceRange(start, end, text, selectionStart, selectionEnd) {
        var applied = false
        try {
            ta.setSelectionRange(start, end)
            applied = document.execCommand("insertText", false, text)
        } catch (error) {
            applied = false
        }
        if (!applied) {
            var value = ta.value
            ta.value = value.slice(0, start) + text + value.slice(end)
        }
        if (typeof selectionStart === "number") {
            ta.selectionStart = selectionStart
            ta.selectionEnd = typeof selectionEnd === "number" ? selectionEnd : selectionStart
        }
        afterEdit()
        return applied
    }

    function afterEdit() {
        scheduleHighlight()
        renderGutter()
        scheduleMinimap()
        updateCursor()
        if (model !== null) {
            model.content = ta.value
            options.onChange(ta.value)
        }
    }

    function indentUnit() {
        var size = settings.tabSize
        var text = ""
        for (var index = 0; index < size; index += 1) text += " "
        return text
    }

    function indentSelection() {
        var lines = selectionLines()
        var unit = indentUnit()
        var block = lines.block
        var next = block
            .split("\n")
            .map(function (line) {
                return line === "" ? line : unit + line
            })
            .join("\n")
        replaceRange(lines.start, lines.end, next, ta.selectionStart + unit.length, ta.selectionEnd + unit.length * countNewlines(block))
    }

    function outdentSelection() {
        var lines = selectionLines()
        var block = lines.block
        var removedFirst = 0
        var removedTotal = 0
        var next = block
            .split("\n")
            .map(function (line, index) {
                var removed = 0
                if (line.charAt(0) === "\t") {
                    removed = 1
                } else {
                    var spaces = 0
                    while (spaces < settings.tabSize && line.charAt(spaces) === " ") spaces += 1
                    removed = spaces
                }
                if (index === 0) removedFirst = removed
                removedTotal += removed
                if (removed === 0) return line
                return line.slice(removed)
            })
            .join("\n")
        var start = Math.max(lines.start, ta.selectionStart - removedFirst)
        var end = Math.max(start, ta.selectionEnd - removedTotal)
        replaceRange(lines.start, lines.end, next, start, end)
    }

    function handleTab(event) {
        event.preventDefault()
        if (ta.selectionStart !== ta.selectionEnd) {
            if (event.shiftKey) outdentSelection()
            else indentSelection()
            return
        }
        if (event.shiftKey) {
            var lineStart = lineStartOf(ta.value, ta.selectionStart)
            var head = ta.value.slice(lineStart, ta.selectionStart)
            var remove = 0
            if (head.charAt(0) === "\t") remove = 1
            else {
                while (remove < settings.tabSize && head.charAt(remove) === " ") remove += 1
            }
            if (remove > 0) {
                replaceRange(lineStart, lineStart + remove, "", ta.selectionStart - remove, ta.selectionStart - remove)
            }
            return
        }
        var col = ta.selectionStart - lineStartOf(ta.value, ta.selectionStart)
        var width = settings.tabSize - (col % settings.tabSize)
        var spaces = ""
        for (var index = 0; index < width; index += 1) spaces += " "
        insertAtCursor(spaces)
    }

    function handleEnter(event) {
        event.preventDefault()
        var value = ta.value
        var start = ta.selectionStart
        var end = ta.selectionEnd
        var lineStart = lineStartOf(value, start)
        var before = value.slice(lineStart, start)
        var indentMatch = /^[ \t]*/.exec(before)
        var baseIndent = indentMatch === null ? "" : indentMatch[0]
        var trimmed = before.replace(/[ \t]+$/, "")
        var unit = indentUnit()
        var opensBlock = /[{\[(]$/.test(trimmed) || /:\s*$/.test(trimmed)
        var nextCharacter = value.charAt(end)
        var closesBlock = /^[}\])]/.test(nextCharacter)
        var extra = opensBlock ? unit : ""
        var insert = "\n" + baseIndent + extra
        var caretOffset = insert.length
        if (opensBlock && closesBlock) {
            insert += "\n" + baseIndent
        }
        var applied = false
        try {
            document.execCommand("insertText", false, insert)
            applied = true
        } catch (error) {
            applied = false
        }
        if (!applied) {
            ta.value = value.slice(0, start) + insert + value.slice(end)
        }
        var caret = start + caretOffset
        ta.selectionStart = caret
        ta.selectionEnd = caret
        afterEdit()
    }

    var PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "\u0060": "\u0060" }
    var CLOSERS = { ")": true, "]": true, "}": true, '"': true, "'": true, "\u0060": true }

    function handlePairKey(event) {
        var character = event.key
        var value = ta.value
        var start = ta.selectionStart
        var end = ta.selectionEnd
        var previous = start > 0 ? value.charAt(start - 1) : ""
        if (Object.prototype.hasOwnProperty.call(CLOSERS, character)) {
            if (start === end && value.charAt(start) === character) {
                event.preventDefault()
                ta.selectionStart = start + 1
                ta.selectionEnd = start + 1
                updateCursor()
                return true
            }
            return false
        }
        var closer = PAIRS[character]
        if (closer === undefined) return false
        if (character === '"' || character === "'" || character === "\u0060") {
            if (/[A-Za-z0-9_]/.test(previous)) return false
        }
        event.preventDefault()
        if (start !== end) {
            var selected = value.slice(start, end)
            replaceRange(start, end, character + selected + closer, start + 1, end + 1)
            return true
        }
        if (value.charAt(start) === closer) return false
        insertAtCursor(character + closer)
        ta.selectionStart = start + 1
        ta.selectionEnd = start + 1
        updateCursor()
        return true
    }

    function handleBackspace(event) {
        if (ta.selectionStart !== ta.selectionEnd) return
        var value = ta.value
        var start = ta.selectionStart
        if (start === 0) return
        var before = value.charAt(start - 1)
        var after = value.charAt(start)
        var pair = PAIRS[before]
        if (pair !== undefined && pair === after) {
            event.preventDefault()
            ta.setSelectionRange(start - 1, start + 1)
            var applied = false
            try {
                applied = document.execCommand("delete")
            } catch (error) {
                applied = false
            }
            if (!applied) {
                ta.value = value.slice(0, start - 1) + value.slice(start + 1)
                ta.selectionStart = start - 1
                ta.selectionEnd = start - 1
            }
            afterEdit()
        }
    }

    /* ── 查找 ─────────────────────────────────────────────── */

    function computeMatches() {
        var query = findInput.value
        find.query = query
        find.matches = []
        find.index = 0
        if (query === "") {
            updateFindCount()
            return
        }
        var value = ta.value
        var haystack = value.toLowerCase()
        var needle = query.toLowerCase()
        var index = haystack.indexOf(needle)
        while (index !== -1 && find.matches.length < MAX_FIND_MATCHES) {
            find.matches.push(index)
            index = haystack.indexOf(needle, index + Math.max(1, needle.length))
        }
        if (find.matches.length > 0) {
            var caret = ta.selectionStart
            var chosen = 0
            for (var position = 0; position < find.matches.length; position += 1) {
                if (find.matches[position] >= caret) {
                    chosen = position
                    break
                }
            }
            find.index = chosen
            revealMatch()
        }
        updateFindCount()
    }

    function revealMatch() {
        var start = find.matches[find.index]
        if (start === undefined) return
        var end = start + findInput.value.length
        ta.setSelectionRange(start, end)
        scrollToLine(lineColumnAt(start).line)
        updateFindCount()
        updateCursor()
    }

    function updateFindCount() {
        if (find.matches.length === 0) {
            findCount.textContent = findInput.value === "" ? "" : "0/0"
            return
        }
        findCount.textContent = find.index + 1 + "/" + find.matches.length
    }

    function stepMatch(delta) {
        if (find.matches.length === 0) {
            computeMatches()
            return
        }
        find.index = (find.index + delta + find.matches.length) % find.matches.length
        revealMatch()
    }

    function showReplaceRow(show) {
        if (findReplaceRow === null) return
        findReplaceRow.hidden = !show
        if (findToggle !== null) {
            findToggle.setAttribute("aria-expanded", show ? "true" : "false")
            findToggle.setAttribute("aria-label", show ? "隐藏替换" : "显示替换")
            findToggle.classList.toggle("is-active", show)
        }
    }

    function openFind(replace) {
        findBar.hidden = false
        showReplaceRow(replace === true)
        var selected = ta.value.slice(ta.selectionStart, ta.selectionEnd)
        if (selected !== "" && selected.indexOf("\n") === -1) {
            findInput.value = selected
        }
        if (replace === true && replaceInput !== null) {
            replaceInput.focus()
            replaceInput.select()
        } else {
            findInput.focus()
            findInput.select()
        }
        computeMatches()
    }

    function openFindReplace() {
        openFind(true)
    }

    function closeFind() {
        findBar.hidden = true
        find.open = false
        showReplaceRow(false)
        ta.focus()
    }

    /** 替换当前匹配；替换后把光标留在插入文本末尾，继续替换下一个 */
    function replaceCurrent() {
        var query = findInput.value
        if (query === "") return
        computeMatches()
        var start = find.matches[find.index]
        if (start === undefined) {
            flashStatus("没有可替换的匹配")
            return
        }
        var replacement = replaceInput === null ? "" : replaceInput.value
        /* execCommand 只对聚焦元素生效，替换前先把焦点交给 textarea，结束后再还回去 */
        var previous = document.activeElement
        ta.focus()
        replaceRange(
            start,
            start + query.length,
            replacement,
            start + replacement.length,
            start + replacement.length
        )
        computeMatches()
        restoreFocus(previous)
        flashStatus("已替换 1 处")
    }

    function restoreFocus(previous) {
        if (previous === null || previous === ta || typeof previous.focus !== "function") return
        try {
            if (previous.isConnected !== false) previous.focus()
        } catch (error) {
            /* 元素可能已经被移除 */
        }
    }

    /** 一次性替换全部匹配；整体作为一次编辑，可整体撤销 */
    function replaceAllMatches() {
        var query = findInput.value
        if (query === "") return
        computeMatches()
        var count = find.matches.length
        if (count === 0) {
            flashStatus("没有可替换的匹配")
            return
        }
        var replacement = replaceInput === null ? "" : replaceInput.value
        var value = ta.value
        var result = ""
        var cursor = 0
        for (var index = 0; index < find.matches.length; index += 1) {
            var at = find.matches[index]
            result += value.slice(cursor, at) + replacement
            cursor = at + query.length
        }
        result += value.slice(cursor)
        var caret = Math.min(ta.selectionStart, result.length)
        var previous = document.activeElement
        ta.focus()
        replaceRange(0, value.length, result, caret, caret)
        computeMatches()
        restoreFocus(previous)
        flashStatus("已替换 " + count + " 处")
    }

    function isFindOpen() {
        return findBar.hidden !== true
    }

    findInput.addEventListener("input", function () {
        computeMatches()
    })
    findInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            replaceCurrent()
        } else if (event.key === "Enter") {
            event.preventDefault()
            stepMatch(event.shiftKey ? -1 : 1)
        } else if (event.key === "Escape") {
            event.preventDefault()
            closeFind()
        }
    })
    findPrev.addEventListener("click", function () {
        stepMatch(-1)
    })
    findNext.addEventListener("click", function () {
        stepMatch(1)
    })
    findClose.addEventListener("click", closeFind)
    if (findToggle !== null) {
        findToggle.addEventListener("click", function () {
            var show = findReplaceRow === null || findReplaceRow.hidden
            showReplaceRow(show)
            if (show && replaceInput !== null) {
                replaceInput.focus()
                replaceInput.select()
            } else {
                findInput.focus()
            }
        })
    }
    if (replaceInput !== null) {
        replaceInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                event.preventDefault()
                replaceCurrent()
                return
            }
            if (event.key === "Escape") {
                event.preventDefault()
                closeFind()
            }
        })
    }
    if (replaceOne !== null) {
        replaceOne.addEventListener("click", replaceCurrent)
    }
    if (replaceAllButton !== null) {
        replaceAllButton.addEventListener("click", replaceAllMatches)
    }

    /* ── 自动补全 ─────────────────────────────────────────── */

    var autocomplete = byId("autocomplete")
    var autocompleteList = byId("autocomplete-list")
    /* 度量光标前文字的宽度：textarea 没有 caret 坐标 API，用同字体的探针量 */
    var completionProbe = document.createElement("span")
    completionProbe.className = "completion-probe"
    completionProbe.setAttribute("aria-hidden", "true")
    codeView.appendChild(completionProbe)
    var completion = {
        open: false,
        manual: false,
        items: [],
        index: 0,
        start: 0,
        end: 0,
        prefix: "",
        words: [],
        language: ""
    }

    function closeCompletion() {
        if (!completion.open) return
        completion.open = false
        completion.manual = false
        completion.items = []
        completion.index = 0
        if (autocomplete !== null) autocomplete.hidden = true
        if (autocompleteList !== null) autocompleteList.replaceChildren()
        ta.setAttribute("aria-expanded", "false")
        ta.removeAttribute("aria-activedescendant")
    }

    function completionLanguage() {
        return model === null || typeof model.language !== "string" ? "plaintext" : model.language
    }

    function renderCompletion() {
        if (autocomplete === null || autocompleteList === null) return
        autocompleteList.replaceChildren()
        for (var index = 0; index < completion.items.length; index += 1) {
            var item = completion.items[index]
            var option = document.createElement("li")
            option.className = "autocomplete-item"
            option.id = "completion-option-" + index
            option.dataset.index = String(index)
            option.setAttribute("role", "option")
            var label = document.createElement("span")
            label.className = "autocomplete-label"
            appendCompletionLabel(label, item.label, completion.prefix)
            option.appendChild(label)
            if (item.keyword === true) {
                var tag = document.createElement("span")
                tag.className = "autocomplete-tag"
                tag.textContent = "关键字"
                option.appendChild(tag)
            }
            option.addEventListener("mousedown", function (event) {
                event.preventDefault()
            })
            option.addEventListener("click", function (event) {
                completion.index = Number(event.currentTarget.dataset.index)
                acceptCompletion()
            })
            autocompleteList.appendChild(option)
        }
        updateCompletionSelection()
    }

    /** 前缀部分高亮；补全列表里的主信息是候选词本身 */
    function appendCompletionLabel(node, label, prefix) {
        if (prefix === "" || label.toLowerCase().indexOf(prefix.toLowerCase()) !== 0) {
            node.textContent = label
            return
        }
        var mark = document.createElement("mark")
        mark.className = "autocomplete-match"
        mark.textContent = label.slice(0, prefix.length)
        node.appendChild(mark)
        node.appendChild(document.createTextNode(label.slice(prefix.length)))
    }

    function updateCompletionSelection() {
        if (autocompleteList === null) return
        var options = autocompleteList.children
        for (var index = 0; index < options.length; index += 1) {
            var selected = index === completion.index
            options[index].setAttribute("aria-selected", selected ? "true" : "false")
            if (index === completion.index) {
                options[index].scrollIntoView({ block: "nearest" })
                ta.setAttribute("aria-activedescendant", options[index].id)
            }
        }
    }

    function moveCompletion(delta) {
        if (!completion.open || completion.items.length === 0) return
        var count = completion.items.length
        completion.index = (completion.index + delta + count) % count
        updateCompletionSelection()
    }

    function positionCompletion() {
        if (autocomplete === null) return
        var value = ta.value
        var caret = ta.selectionEnd
        var location = lineColumnAt(caret)
        completionProbe.textContent = value.slice(lineStartOf(value, caret), caret)
        var width = completionProbe.getBoundingClientRect().width
        var x = paddingLeft() + width - ta.scrollLeft
        var y = paddingTop() + (location.line - 1) * lineHeight - ta.scrollTop + lineHeight
        /* 先落位再量尺寸，超出视口就往上翻或向左收 */
        autocomplete.style.left = "0px"
        autocomplete.style.top = "0px"
        var popupWidth = autocomplete.offsetWidth
        var popupHeight = autocomplete.offsetHeight
        var viewWidth = codeView.clientWidth
        var viewHeight = codeView.clientHeight
        if (x + popupWidth > viewWidth - 8) x = Math.max(4, viewWidth - popupWidth - 8)
        if (y + popupHeight > viewHeight - 4) y = Math.max(0, y - lineHeight - popupHeight)
        autocomplete.style.left = Math.round(Math.max(0, x)) + "px"
        autocomplete.style.top = Math.round(Math.max(0, y)) + "px"
    }

    function openCompletion(manual) {
        if (autocomplete === null || autocompleteList === null || model === null) return false
        if (model.readOnly === true || composing) return false
        var value = ta.value
        var caret = ta.selectionEnd
        if (ta.selectionStart !== caret) return false
        var range = completionPrefixRange(value, caret)
        if (!manual && range.prefix.length < COMPLETION_MIN_PREFIX) return false
        /* 手动触发允许空前缀（列出文件里的词），自动触发必须已经输入标识符 */
        if (range.prefix === "" && !manual) return false
        completion.words = collectDocumentWords(value, COMPLETION_MAX_WORDS)
        completion.language = completionLanguage()
        var items = buildCompletions({
            prefix: range.prefix,
            words: completion.words,
            language: completion.language
        })
        if (items.length === 0) {
            closeCompletion()
            return false
        }
        completion.open = true
        completion.manual = manual
        completion.items = items
        completion.index = 0
        completion.start = range.start
        completion.end = caret
        completion.prefix = range.prefix
        autocomplete.hidden = false
        renderCompletion()
        positionCompletion()
        ta.setAttribute("aria-expanded", "true")
        return true
    }

    function refreshCompletion() {
        if (!completion.open) return false
        var value = ta.value
        var caret = ta.selectionEnd
        if (ta.selectionStart !== caret) {
            closeCompletion()
            return false
        }
        var range = completionPrefixRange(value, caret)
        /* 手动打开时可以从空前缀开始，输入一个字符仍然继续过滤 */
        if (range.prefix.length < COMPLETION_MIN_PREFIX && range.prefix !== "") {
            closeCompletion()
            return false
        }
        if (range.prefix === "" && !completion.manual) {
            closeCompletion()
            return false
        }
        var items = buildCompletions({
            prefix: range.prefix,
            words: completion.words,
            language: completion.language
        })
        if (items.length === 0) {
            closeCompletion()
            return false
        }
        completion.items = items
        completion.index = 0
        completion.start = range.start
        completion.end = caret
        completion.prefix = range.prefix
        renderCompletion()
        positionCompletion()
        return true
    }

    function acceptCompletion() {
        if (!completion.open) return false
        var item = completion.items[completion.index]
        if (item === undefined) {
            closeCompletion()
            return false
        }
        var start = completion.start
        var end = completion.end
        var label = item.label
        closeCompletion()
        replaceRange(start, end, label, start + label.length, start + label.length)
        ta.focus()
        return true
    }

    /** 按键在菜单打开时优先给菜单；返回 true 表示已消费 */
    function handleCompletionKeydown(event) {
        if (!completion.open) return false
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            moveCompletion(event.key === "ArrowDown" ? 1 : -1)
            return true
        }
        if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault()
            acceptCompletion()
            return true
        }
        if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            closeCompletion()
            return true
        }
        if (
            event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === "Home" ||
            event.key === "End" ||
            event.key === "PageUp" ||
            event.key === "PageDown"
        ) {
            closeCompletion()
        }
        return false
    }

    function handleCompletionInput(event) {
        if (completion.open) {
            refreshCompletion()
            return
        }
        if (model === null || model.readOnly === true || composing) return
        var inputType = event !== undefined && typeof event.inputType === "string" ? event.inputType : ""
        if (inputType !== "" && inputType.indexOf("insert") !== 0) return
        var caret = ta.selectionEnd
        if (ta.selectionStart !== caret) return
        var range = completionPrefixRange(ta.value, caret)
        if (range.prefix.length < COMPLETION_MIN_PREFIX) return
        if (!/^[A-Za-z_$]/.test(range.prefix)) return
        if (!/[A-Za-z0-9_$]/.test(ta.value.charAt(caret - 1))) return
        openCompletion(false)
    }

    /* ── 语法诊断标记 ─────────────────────────────────────── */

    var diagnosticLayer = document.createElement("div")
    diagnosticLayer.className = "diagnostic-layer"
    diagnosticLayer.id = "diagnostic-layer"
    diagnosticLayer.setAttribute("aria-hidden", "true")
    codeView.insertBefore(diagnosticLayer, ta)
    var diagnostics = []

    function measureTextWidth(text) {
        if (text === "") return 0
        completionProbe.textContent = text
        return completionProbe.getBoundingClientRect().width
    }

    /** 按行列把错误范围画成波浪线；位置按字符宽度量出来，随滚动整层平移 */
    function renderDiagnostics() {
        diagnosticLayer.replaceChildren()
        if (model === null || diagnostics.length === 0) return
        var lines = documentText().split("\n")
        var top = paddingTop()
        var left = paddingLeft()
        for (var index = 0; index < diagnostics.length; index += 1) {
            var item = diagnostics[index]
            var lineNumber = Math.max(1, Math.floor(Number(item.line) || 1))
            var lineText = lines[lineNumber - 1]
            if (lineText === undefined) continue
            var column = Math.max(1, Math.floor(Number(item.column) || 1))
            var start = Math.min(lineText.length, column - 1)
            var end = start + 1
            if (
                typeof item.endLine === "number" &&
                item.endLine === lineNumber &&
                typeof item.endColumn === "number"
            ) {
                end = Math.min(lineText.length, Math.max(start + 1, Math.floor(item.endColumn) - 1))
            } else {
                end = Math.max(start + 1, lineText.length)
            }
            var mark = document.createElement("span")
            mark.className = "diagnostic-mark"
            mark.dataset.severity = item.severity === "warning" ? "warning" : "error"
            mark.style.left = Math.round(left + measureTextWidth(lineText.slice(0, start))) + "px"
            mark.style.top = Math.round(top + (lineNumber - 1) * lineHeight) + "px"
            mark.style.width = Math.max(6, Math.round(measureTextWidth(lineText.slice(start, end)))) + "px"
            diagnosticLayer.appendChild(mark)
        }
    }

    function setDiagnostics(items) {
        diagnostics = Array.isArray(items) ? items : []
        renderDiagnostics()
    }

    /* ── 括号配对高亮与缩进参考线 ─────────────────────────── */

    var bracketLayer = document.createElement("div")
    bracketLayer.className = "bracket-layer"
    bracketLayer.setAttribute("aria-hidden", "true")
    codeView.insertBefore(bracketLayer, diagnosticLayer)
    var bracketFrame = 0
    var bracketMatch = null

    /* 缩进参考线画在 canvas 上：滚动时只重绘可见行，不增加 DOM 节点 */
    var guideCanvas = document.createElement("canvas")
    guideCanvas.className = "indent-canvas"
    guideCanvas.setAttribute("aria-hidden", "true")
    codeView.insertBefore(guideCanvas, codeView.firstChild)
    var guideFrame = 0
    var guideContext = guideCanvas.getContext("2d")
    var lineStarts = [0]
    var lineStartsLength = -1
    var spaceWidth = 0

    function buildLineStarts() {
        var value = documentText()
        var starts = [0]
        var index = -1
        while ((index = value.indexOf("\n", index + 1)) !== -1) {
            starts.push(index + 1)
        }
        lineStarts = starts
        lineStartsLength = value.length
    }

    function ensureLineStarts() {
        if (lineStartsLength !== documentText().length) buildLineStarts()
        return lineStarts
    }

    /** 绝对字符位置 → 1 基行列 */
    function lineColumnAt(position) {
        var starts = ensureLineStarts()
        var low = 0
        var high = starts.length - 1
        while (low < high) {
            var middle = Math.ceil((low + high) / 2)
            if (starts[middle] <= position) low = middle
            else high = middle - 1
        }
        return { line: low + 1, column: position - starts[low] + 1 }
    }

    function scheduleBracketMatch() {
        if (bracketFrame !== 0) return
        bracketFrame = requestAnimationFrame(function () {
            bracketFrame = 0
            renderBracketMatch()
        })
    }

    function appendBracketMark(position, char) {
        var mark = document.createElement("span")
        mark.className = "bracket-mark"
        var starts = ensureLineStarts()
        var lineStart = starts[position.line - 1]
        if (lineStart === undefined) return
        mark.style.left = Math.round(paddingLeft() + measureTextWidth(ta.value.slice(lineStart, lineStart + position.column - 1))) + "px"
        mark.style.top = Math.round(paddingTop() + (position.line - 1) * lineHeight) + "px"
        mark.style.width = Math.max(4, Math.round(measureTextWidth(char))) + "px"
        bracketLayer.appendChild(mark)
    }

    function renderBracketMatch() {
        /* 组合期间 textarea 只装光标行，全文在 composition.full 里，这里不做配对 */
        if (composition !== null) return
        bracketLayer.replaceChildren()
        bracketMatch = null
        if (model === null || typeof bracketMatchAt !== "function") return
        var match = bracketMatchAt(ta.value, ta.selectionEnd, model.language)
        if (match === null) return
        bracketMatch = match
        appendBracketMark(lineColumnAt(match.open), ta.value.charAt(match.open))
        appendBracketMark(lineColumnAt(match.close), ta.value.charAt(match.close))
    }

    function scheduleIndentGuides() {
        if (guideFrame !== 0) return
        guideFrame = requestAnimationFrame(function () {
            guideFrame = 0
            drawIndentGuides()
        })
    }

    function drawIndentGuides() {
        if (composition !== null) return
        if (guideContext === null || model === null) {
            if (guideContext !== null) {
                guideContext.setTransform(1, 0, 0, 1, 0, 0)
                guideContext.clearRect(0, 0, guideCanvas.width, guideCanvas.height)
            }
            return
        }
        var width = codeView.clientWidth
        var height = codeView.clientHeight
        if (width <= 0 || height <= 0) return
        var ratio = window.devicePixelRatio || 1
        var pixelWidth = Math.round(width * ratio)
        var pixelHeight = Math.round(height * ratio)
        if (guideCanvas.width !== pixelWidth || guideCanvas.height !== pixelHeight) {
            guideCanvas.width = pixelWidth
            guideCanvas.height = pixelHeight
        }
        guideContext.setTransform(ratio, 0, 0, ratio, 0, 0)
        guideContext.clearRect(0, 0, width, height)
        var starts = ensureLineStarts()
        if (starts.length < 2) return
        var color = getComputedStyle(document.documentElement).getPropertyValue("--indent-guide").trim()
        if (color === "") color = "rgba(255, 255, 255, 0.08)"
        guideContext.fillStyle = color
        if (!(spaceWidth > 0)) spaceWidth = measureTextWidth(" ")
        var tabWidth = spaceWidth * settings.tabSize
        if (!(tabWidth > 0)) return
        var value = ta.value
        var top = paddingTop()
        var left = paddingLeft()
        var firstLine = Math.max(0, Math.floor(ta.scrollTop / lineHeight) - 1)
        var lastLine = Math.min(
            starts.length - 1,
            Math.ceil((ta.scrollTop + height) / lineHeight) + 1
        )
        for (var line = firstLine; line <= lastLine; line += 1) {
            var start = starts[line]
            var indent = 0
            var cursor = start
            while (cursor < value.length) {
                var character = value.charAt(cursor)
                if (character === " ") indent += 1
                else if (character === "\t") indent += settings.tabSize - (indent % settings.tabSize)
                else break
                cursor += 1
            }
            var depth = Math.floor(indent / settings.tabSize)
            if (depth < 1) continue
            var lineTop = Math.round(top + line * lineHeight - ta.scrollTop)
            for (var level = 1; level <= depth && level <= 20; level += 1) {
                guideContext.fillRect(Math.round(left + level * tabWidth), lineTop, 1, lineHeight)
            }
        }
    }

    /* ── 滚动与光标 ───────────────────────────────────────── */

    function scrollToLine(number) {
        var target = Math.max(1, Math.min(number, countNewlines(ta.value) + 1))
        var top = paddingTop() + (target - 1) * lineHeight
        if (top < ta.scrollTop + lineHeight || top > ta.scrollTop + ta.clientHeight - lineHeight * 2) {
            ta.scrollTop = Math.max(0, top - ta.clientHeight / 2)
            renderHighlight()
        }
        syncScroll()
        renderActiveLine()
    }

    function revealLine(number, column) {
        ta.focus()
        var line = Math.max(1, Math.min(number, countNewlines(ta.value) + 1))
        var position = 0
        var current = 1
        while (current < line) {
            var next = ta.value.indexOf("\n", position)
            if (next === -1) break
            position = next + 1
            current += 1
        }
        var offset = position + Math.max(0, (column || 1) - 1)
        ta.setSelectionRange(offset, offset)
        scrollToLine(line)
        updateCursor()
    }

    /** 光标所在的标识符，用于转到定义 */
    function wordAtCaret() {
        var value = documentText()
        var position = ta.selectionEnd
        var start = position
        while (start > 0 && /[A-Za-z0-9_$]/.test(value.charAt(start - 1))) start -= 1
        var end = position
        while (end < value.length && /[A-Za-z0-9_$]/.test(value.charAt(end))) end += 1
        return { word: value.slice(start, end), start: start, end: end }
    }

    function triggerDefinition() {
        if (model === null || composition !== null || typeof options.onDefinition !== "function") return
        var target = wordAtCaret()
        if (target.word === "") return
        options.onDefinition(target.word, target.start)
    }

    ta.addEventListener("scroll", function () {
        /* 组合期间 textarea 缩成一行并贴到光标处，它的 scrollTop 不再代表视口 */
        if (composition !== null) return
        syncScroll()
        closeCompletion()
    })
    ta.addEventListener("keydown", function (event) {
        if (event.isComposing || composing) return
        if (handleCompletionKeydown(event)) return
        if ((event.ctrlKey || event.metaKey) && event.key === " ") {
            event.preventDefault()
            if (!openCompletion(true)) flashStatus("没有可补全的项")
            return
        }
        if (event.key === "F12") {
            event.preventDefault()
            triggerDefinition()
            return
        }
        if (event.key === "Tab") {
            handleTab(event)
            return
        }
        if (event.key === "Enter") {
            handleEnter(event)
            return
        }
        if (event.key === "Backspace") {
            handleBackspace(event)
            return
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            handlePairKey(event)
        }
    })
    ta.addEventListener("input", function (event) {
        if (composing) {
            imeCompositionInputs += 1
            /*
             * 组合期间 textarea 只有光标行，正文要从 composition.full 拼回来；
             * 镜像层/行号/缩略图保持组合前的状态，等 compositionend 再统一刷新。
             */
            updateCursor()
            if (model !== null) {
                var live = compositionDocument()
                model.content = live
                options.onChange(live)
            }
            return
        }
        scheduleHighlight()
        renderGutter()
        scheduleMinimap()
        updateCursor()
        handleCompletionInput(event)
        if (model !== null) {
            model.content = ta.value
            options.onChange(ta.value)
        }
    })
    ta.addEventListener("click", function (event) {
        closeCompletion()
        updateCursor()
        if (event.ctrlKey || event.metaKey) triggerDefinition()
    })
    ta.addEventListener("keyup", updateCursor)
    ta.addEventListener("focus", updateCursor)
    /* 组合期间只有光标行那一小块 textarea 能接鼠标，点其它行会落在高亮层上：
       先记下坐标，等 blur 结束组合、textarea 复原后按坐标补一次光标定位 */
    codeView.addEventListener("mousedown", function (event) {
        if (composition === null) return
        pendingCompositionClick = { x: event.clientX, y: event.clientY }
    })
    codeView.addEventListener("click", function () {
        if (pendingCompositionClick === null) return
        var point = pendingCompositionClick
        pendingCompositionClick = null
        if (composition !== null) return
        focus()
        placeCaretAtPoint(point.x, point.y)
    })
    ta.addEventListener("blur", function () {
        /* 某些浏览器失焦时不保证发 compositionend，这里兜底还原全文 */
        if (composing) {
            composing = false
            ta.classList.remove("is-composing")
            endComposition()
        }
        closeCompletion()
        renderActiveLine()
    })
    ta.addEventListener("compositionstart", function () {
        composing = true
        imeCompositionStartedAt = Date.now()
        imeCompositionInputs = 0
        closeCompletion()
        /* 未完成的上色先停掉，否则组合期间还会往高亮层里插 DOM */
        cancelPendingHighlight()
        ta.classList.add("is-composing")
        if (beginComposition()) return
        /* 小文件 / 只读 / 有选区：保持原来的原生行为，整层隐藏、textarea 显示全文 */
        layer.classList.add("is-hidden")
    })
    ta.addEventListener("compositionend", function () {
        /*
         * 判断快路径是否被当前 IME 拒绝：组合刚开始（<60ms）就结束、且期间没有任何
         * 输入事件。正常取消（Esc）很少连续两次这么快，误判只会退回原生路径。
         */
        if (composition !== null) {
            if (imeCompositionInputs === 0 && Date.now() - imeCompositionStartedAt < 60) {
                imeFastPathFailures += 1
                if (imeFastPathFailures >= 2) imeFastPathDisabled = true
            } else if (imeCompositionInputs > 0) {
                imeFastPathFailures = 0
            }
        }
        composing = false
        ta.classList.remove("is-composing")
        endComposition()
    })

    /* ── 缩略图 ───────────────────────────────────────────── */

    var minimapRowHeight = MINIMAP_ROW_HEIGHT
    var minimapLineCount = 1
    var minimapContentHeight = MINIMAP_ROW_HEIGHT

    function minimapPalette() {
        var theme = document.documentElement.getAttribute("data-theme")
        if (theme === "light") {
            return {
                line: "rgba(90, 100, 110, 0.38)",
                comment: "rgba(70, 130, 80, 0.5)",
                string: "rgba(170, 90, 60, 0.5)",
                keyword: "rgba(40, 100, 180, 0.55)",
                highlight: "rgba(0, 0, 0, 0.06)",
                border: "rgba(0, 0, 0, 0.1)"
            }
        }
        return {
            line: "rgba(190, 200, 210, 0.34)",
            comment: "rgba(106, 153, 85, 0.5)",
            string: "rgba(206, 145, 120, 0.5)",
            keyword: "rgba(86, 156, 214, 0.55)",
            highlight: "rgba(255, 255, 255, 0.06)",
            border: "rgba(255, 255, 255, 0.12)"
        }
    }

    function minimapLayout() {
        var height = Math.max(1, minimap.clientHeight)
        var count = Math.max(1, countNewlines(ta.value) + 1)
        return {
            height: height,
            count: count,
            rowHeight: minimapRowHeightFor(count, height),
            contentHeight: minimapContentHeightFor(count, height),
        }
    }

    function drawMinimap() {
        if (model === null || settings.minimap !== true || composing) return
        var width = minimap.clientWidth
        var height = minimap.clientHeight
        if (width === 0 || height === 0) return
        var ratio = window.devicePixelRatio || 1
        var pixelWidth = Math.max(1, Math.floor(width * ratio))
        var pixelHeight = Math.max(1, Math.floor(height * ratio))
        if (minimap.width !== pixelWidth) minimap.width = pixelWidth
        if (minimap.height !== pixelHeight) minimap.height = pixelHeight
        var context = minimap.getContext("2d")
        if (context === null) return
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        context.clearRect(0, 0, width, height)
        var palette = minimapPalette()
        var lines = ta.value.split("\n")
        var layout = minimapLayout()
        minimapRowHeight = layout.rowHeight
        minimapLineCount = layout.count
        minimapContentHeight = layout.contentHeight
        // 行距太小（超长文件）时按行采样，保证每 2.4px 左右画一条、且不会画出容器
        var step = layout.rowHeight >= MINIMAP_ROW_HEIGHT ? 1 : Math.max(1, Math.round(MINIMAP_ROW_HEIGHT / layout.rowHeight))
        var barHeight = Math.max(1, Math.min(MINIMAP_ROW_HEIGHT, layout.rowHeight * step))
        for (var index = 0; index < layout.count; index += step) {
            var line = lines[index]
            if (line === undefined) break
            var trimmed = line.replace(/^\s+/, "")
            if (trimmed === "") continue
            var indent = line.length - trimmed.length
            var x = Math.min(width * 0.34, indent * 0.55)
            var barWidth = Math.min(width - x - 2, Math.max(2, trimmed.length * 0.55))
            var y = index * layout.rowHeight
            var color = palette.line
            if (trimmed.slice(0, 2) === "//" || trimmed.charAt(0) === "#" || trimmed.slice(0, 2) === "/*") {
                color = palette.comment
            } else if (/^(?:const|let|var|function|class|import|export|return|if|for|while|def|fn|pub|func)\b/.test(trimmed)) {
                color = palette.keyword
            } else if (trimmed.charAt(0) === '"' || trimmed.charAt(0) === "'") {
                color = palette.string
            }
            context.fillStyle = color
            context.fillRect(x, y, barWidth, barHeight)
        }
        drawMinimapViewport()
    }

    function drawMinimapViewport() {
        if (model === null || settings.minimap !== true) return
        var context = minimap.getContext("2d")
        if (context === null) return
        var width = minimap.clientWidth
        var height = minimap.clientHeight
        if (width === 0 || height === 0) return
        // 文件能一屏放下时没有滚动范围，不需要画视口框
        if (ta.scrollHeight <= ta.clientHeight) return
        var ratio = window.devicePixelRatio || 1
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        var palette = minimapPalette()
        var top = (ta.scrollTop / lineHeight) * minimapRowHeight
        var visible = (ta.clientHeight / lineHeight) * minimapRowHeight
        if (visible > minimapContentHeight) visible = minimapContentHeight
        if (top + visible > minimapContentHeight) {
            top = Math.max(0, minimapContentHeight - visible)
        }
        var boxHeight = Math.max(8, visible)
        context.fillStyle = palette.highlight
        context.fillRect(0, top, width, boxHeight)
        context.strokeStyle = palette.border
        context.lineWidth = 1
        context.strokeRect(0.5, top + 0.5, width - 1, boxHeight - 1)
    }

    function minimapSeek(event) {
        var rect = minimap.getBoundingClientRect()
        var offsetY = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
        // 按缩略图的行距换算成目标行；点在内容下方就停在最后一行
        var targetLine = minimapTargetLine(offsetY, minimapRowHeight, minimapLineCount)
        ta.scrollTop = Math.max(0, targetLine * lineHeight - ta.clientHeight / 2)
    }

    var minimapDragging = false
    minimap.addEventListener("pointerdown", function (event) {
        minimapDragging = true
        minimapSeek(event)
        if (typeof minimap.setPointerCapture === "function") {
            minimap.setPointerCapture(event.pointerId)
        }
    })
    minimap.addEventListener("pointermove", function (event) {
        if (minimapDragging) minimapSeek(event)
    })
    minimap.addEventListener("pointerup", function () {
        minimapDragging = false
    })
    minimap.addEventListener("pointercancel", function () {
        minimapDragging = false
    })
    // 鼠标停在缩略图上时滚轮也滚动编辑器（和 VS Code 一致）
    minimap.addEventListener(
        "wheel",
        function (event) {
            if (model === null) return
            if (ta.scrollHeight <= ta.clientHeight) return
            event.preventDefault()
            var delta = event.deltaMode === 1 ? event.deltaY * lineHeight * 3 : event.deltaY
            ta.scrollTop = Math.max(0, Math.min(ta.scrollHeight - ta.clientHeight, ta.scrollTop + delta))
            syncScroll()
        },
        { passive: false },
    )

    if (typeof ResizeObserver === "function") {
        var resizeObserver = new ResizeObserver(function () {
            closeCompletion()
            /* 视口大小变了可见行数也变，已渲染的行范围可能不够，按需补渲染 */
            syncScroll()
            drawMinimap()
            scheduleIndentGuides()
        })
        resizeObserver.observe(minimap)
        resizeObserver.observe(codeView)
    } else {
        window.addEventListener("resize", function () {
            syncScroll()
            drawMinimap()
        })
    }

    applySettings(settings)

    return {
        setModel: setModel,
        setView: setView,
        clear: clear,
        getValue: getValue,
        setReadOnly: setReadOnly,
        focus: focus,
        setSettings: applySettings,
        openFind: openFind,
        openFindReplace: openFindReplace,
        closeFind: closeFind,
        isFindOpen: isFindOpen,
        revealLine: revealLine,
        scrollToLine: scrollToLine,
        refreshHighlight: renderHighlight,
        setDiagnostics: setDiagnostics,
        redrawMinimap: scheduleMinimap,
        handleGlobalKey: function (event) {
            if (event.key === "Escape" && completion.open) {
                closeCompletion()
                return true
            }
            if (event.key === "Escape" && isFindOpen()) {
                closeFind()
                return true
            }
            return false
        },
        isCompletionOpen: function () {
            return completion.open
        },
        isComposing: function () {
            return composing
        },
        wordAtCaret: wordAtCaret,
        goToDefinition: triggerDefinition,
        openCompletion: function () {
            return openCompletion(true)
        }
    }
}
`
