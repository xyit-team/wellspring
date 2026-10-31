/*
 * 终端屏幕模型与 ANSI 解析，与 highlight / editor / app 拼进同一个 IIFE。
 * 约束：String.raw 原始字符串，不能出现反引号和美元花括号插值。
 *
 * 只实现 PTY 输出里真实会出现的控制序列：SGR 颜色/字重、光标移动、
 * 行内与整屏擦除、滚动区域、插入删除行。不做选择区、鼠标上报与 24 位图元。
 */

export const ANSI_JS = String.raw`
/* ── ANSI 常量 ────────────────────────────────────────────── */

var ESC = "\u001b"
var BEL = "\u0007"
/** 滚动回看上限（行） */
var VT_MAX_BUFFER = 2000

/* ── 屏幕模型 ─────────────────────────────────────────────── */

function vtBlankCell() {
    return { ch: " ", s: null, w: 1 }
}

/**
 * 字符占几格：CJK / 假名 / 韩文 / 全角符号 / 常见 emoji 占两格。
 * 不处理的话含中文的提示符会让光标比文字偏左，块光标压住字符。
 */
function vtCharWidth(ch) {
    var code = ch.codePointAt ? ch.codePointAt(0) : ch.charCodeAt(0)
    if (code < 0x1100) return 1
    if (
        code <= 0x115f ||
        (code >= 0x2e80 && code <= 0x303e) ||
        (code >= 0x3041 && code <= 0x33ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xa000 && code <= 0xa4cf) ||
        (code >= 0xa960 && code <= 0xa97f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f000 && code <= 0x1faff) ||
        (code >= 0x20000 && code <= 0x3fffd)
    ) {
        return 2
    }
    return 1
}

function vtCloneStyle(style) {
    if (style === null) return null
    return {
        fg: style.fg,
        bg: style.bg,
        bold: style.bold,
        dim: style.dim,
        italic: style.italic,
        underline: style.underline,
        inverse: style.inverse
    }
}

function vtStyleKey(style) {
    if (style === null) return ""
    return [style.fg === null ? "" : style.fg, style.bg === null ? "" : style.bg,
        style.bold ? 1 : 0, style.dim ? 1 : 0, style.italic ? 1 : 0,
        style.underline ? 1 : 0, style.inverse ? 1 : 0].join("|")
}

/** 256 色表：0-15 走主题变量，其余按 xterm 规则算 */
function vtColor(index) {
    if (index < 16) return null
    if (index >= 232) {
        var level = 8 + (index - 232) * 10
        return "rgb(" + level + "," + level + "," + level + ")"
    }
    var n = index - 16
    var steps = [0, 95, 135, 175, 215, 255]
    var r = steps[Math.floor(n / 36) % 6]
    var g = steps[Math.floor(n / 6) % 6]
    var b = steps[n % 6]
    return "rgb(" + r + "," + g + "," + b + ")"
}

function createVtScreen(options) {
    var cols = Math.max(20, options.cols || 100)
    var rows = Math.max(6, options.rows || 28)

    var buffer = []
    var cursor = { x: 0, y: 0 }
    var style = null
    var dirty = {}
    var pending = ""
    var viewTop = 0
    var follow = true
    var scrollTop = 0
    var scrollBottom = rows - 1
    var cursorVisible = true

    var nodes = []
    var shownFirst = -1
    var container = null

    function ensureRow(index) {
        while (buffer.length <= index) {
            var row = { cells: [], v: 0 }
            buffer.push(row)
        }
        return buffer[index]
    }

    function trimBuffer() {
        var limit = VT_MAX_BUFFER + rows
        if (buffer.length <= limit) return
        var drop = buffer.length - limit
        buffer.splice(0, drop)
        cursor.y = Math.max(0, cursor.y - drop)
        viewTop = Math.max(0, viewTop - drop)
        shownFirst = -1
    }

    function touch(index) {
        dirty[index] = true
        var row = buffer[index]
        if (row !== undefined) row.v += 1
    }

    /** 清掉某格；它属于宽字符时把另一半也清掉，避免留下半个字 */
    function blankCellAt(row, index) {
        if (index < 0 || index >= cols || row.cells[index] === undefined) return
        var cell = row.cells[index]
        row.cells[index] = vtBlankCell()
        if (cell.w === 2 && index + 1 < cols) {
            row.cells[index + 1] = vtBlankCell()
        } else if (cell.w === 0 && index > 0) {
            row.cells[index - 1] = vtBlankCell()
        }
    }

    function putChar(ch) {
        var width = vtCharWidth(ch)
        var row = ensureRow(cursor.y)
        while (row.cells.length < cols) row.cells.push(vtBlankCell())
        if (cursor.x + width > cols) {
            cursor.x = 0
            lineFeed()
            row = ensureRow(cursor.y)
            while (row.cells.length < cols) row.cells.push(vtBlankCell())
        }
        blankCellAt(row, cursor.x)
        if (width === 2) blankCellAt(row, cursor.x + 1)
        var cellStyle = vtCloneStyle(style)
        row.cells[cursor.x] = { ch: ch, s: cellStyle, w: width }
        if (width === 2) {
            row.cells[cursor.x + 1] = { ch: "", s: cellStyle, w: 0 }
        }
        cursor.x += width
        touch(cursor.y)
    }

    /* 缓冲只增不减：光标下移一行、视口跟着走，滚出屏外的行留在缓冲里供回看。
       这样 shell 场景的 scrollback 才是完整的；滚动区域（CSI r）只用来夹光标。 */
    function lineFeed() {
        cursor.y += 1
        ensureRow(cursor.y)
        if (follow) viewTop = Math.max(0, cursor.y - rows + 1)
    }

    function eraseLine(mode) {
        var row = ensureRow(cursor.y)
        while (row.cells.length < cols) row.cells.push(vtBlankCell())
        var from = 0
        var to = cols - 1
        if (mode === 0) from = cursor.x
        else if (mode === 1) to = cursor.x
        for (var index = from; index <= to; index += 1) {
            if (index >= 0 && index < cols) row.cells[index] = vtBlankCell()
        }
        // 擦除边界切断宽字符时，把另一半也擦掉
        if (from > 0 && row.cells[from - 1] !== undefined && row.cells[from - 1].w === 2) {
            row.cells[from - 1] = vtBlankCell()
        }
        if (to + 1 < row.cells.length && row.cells[to + 1] !== undefined && row.cells[to + 1].w === 0) {
            row.cells[to + 1] = vtBlankCell()
        }
        touch(cursor.y)
    }

    function eraseDisplay(mode) {
        if (mode === 2 || mode === 3) {
            buffer.length = 0
            cursor.x = 0
            cursor.y = 0
            viewTop = 0
            shownFirst = -1
            dirty = {}
            ensureRow(0)
            return
        }
        if (mode === 0) {
            eraseLine(0)
            for (var index = cursor.y + 1; index < buffer.length; index += 1) {
                buffer[index] = { cells: [], v: 0 }
                touch(index)
            }
            return
        }
        eraseLine(1)
        for (var above = 0; above < cursor.y; above += 1) {
            buffer[above] = { cells: [], v: 0 }
            touch(above)
        }
    }

    function sgr(params) {
        if (params.length === 0) {
            style = null
            return
        }
        if (style === null) {
            style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false }
        }
        for (var index = 0; index < params.length; index += 1) {
            var code = params[index]
            if (code === 0) {
                style = null
                style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false }
            } else if (code === 1) style.bold = true
            else if (code === 2) style.dim = true
            else if (code === 3) style.italic = true
            else if (code === 4) style.underline = true
            else if (code === 7) style.inverse = true
            else if (code === 22) { style.bold = false; style.dim = false }
            else if (code === 23) style.italic = false
            else if (code === 24) style.underline = false
            else if (code === 27) style.inverse = false
            else if (code >= 30 && code <= 37) style.fg = code - 30
            else if (code === 39) style.fg = null
            else if (code >= 40 && code <= 47) style.bg = code - 40
            else if (code === 49) style.bg = null
            else if (code >= 90 && code <= 97) style.fg = code - 90 + 8
            else if (code >= 100 && code <= 107) style.bg = code - 100 + 8
            else if (code === 38 || code === 48) {
                var target = code === 38 ? "fg" : "bg"
                if (params[index + 1] === 5) {
                    style[target] = params[index + 2]
                    index += 2
                } else if (params[index + 1] === 2) {
                    var r = params[index + 2] || 0
                    var g = params[index + 3] || 0
                    var b = params[index + 4] || 0
                    style[target] = "#" + [r, g, b].map(function (value) {
                        var hex = Math.max(0, Math.min(255, value)).toString(16)
                        return hex.length === 1 ? "0" + hex : hex
                    }).join("")
                    index += 4
                }
            }
        }
    }

    function csi(final, params) {
        var first = params.length > 0 ? params[0] : 0
        switch (final) {
            case "m":
                sgr(params)
                return
            case "A":
                cursor.y = Math.max(scrollTop, cursor.y - Math.max(1, first))
                return
            case "B":
                cursor.y = Math.min(scrollBottom, cursor.y + Math.max(1, first))
                return
            case "C":
                cursor.x = Math.min(cols - 1, cursor.x + Math.max(1, first))
                return
            case "D":
                cursor.x = Math.max(0, cursor.x - Math.max(1, first))
                return
            case "E":
                cursor.x = 0
                cursor.y = Math.min(scrollBottom, cursor.y + Math.max(1, first))
                return
            case "F":
                cursor.x = 0
                cursor.y = Math.max(scrollTop, cursor.y - Math.max(1, first))
                return
            case "G":
                cursor.x = Math.max(0, Math.min(cols - 1, Math.max(1, first) - 1))
                return
            case "H":
            case "f": {
                var row = params.length > 0 ? params[0] : 1
                var col = params.length > 1 ? params[1] : 1
                cursor.y = Math.max(scrollTop, Math.min(scrollBottom, Math.max(1, row) - 1 + scrollTop))
                cursor.x = Math.max(0, Math.min(cols - 1, Math.max(1, col) - 1))
                ensureRow(cursor.y)
                return
            }
            case "J":
                eraseDisplay(first)
                return
            case "K":
                eraseLine(first)
                return
            case "L":
            case "M": {
                var count = Math.max(1, first)
                for (var step = 0; step < count; step += 1) {
                    if (final === "L") buffer.splice(cursor.y, 0, { cells: [], v: 0 })
                    else if (cursor.y < buffer.length) buffer.splice(cursor.y, 1)
                }
                shownFirst = -1
                return
            }
            case "P": {
                var row2 = ensureRow(cursor.y)
                row2.cells.splice(cursor.x, Math.max(1, first))
                touch(cursor.y)
                return
            }
            case "@": {
                var row3 = ensureRow(cursor.y)
                for (var ins = 0; ins < Math.max(1, first); ins += 1) {
                    row3.cells.splice(cursor.x, 0, vtBlankCell())
                }
                touch(cursor.y)
                return
            }
            case "r": {
                var top = params.length > 0 ? Math.max(1, params[0]) : 1
                var bottom = params.length > 1 ? params[1] : rows
                scrollTop = top - 1
                scrollBottom = Math.max(scrollTop, Math.min(rows, bottom) - 1)
                cursor.x = 0
                cursor.y = scrollTop
                ensureRow(cursor.y)
                return
            }
            case "h":
            case "l":
                if (params.length > 0 && params[0] === 25) cursorVisible = final === "h"
                return
            default:
                return
        }
    }

    /** 解析一段 PTY 输出；跨块被截断的转义序列留到下次 */
    function write(chunk) {
        var text = pending + chunk
        pending = ""
        var index = 0
        while (index < text.length) {
            var ch = text.charAt(index)
            if (ch === ESC) {
                var next = text.charAt(index + 1)
                if (next === "[") {
                    var end = index + 2
                    while (end < text.length) {
                        var code = text.charCodeAt(end)
                        if (code >= 0x40 && code <= 0x7e) break
                        end += 1
                    }
                    if (end >= text.length) {
                        pending = text.slice(index)
                        return
                    }
                    var body = text.slice(index + 2, end)
                    var params = body.replace(/^[?<=>!]+/, "").split(";").map(function (item) {
                        var value = parseInt(item, 10)
                        return isNaN(value) ? 0 : value
                    })
                    csi(text.charAt(end), params)
                    index = end + 1
                    continue
                }
                if (next === "]") {
                    var stop = index + 2
                    while (stop < text.length && text.charAt(stop) !== BEL && text.charAt(stop) !== ESC) stop += 1
                    if (stop >= text.length) {
                        pending = text.slice(index)
                        return
                    }
                    index = text.charAt(stop) === BEL ? stop + 1 : stop + 2
                    continue
                }
                if (next === "(" || next === ")" || next === "#") {
                    index += 3
                    continue
                }
                index += 2
                continue
            }
            if (ch === "\r") {
                cursor.x = 0
                index += 1
                continue
            }
            if (ch === "\n" || ch === "\u000b" || ch === "\u000c") {
                lineFeed()
                index += 1
                continue
            }
            if (ch === "\b") {
                cursor.x = Math.max(0, cursor.x - 1)
                index += 1
                continue
            }
            if (ch === "\t") {
                var nextTab = Math.min(cols - 1, (Math.floor(cursor.x / 8) + 1) * 8)
                while (cursor.x < nextTab) putChar(" ")
                index += 1
                continue
            }
            if (ch === BEL || ch === "\u0000") {
                index += 1
                continue
            }
            var lead = ch.charCodeAt(0)
            if (lead >= 0xd800 && lead <= 0xdbff && index + 1 < text.length) {
                var trail = text.charCodeAt(index + 1)
                if (trail >= 0xdc00 && trail <= 0xdfff) {
                    putChar(ch + text.charAt(index + 1))
                    index += 2
                    continue
                }
            }
            putChar(ch)
            index += 1
        }
        trimBuffer()
    }

    /* ── 渲染 ─────────────────────────────────────────────── */

    function styleCell(node, cell) {
        var style = cell.s
        if (style === null) return
        if (style.bold) node.className += " vt-bold"
        if (style.dim) node.className += " vt-dim"
        if (style.italic) node.className += " vt-italic"
        if (style.underline) node.className += " vt-underline"
        if (style.inverse) node.className += " vt-inverse"
        applyColor(node, style.fg, "color")
        applyColor(node, style.bg, "background-color")
    }

    function applyColor(node, value, property) {
        if (value === null || value === undefined) return
        if (typeof value === "number" && value < 16) {
            node.className += property === "color" ? " vt-fg-" + value : " vt-bg-" + value
            return
        }
        var hex = typeof value === "number" ? vtColor(value) : value
        if (hex === null) return
        node.style[property] = hex
    }

    /** 这一格要不要画：普通空格在行尾可以省掉，但带背景色 / 反色的空格得留着 */
    function cellVisible(cell) {
        if (cell.ch !== " ") return true
        var style = cell.s
        if (style === null || style === undefined) return false
        return (style.bg !== null && style.bg !== undefined) || style.inverse === true
    }

    function renderRow(doc, row) {
        var line = doc.createElement("div")
        line.className = "vt-row"
        var cells = row === undefined ? [] : row.cells
        // 行尾的空格不渲染：否则整行都是可选中区域，复制出来全是尾随空格
        var lastVisible = -1
        for (var index = 0; index < cols; index += 1) {
            var check = index < cells.length ? cells[index] : vtBlankCell()
            if (check.w === 0) continue
            if (cellVisible(check)) lastVisible = index
        }
        var run = null
        var runKey = null
        for (var at = 0; at <= lastVisible; at += 1) {
            var cell = at < cells.length ? cells[at] : vtBlankCell()
            // 宽字符的右半格不单独渲染，宽度由前一个字符自带
            if (cell.w === 0) continue
            var key = vtStyleKey(cell.s)
            if (run === null || key !== runKey) {
                run = doc.createElement("span")
                run.className = "vt-run"
                runKey = key
                styleCell(run, cell)
                line.appendChild(run)
            }
            run.textContent += cell.ch
        }
        return line
    }

    function render(target) {
        if (target !== undefined && target !== null && target !== container) {
            container = target
            container.textContent = ""
            nodes = []
            shownFirst = -1
            dirty = {}
        }
        if (container === null) return
        var doc = container.ownerDocument
        var first = Math.max(0, Math.min(viewTop, Math.max(0, buffer.length - rows)))
        // 容器可能被别的会话渲染过（DOM 被清空/替换）：行节点不在容器里就整屏重建
        var detached = nodes.length === 0 || nodes[0].parentNode !== container
        if (first !== shownFirst || nodes.length !== rows || detached) {
            container.textContent = ""
            nodes = []
            for (var index = 0; index < rows; index += 1) {
                var line = doc.createElement("div")
                line.className = "vt-row"
                container.appendChild(line)
                nodes.push(line)
            }
            shownFirst = first
            for (var row = 0; row < rows; row += 1) dirty[first + row] = true
        }
        for (var slot = 0; slot < rows; slot += 1) {
            var bufferIndex = first + slot
            if (dirty[bufferIndex] !== true) continue
            dirty[bufferIndex] = false
            var fresh = renderRow(doc, buffer[bufferIndex])
            container.replaceChild(fresh, nodes[slot])
            nodes[slot] = fresh
        }
        renderCursor()
    }

    /** 用同字体的隐藏探针量文字的实际宽度；字体回退（CJK）不一定是格宽的整数倍 */
    function vtMeasure(text) {
        if (container === null || text === "") return 0
        var doc = container.ownerDocument
        var probe = doc.createElement("span")
        probe.className = "vt-probe"
        // 固定在左上角，别让探针撑大滚动区域
        probe.style.top = "0"
        probe.style.left = "0"
        probe.textContent = text
        container.appendChild(probe)
        var width = probe.getBoundingClientRect().width
        probe.remove()
        return Math.round(width * 100) / 100
    }

    /** 光标左侧的格子拼成文字；按浏览器真实排版量宽度，光标才压得准 */
    function rowPrefixText(row, count) {
        var text = ""
        var cells = row === undefined ? [] : row.cells
        for (var index = 0; index < count; index += 1) {
            var cell = cells[index]
            text += cell === undefined ? " " : cell.ch
        }
        return text
    }

    function renderCursor() {
        if (container === null) return
        var existing = container.querySelector(".vt-cursor")
        if (existing !== null) existing.remove()
        if (!cursorVisible || !follow) return
        var slot = cursor.y - shownFirst
        if (slot < 0 || slot >= rows) return
        var doc = container.ownerDocument
        // 终端没聚焦时用空心框，聚焦时才用实心反色块，避免看起来像一直有输入焦点
        var idle = container.classList.contains("is-idle")
        var row = buffer[cursor.y]
        var cell = row === undefined ? undefined : row.cells[cursor.x]
        var wide = cell !== undefined && cell !== null && cell.w === 2
        var node = doc.createElement("span")
        node.className = (idle ? "vt-cursor is-idle" : "vt-cursor") + (wide ? " is-wide" : "")
        node.style.top = "calc(var(--terminal-pad-y) + var(--vt-row-height) * " + slot + ")"
        node.style.left = "calc(var(--terminal-pad-x) + " + vtMeasure(rowPrefixText(row, cursor.x)) + "px)"
        if (wide) {
            // 宽字符块光标按字形实际宽度画，正好罩住字符
            node.style.width = vtMeasure(cell.ch) + "px"
        }
        if (!idle) {
            // 反色块：把光标位置的字符画在光标里，用终端底色作字色
            var ch = cell === undefined || cell === null || typeof cell.ch !== "string" ? "" : cell.ch
            node.textContent = ch === "" || ch === " " ? "" : ch
        }
        container.appendChild(node)
    }

    return {
        write: write,
        render: render,
        cols: function () { return cols },
        rows: function () { return rows },
        resize: function (nextCols, nextRows) {
            cols = Math.max(20, nextCols)
            rows = Math.max(6, nextRows)
            scrollBottom = rows - 1
            cursor.x = Math.min(cursor.x, cols - 1)
            shownFirst = -1
            dirty = {}
        },
        clear: function () {
            buffer.length = 0
            cursor.x = 0
            cursor.y = 0
            viewTop = 0
            shownFirst = -1
            dirty = {}
            style = null
            pending = ""
            ensureRow(0)
        },
        /** 回看状态：top 是视口顶部在缓冲里的行号，maxTop 为 0 表示没有可回看内容 */
        scrollInfo: function () {
            return {
                top: viewTop,
                maxTop: Math.max(0, buffer.length - rows),
                rows: rows,
                total: buffer.length,
                following: follow
            }
        },
        /** 跳到指定回看位置；到最底部时恢复自动跟随 */
        scrollTo: function (top) {
            var maxTop = Math.max(0, buffer.length - rows)
            var next = Math.max(0, Math.min(maxTop, Math.round(top)))
            viewTop = next
            follow = next >= maxTop
            shownFirst = -1
        },
        /** 回到底部并恢复跟随新输出 */
        scrollToEnd: function () {
            viewTop = Math.max(0, buffer.length - rows)
            follow = true
            shownFirst = -1
        },
        scrollBy: function (delta) {
            follow = false
            viewTop = Math.max(0, Math.min(buffer.length - 1, viewTop + delta))
            var maxTop = Math.max(0, buffer.length - rows)
            if (viewTop >= maxTop) {
                viewTop = maxTop
                follow = true
            }
            shownFirst = -1
        },
        detach: function () {
            container = null
            nodes = []
            shownFirst = -1
        },
        followBottom: function () {
            follow = true
            viewTop = Math.max(0, buffer.length - rows)
            shownFirst = -1
        }
    }
}
`
