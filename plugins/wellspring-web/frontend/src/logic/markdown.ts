// @ts-nocheck
// 从旧客户端 markdown.ts 迁移的 DOM 渲染器；前端由 Vite 构建，仓库根 tsc 不检查前端实现细节。
/* Markdown 渲染（从旧客户端 markdown.ts 迁移；直接构造 DOM 节点，不拼 HTML）。 */
/* ── Markdown 渲染 ─────────────────────────────────────────── */

var MD_BT = String.fromCharCode(96)

function mdEl(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
}

function mdIcon(name) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("class", "icon icon-sm")
    svg.setAttribute("aria-hidden", "true")
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use")
    use.setAttribute("href", "#i-" + name)
    svg.appendChild(use)
    return svg
}

var MD_COPY_RESET_MS = 2500

/** 代码块「复制」：成功后换成对勾，2.5 秒自己淡回去 */
function mdCopy(button, text) {
    var restore = function () {
        button.removeAttribute("data-copied")
        var label = button.querySelector("span")
        if (label) label.textContent = "复制"
        var use = button.querySelector("use")
        if (use) use.setAttribute("href", "#i-copy")
    }
    var done = function () {
        button.setAttribute("data-copied", "true")
        var label = button.querySelector("span")
        if (label) label.textContent = "已复制"
        var use = button.querySelector("use")
        if (use) use.setAttribute("href", "#i-check")
        window.clearTimeout(button.__copyTimer)
        button.__copyTimer = window.setTimeout(restore, MD_COPY_RESET_MS)
    }
    var fallback = function () {
        var area = document.createElement("textarea")
        area.value = text
        area.style.position = "fixed"
        area.style.opacity = "0"
        document.body.appendChild(area)
        area.select()
        try {
            document.execCommand("copy")
            done()
        } finally {
            area.remove()
        }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback)
        return
    }
    fallback()
}

function mdSafeUrl(raw) {
    var url = String(raw == null ? "" : raw).trim()
    if (url === "" || url.length > 2048) return null
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return null
    return url
}

function mdAppendText(parent, text) {
    var parts = String(text).split("\n")
    for (var i = 0; i < parts.length; i += 1) {
        if (i > 0) parent.appendChild(document.createElement("br"))
        if (parts[i] !== "") parent.appendChild(document.createTextNode(parts[i]))
    }
}

var MD_INLINE_SOURCE =
    "([" + MD_BT + "]+)([\\s\\S]{0,4000}?)\\1" +
    "|\\*\\*([\\s\\S]{1,4000}?)\\*\\*" +
    "|(?<![\\w])__([\\s\\S]{1,1000}?)__(?![\\w])" +
    "|(?<![\\w])\\*([^*\\n]{1,1000}?)\\*(?![\\w])" +
    "|(?<![\\w])_([^_\\n]{1,1000}?)_(?![\\w])" +
    "|~~([^~\\n]{1,1000}?)~~" +
    "|\\[([^\\]\\n]{1,300})\\]\\(([^)\\s]{1,2048})\\)" +
    "|(https?:\\/\\/[^\\s<>()]{1,2048}[^\\s<>().,;:!?])"

function mdAppendInline(parent, text, depth, inLink) {
    var level = typeof depth === "number" ? depth : 0
    var linked = inLink === true
    var value = String(text == null ? "" : text)
    if (level > 8) {
        mdAppendText(parent, value)
        return
    }
    var re = new RegExp(MD_INLINE_SOURCE, "g")
    var index = 0
    var match
    while ((match = re.exec(value)) !== null) {
        if (match.index > index) mdAppendText(parent, value.slice(index, match.index))
        if (match[1] !== undefined) {
            parent.appendChild(mdEl("code", null, match[2]))
        } else if (match[3] !== undefined) {
            var strong = mdEl("strong")
            mdAppendInline(strong, match[3], level + 1, linked)
            parent.appendChild(strong)
        } else if (match[4] !== undefined) {
            var strong2 = mdEl("strong")
            mdAppendInline(strong2, match[4], level + 1, linked)
            parent.appendChild(strong2)
        } else if (match[5] !== undefined) {
            var em = mdEl("em")
            mdAppendInline(em, match[5], level + 1, linked)
            parent.appendChild(em)
        } else if (match[6] !== undefined) {
            var em2 = mdEl("em")
            mdAppendInline(em2, match[6], level + 1, linked)
            parent.appendChild(em2)
        } else if (match[7] !== undefined) {
            parent.appendChild(mdEl("del", null, match[7]))
        } else if (match[8] !== undefined) {
            var url = mdSafeUrl(match[9])
            if (url === null || linked) {
                mdAppendText(parent, match[0])
            } else {
                var link = mdEl("a")
                link.href = url
                link.target = "_blank"
                link.rel = "noopener noreferrer"
                mdAppendInline(link, match[8], level + 1, true)
                parent.appendChild(link)
            }
        } else if (match[10] !== undefined) {
            var autoUrl = mdSafeUrl(match[10])
            if (autoUrl === null || linked) {
                mdAppendText(parent, match[10])
            } else {
                var autoLink = mdEl("a", null, match[10])
                autoLink.href = autoUrl
                autoLink.target = "_blank"
                autoLink.rel = "noopener noreferrer"
                parent.appendChild(autoLink)
            }
        }
        index = re.lastIndex
    }
    if (index < value.length) mdAppendText(parent, value.slice(index))
}

function mdHeading(level, text) {
    var tag = level <= 1 ? "h2" : level === 2 ? "h3" : level === 3 ? "h4" : "h5"
    var node = mdEl(tag)
    mdAppendInline(node, text)
    return node
}

function mdIsHorizontalRule(line) {
    return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
}

/* 返回围栏信息；不合法的围栏返回 null */
function mdFenceInfo(line) {
    var lead = line.length - line.replace(/^\s{0,3}/, "").length
    if (lead > 3) return null
    var trimmed = line.slice(lead)
    var first = trimmed.charAt(0)
    if (first !== MD_BT && first !== "~") return null
    var count = 0
    while (count < trimmed.length && trimmed.charAt(count) === first) count += 1
    if (count < 3) return null
    var rest = trimmed.slice(count)
    if (rest.indexOf(MD_BT) !== -1) return null
    return { marker: first, length: count, info: rest.replace(/\s+$/, "") }
}

function mdIsFenceClose(line, fence) {
    var trimmed = line.replace(/^\s+/, "").replace(/\s+$/, "")
    if (trimmed.length < fence.length) return false
    for (var i = 0; i < trimmed.length; i += 1) {
        if (trimmed.charAt(i) !== fence.marker) return false
    }
    return true
}

function mdCodeBlock(lines, start, fence) {
    var body = []
    var index = start + 1
    while (index < lines.length) {
        if (mdIsFenceClose(lines[index], fence)) {
            index += 1
            break
        }
        body.push(lines[index])
        index += 1
    }
    var language = String(fence.info || "").replace(/[^A-Za-z0-9#+._-]/g, "").slice(0, 20)
    var wrap = mdEl("div", "code-block")
    var head = mdEl("div", "code-head")
    head.appendChild(mdEl("span", null, language === "" ? "text" : language))
    var button = mdEl("button", "code-copy")
    button.type = "button"
    button.setAttribute("aria-label", "复制代码")
    button.appendChild(mdIcon("copy"))
    button.appendChild(mdEl("span", null, "复制"))
    var code = mdEl("code", null, body.join("\n"))
    button.addEventListener("click", function () {
        mdCopy(button, code.textContent || "")
    })
    head.appendChild(button)
    var pre = mdEl("pre")
    pre.appendChild(code)
    wrap.appendChild(head)
    wrap.appendChild(pre)
    return { node: wrap, next: index }
}

function mdBlockquote(lines, start, depth) {
    var collected = []
    var index = start
    while (index < lines.length) {
        var match = /^\s{0,3}>\s?(.*)$/.exec(lines[index])
        if (match === null) break
        collected.push(match[1])
        index += 1
    }
    var node = mdEl("blockquote")
    var content = collected.join("\n")
    var frag
    if (depth >= 5) {
        frag = document.createDocumentFragment()
        var paragraph = mdEl("p")
        mdAppendText(paragraph, content)
        frag.appendChild(paragraph)
    } else {
        frag = mdRender(content, depth + 1)
    }
    while (frag.firstChild !== null) node.appendChild(frag.firstChild)
    return { node: node, next: index }
}

function mdListMatch(line) {
    return /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
}

function mdTaskText(raw) {
    var task = /^\[([ xX])\]\s+(.*)$/.exec(raw)
    if (task === null) return null
    return { checked: task[1] !== " ", text: task[2] }
}

function mdList(lines, start, baseIndent, level) {
    var first = mdListMatch(lines[start])
    var ordered = first !== null && /^\d/.test(first[2])
    var list = mdEl(ordered ? "ol" : "ul")
    var index = start
    var current = null
    while (index < lines.length) {
        var match = mdListMatch(lines[index])
        if (match === null) {
            if (current !== null && lines[index].trim() !== "" && /^\s{2,}/.test(lines[index])) {
                mdAppendInline(current, " " + lines[index].trim())
                index += 1
                continue
            }
            break
        }
        var indent = match[1].length
        var isOrdered = /^\d/.test(match[2])
        if (indent < baseIndent) break
        if (indent > baseIndent) {
            if (current === null) break
            if (level >= 5) {
                mdAppendInline(current, " " + match[3])
                index += 1
                continue
            }
            var sub = mdList(lines, index, indent, level + 1)
            current.appendChild(sub.node)
            index = sub.next
            continue
        }
        if (isOrdered !== ordered) break
        var item = mdEl("li")
        var task = mdTaskText(match[3])
        if (task === null) {
            mdAppendInline(item, match[3])
        } else {
            var label = mdEl("label", "task")
            var box = document.createElement("input")
            box.type = "checkbox"
            box.disabled = true
            box.checked = task.checked
            label.appendChild(box)
            var span = mdEl("span")
            mdAppendInline(span, task.text)
            label.appendChild(span)
            item.appendChild(label)
        }
        list.appendChild(item)
        current = item
        index += 1
    }
    return { node: list, next: index }
}

function mdIsTableStart(lines, index) {
    if (index + 1 >= lines.length) return false
    if (lines[index].indexOf("|") === -1) return false
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[index + 1])
}

function mdSplitRow(line) {
    var value = line.trim()
    if (value.charAt(0) === "|") value = value.slice(1)
    if (value.charAt(value.length - 1) === "|") value = value.slice(0, -1)
    return value.split("|").map(function (cell) {
        return cell.trim()
    })
}

function mdTable(lines, start) {
    var headCells = mdSplitRow(lines[start])
    var wrap = mdEl("div", "table-wrap")
    var table = mdEl("table")
    var thead = document.createElement("thead")
    var headRow = document.createElement("tr")
    for (var i = 0; i < headCells.length; i += 1) {
        var th = mdEl("th")
        mdAppendInline(th, headCells[i])
        headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)
    var tbody = document.createElement("tbody")
    var index = start + 2
    while (index < lines.length && lines[index].indexOf("|") !== -1 && lines[index].trim() !== "") {
        var cells = mdSplitRow(lines[index])
        var row = document.createElement("tr")
        for (var j = 0; j < headCells.length; j += 1) {
            var td = mdEl("td")
            mdAppendInline(td, cells[j] === undefined ? "" : cells[j])
            row.appendChild(td)
        }
        tbody.appendChild(row)
        index += 1
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    return { node: wrap, next: index }
}

function mdIsBlockStart(lines, index) {
    var line = lines[index]
    if (line.trim() === "") return true
    if (mdFenceInfo(line) !== null) return true
    if (/^\s{0,3}#{1,6}\s+/.test(line)) return true
    if (mdIsHorizontalRule(line)) return true
    if (/^\s{0,3}>/.test(line)) return true
    if (mdListMatch(line) !== null) return true
    return mdIsTableStart(lines, index)
}

function mdParagraph(lines, start) {
    var collected = []
    var index = start
    while (index < lines.length && !mdIsBlockStart(lines, index)) {
        collected.push(lines[index])
        index += 1
    }
    var node = mdEl("p")
    mdAppendInline(node, collected.join("\n"))
    return { node: node, next: index === start ? start + 1 : index }
}

export function mdRender(text, depth) {
    var level = typeof depth === "number" ? depth : 0
    var frag = document.createDocumentFragment()
    var lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n")
    var index = 0
    while (index < lines.length) {
        var line = lines[index]
        if (line.trim() === "") {
            index += 1
            continue
        }
        var fence = mdFenceInfo(line)
        if (fence !== null) {
            var code = mdCodeBlock(lines, index, fence)
            frag.appendChild(code.node)
            index = code.next
            continue
        }
        var heading = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(line)
        if (heading !== null) {
            frag.appendChild(mdHeading(heading[1].length, heading[2]))
            index += 1
            continue
        }
        if (mdIsHorizontalRule(line)) {
            frag.appendChild(document.createElement("hr"))
            index += 1
            continue
        }
        if (/^\s{0,3}>/.test(line)) {
            var quote = mdBlockquote(lines, index, level)
            frag.appendChild(quote.node)
            index = quote.next
            continue
        }
        var listMatch = mdListMatch(line)
        if (listMatch !== null) {
            var list = mdList(lines, index, listMatch[1].length, level)
            frag.appendChild(list.node)
            index = list.next
            continue
        }
        if (mdIsTableStart(lines, index)) {
            var table = mdTable(lines, index)
            frag.appendChild(table.node)
            index = table.next
            continue
        }
        var paragraph = mdParagraph(lines, index)
        frag.appendChild(paragraph.node)
        index = paragraph.next
    }
    return frag
}
