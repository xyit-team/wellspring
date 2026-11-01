/*
 * 客户端应用片段，与 highlight / editor 片段拼进同一个 IIFE。
 * 约束：String.raw 原始字符串，不能出现反引号和美元花括号插值。
 */

export const APP_JS = String.raw`
/* ── 常量与状态 ───────────────────────────────────────────── */

var STORE_SETTINGS = "wc.settings.v1"
var STORE_WORKSPACE = "wc.workspace.v1"
var STORE_SESSIONS = "wc.sessions.v1"
var STORE_VIEWS = "wc.views.v1"
var STORE_RECENT = "wc.recent.v2"
var STORE_EXPANDED = "wc.expanded.v2"
var STORE_SIDEBAR = "wc.sidebar.v1"
var MAX_TABS = 40
var MAX_SAVED_VIEWS = 300
var MAX_RECENT = 10
var POLL_INTERVAL = 6000

var DEFAULT_SETTINGS = {
    theme: "system",
    uiFontSize: 1,
    fontSize: 13,
    tabSize: 4,
    minimap: true,
    breadcrumbs: true,
    poll: true,
    terminalHeight: 240
}

/* 终端高度：绝对下限 96px；实际下限按字号保证至少能看见 6 行；上方给编辑器留 200px */
var TERM_MIN_HEIGHT = 96
var TERM_MIN_VISIBLE_ROWS = 6
var TERM_AREA_RESERVED = 200

var app = {
    state: null,
    settings: DEFAULT_SETTINGS,
    tabs: [],
    active: null,
    editor: null,
    readOnly: false,
    view: "explorer",
    sidebarVisible: true,
    workspace: null,
    workspaces: [],
    workspaceError: null,
    hostRoot: "",
    recent: [],
    tree: { children: {}, loaded: {}, expanded: {}, loading: {}, selected: "" },
    pollTimer: null,
    outlineTimer: null,
    diagnosticsTimer: null,
    diagnostics: [],
    diagnosticsSkipReason: "",
    scm: {
        loaded: false,
        loading: false,
        available: true,
        repo: false,
        branch: "",
        ahead: 0,
        behind: 0,
        changes: [],
        truncated: false,
        error: "",
        seq: 0,
        timer: null
    },
    quickTimer: null,
    searchTimer: null,
    quickItems: [],
    quickMode: "files",
    quickSeq: 0,
    paletteItems: [],
    paletteMode: "commands",
    lastFocus: null,
    authConfigured: false
}

/* ── DOM 小工具 ───────────────────────────────────────────── */

function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
}

function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
}

function iconSvg(name, className) {
    return '<svg class="' + (className || "icon") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'
}

function iconNode(name, className) {
    var namespace = "http://www.w3.org/2000/svg"
    var svg = document.createElementNS(namespace, "svg")
    svg.setAttribute("class", className || "icon")
    svg.setAttribute("aria-hidden", "true")
    var use = document.createElementNS(namespace, "use")
    use.setAttribute("href", "#i-" + name)
    svg.appendChild(use)
    return svg
}

function setText(id, value) {
    var node = byId(id)
    if (node !== null) node.textContent = value
}

function enc(value) {
    return encodeURIComponent(value)
}

function basename(path) {
    var slash = path.lastIndexOf("/")
    return slash === -1 ? path : path.slice(slash + 1)
}

function dirname(path) {
    var slash = path.lastIndexOf("/")
    return slash === -1 ? "" : path.slice(0, slash)
}

function joinPath(parent, name) {
    if (parent === "") return name
    return parent + "/" + name
}

function formatBytes(bytes) {
    if (typeof bytes !== "number" || bytes < 0) return "—"
    if (bytes < 1024) return bytes + " B"
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB"
    return (bytes / 1024 / 1024).toFixed(1) + " MiB"
}

function loadJson(key, fallback) {
    try {
        var raw = window.localStorage.getItem(key)
        if (raw === null) return fallback
        return JSON.parse(raw)
    } catch (error) {
        return fallback
    }
}

function saveJson(key, value) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
        /* 隐私模式或配额不足时忽略 */
    }
}

/* ── HTTP ─────────────────────────────────────────────────── */

function requestHeaders(withJson) {
    var headers = withJson
        ? { "content-type": "application/json", accept: "application/json" }
        : { accept: "application/json" }
    if (app.workspace !== null && app.workspace.id !== "") {
        headers["x-workspace-id"] = app.workspace.id
    }
    return headers
}

function apiGet(path) {
    return fetch(path, { headers: requestHeaders(false) }).then(parseApiResponse)
}

function apiSend(path, method, body) {
    return fetch(path, {
        method: method,
        headers: requestHeaders(true),
        body: JSON.stringify(body)
    }).then(parseApiResponse)
}

function parseApiResponse(response) {
    return response
        .json()
        .catch(function () {
            return {}
        })
        .then(function (data) {
            if (response.status === 401) {
                window.location.reload()
            }
            if (!response.ok) {
                var message = data && data.error ? data.error : "请求失败（" + response.status + "）"
                var error = new Error(message)
                error.status = response.status
                error.data = data
                throw error
            }
            return data
        })
}

/* ── 提示与弹窗 ───────────────────────────────────────────── */

function toast(message, tone, options) {
    var container = byId("toasts")
    var node = el("div", "toast toast-" + (tone || "info"))
    var icon = iconNode(tone === "error" ? "error" : tone === "warning" ? "warning" : "check", "icon toast-icon")
    node.appendChild(icon)
    node.appendChild(el("p", "toast-text", message))
    var close = el("button", "toast-close")
    close.type = "button"
    close.setAttribute("aria-label", "关闭提示")
    close.appendChild(iconNode("close", "icon icon-sm"))
    close.addEventListener("click", remove)
    node.appendChild(close)
    container.appendChild(node)
    while (container.children.length > 4) {
        container.removeChild(container.firstChild)
    }
    setTimeout(function () {
        node.classList.add("is-visible")
    }, 10)
    var duration = options && typeof options.duration === "number" ? options.duration : tone === "error" ? 8000 : 4000
    var timer = setTimeout(remove, duration)
    function remove() {
        clearTimeout(timer)
        if (node.parentNode !== null) {
            node.classList.remove("is-visible")
            setTimeout(function () {
                if (node.parentNode !== null) node.parentNode.removeChild(node)
            }, 180)
        }
    }
}

function announce(text) {
    var node = byId("announcer")
    if (node !== null) node.textContent = text
}

function flashStatus(text) {
    var left = document.querySelector(".status-left")
    if (left === null) return
    var flash = byId("status-flash")
    if (flash === null) {
        flash = el("span", "status-flash")
        flash.id = "status-flash"
        left.appendChild(flash)
    }
    flash.textContent = text
    flash.classList.add("is-visible")
    clearTimeout(flash._timer)
    flash._timer = setTimeout(function () {
        flash.classList.remove("is-visible")
    }, 1800)
}

function openModalShell(options) {
    var modal = byId("modal")
    setText("modal-title", options.title || "")
    var body = byId("modal-body")
    clear(body)
    if (options.body) body.appendChild(options.body)
    var actions = byId("modal-actions")
    clear(actions)
    var previous = document.activeElement
    var closed = false
    function close(value) {
        if (closed) return
        closed = true
        modal.hidden = true
        document.removeEventListener("keydown", onKey, true)
        if (previous !== null && typeof previous.focus === "function") {
            try {
                previous.focus()
            } catch (error) {
                /* 元素可能已被移除 */
            }
        }
        if (typeof options.onClose === "function") options.onClose(value)
    }
    var buttons = options.buttons || []
    buttons.forEach(function (button) {
        var node = el("button", "btn" + (button.primary ? " btn-primary" : "") + (button.danger ? " btn-danger" : ""))
        node.type = "button"
        node.textContent = button.label
        node.addEventListener("click", function () {
            if (typeof button.onClick === "function") {
                var keep = button.onClick()
                if (keep === true) return
            }
            close(button.value === undefined ? button.label : button.value)
        })
        actions.appendChild(node)
    })
    function onKey(event) {
        if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            close(null)
        }
    }
    document.addEventListener("keydown", onKey, true)
    modal.hidden = false
    var focusTarget = options.focus || actions.lastChild
    if (focusTarget !== null && focusTarget !== undefined && typeof focusTarget.focus === "function") {
        setTimeout(function () {
            focusTarget.focus()
            if (typeof focusTarget.select === "function") focusTarget.select()
        }, 20)
    }
    return { close: close, body: body }
}

function showPrompt(config) {
    return new Promise(function (resolve) {
        var wrap = el("div", "prompt-form")
        var label = el("label", "prompt-label", config.label || "名称")
        var input = el("input", "input")
        input.type = "text"
        input.value = config.value || ""
        input.placeholder = config.placeholder || ""
        input.setAttribute("aria-label", config.label || "名称")
        input.spellcheck = false
        var error = el("p", "field-error")
        error.hidden = true
        wrap.appendChild(label)
        wrap.appendChild(input)
        wrap.appendChild(error)
        label.htmlFor = "modal-prompt-input"
        input.id = "modal-prompt-input"
        var shell = openModalShell({
            title: config.title,
            body: wrap,
            buttons: [
                { label: "取消", value: null },
                {
                    label: config.confirmLabel || "确定",
                    primary: true,
                    value: "confirm",
                    onClick: function () {
                        var value = input.value.trim()
                        if (value === "") {
                            error.textContent = "名称不能为空"
                            error.hidden = false
                            input.focus()
                            return true
                        }
                        resolve(value)
                        return false
                    }
                }
            ],
            focus: input,
            onClose: function (value) {
                if (value !== "confirm") resolve(null)
            }
        })
        input.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                event.preventDefault()
                var value = input.value.trim()
                if (value === "") {
                    error.textContent = "名称不能为空"
                    error.hidden = false
                    return
                }
                shell.close("confirm")
                resolve(value)
            }
        })
    })
}

function showConfirm(title, message, confirmLabel, danger) {
    return new Promise(function (resolve) {
        openModalShell({
            title: title,
            body: el("p", "modal-text", message),
            buttons: [
                { label: "取消", value: false },
                { label: confirmLabel || "确定", value: true, primary: danger !== true, danger: danger === true }
            ],
            onClose: function (value) {
                resolve(value === true)
            }
        })
    })
}

/* ── 设置与主题 ───────────────────────────────────────────── */

function loadSettings() {
    var saved = loadJson(STORE_SETTINGS, {})
    var settings = {}
    Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
        settings[key] = Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : DEFAULT_SETTINGS[key]
    })
    var allowedUiSizes = [0.875, 1, 1.125, 1.25]
    settings.uiFontSize = allowedUiSizes.indexOf(Number(settings.uiFontSize)) === -1 ? 1 : Number(settings.uiFontSize)
    settings.fontSize = clampNumber(settings.fontSize, 11, 22, 13)
    settings.tabSize = settings.tabSize === 2 || settings.tabSize === 8 ? settings.tabSize : 4
    settings.terminalHeight = clampNumber(settings.terminalHeight, TERM_MIN_HEIGHT, 1200, 240)
    if (["system", "light", "dark"].indexOf(settings.theme) === -1) settings.theme = "system"
    return settings
}

function clampNumber(value, min, max, fallback) {
    var number = Number(value)
    if (!isFinite(number)) return fallback
    return Math.max(min, Math.min(max, Math.round(number)))
}

function effectiveTheme() {
    if (app.settings.theme === "light") return "light"
    if (app.settings.theme === "dark") return "dark"
    var query = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null
    return query !== null && query.matches ? "light" : "dark"
}

function applySettings() {
    var settings = app.settings
    var root = document.documentElement
    root.setAttribute("data-theme", effectiveTheme())
    root.style.setProperty("--ui-font-size", settings.uiFontSize + "rem")
    root.style.setProperty("--code-size", settings.fontSize + "px")
    root.style.setProperty("--tab-size", String(settings.tabSize))
    setTerminalHeight(settings.terminalHeight, false)
    var breadcrumbs = byId("breadcrumbs")
    if (breadcrumbs !== null) breadcrumbs.hidden = settings.breadcrumbs !== true
    if (app.editor) app.editor.setSettings(settings)
    updateThemeIcons()
    if (settings.poll === true) startPolling()
    else stopPolling()
    // 字号/高度变化后终端的 cols/rows 要重新量
    if (term !== undefined && term.open === true) refitTerminal()
}

function updateThemeIcons() {
    var theme = effectiveTheme()
    var name = theme === "light" ? "moon" : "sun"
    var titlebarIcon = byId("titlebar-theme-icon")
    if (titlebarIcon !== null) titlebarIcon.setAttribute("href", "#i-" + name)
    var statusIcon = byId("status-theme-icon")
    if (statusIcon !== null) statusIcon.setAttribute("href", "#i-" + name)
    var themeSelect = byId("setting-theme")
    if (themeSelect !== null) themeSelect.value = app.settings.theme
    var uiFont = byId("setting-ui-font")
    if (uiFont !== null) uiFont.value = String(app.settings.uiFontSize)
    var fontSize = byId("setting-font-size")
    if (fontSize !== null) fontSize.value = String(app.settings.fontSize)
    var tabSize = byId("setting-tab-size")
    if (tabSize !== null) tabSize.value = String(app.settings.tabSize)
    var minimap = byId("setting-minimap")
    if (minimap !== null) minimap.checked = app.settings.minimap === true
    var breadcrumbs = byId("setting-breadcrumbs")
    if (breadcrumbs !== null) breadcrumbs.checked = app.settings.breadcrumbs === true
    var poll = byId("setting-poll")
    if (poll !== null) poll.checked = app.settings.poll === true
}

function saveSettings() {
    saveJson(STORE_SETTINGS, app.settings)
}

function updateSetting(key, value) {
    app.settings[key] = value
    saveSettings()
    applySettings()
}

function toggleTheme() {
    var current = effectiveTheme()
    updateSetting("theme", current === "light" ? "dark" : "light")
    toast(current === "light" ? "已切换到深色主题" : "已切换到浅色主题", "info", { duration: 2000 })
}

/* ── 工作区状态 ───────────────────────────────────────────── */

function currentWorkspaceId() {
    return app.workspace !== null ? app.workspace.id : "local"
}

function findWorkspaceById(id) {
    for (var index = 0; index < app.workspaces.length; index += 1) {
        if (app.workspaces[index].id === id) return app.workspaces[index]
    }
    return null
}

function applyCatalog(data) {
    if (data === null || typeof data !== "object") return
    if (Array.isArray(data.workspaces)) app.workspaces = data.workspaces
    if (data.active !== null && typeof data.active === "object") app.workspace = data.active
    if (typeof data.hostRoot === "string" && data.hostRoot !== "") app.hostRoot = data.hostRoot
    app.workspaceError = typeof data.error === "string" && data.error !== "" ? data.error : null
}

function applyWorkspaceChrome() {
    var workspace = app.workspace
    var name = workspace !== null ? workspace.name : "工作区"
    var root = workspace !== null ? workspace.root : ""
    setText("workspace-name", name)
    setText("workspace-path", root)
    setText("status-root", root)
    setText("welcome-root", root ? "工作区：" + root : "")
    setText("settings-root", root ? "工作区：" + root : "")
    var statusRoot = byId("status-root")
    if (statusRoot !== null) {
        statusRoot.title = "切换工作区"
    }
    if (workspace !== null) saveJson(STORE_WORKSPACE, { id: workspace.id })
    showDocumentTitle()
}

function refreshWorkspaceState() {
    return apiGet("/api/state").then(function (state) {
        app.state = state
        app.readOnly = state.readOnly === true
        app.hostRoot = typeof state.hostRoot === "string" && state.hostRoot !== "" ? state.hostRoot : app.hostRoot
        setText("branch-name", state.branch || "—")
        var branchStatus = byId("status-branch")
        if (branchStatus !== null) branchStatus.hidden = state.branch === "" || state.branch === undefined
        var readOnly = byId("status-readonly")
        if (readOnly !== null) readOnly.hidden = state.readOnly !== true
        return state
    })
}

function loadWorkspace() {
    return apiGet("/api/workspaces").then(function (catalog) {
        applyCatalog(catalog)
        var saved = loadJson(STORE_WORKSPACE, null)
        var savedId = saved !== null && typeof saved === "object" ? saved.id : null
        var target = typeof savedId === "string" ? findWorkspaceById(savedId) : null
        if (target !== null && target.accessible === true && (app.workspace === null || app.workspace.id !== target.id)) {
            return apiSend("/api/workspace", "POST", { id: target.id }).then(function (data) {
                applyCatalog(data)
                return null
            }).catch(function () {
                return null
            })
        }
        return null
    }).then(function () {
        return refreshWorkspaceState()
    }).then(function () {
        applyWorkspaceChrome()
        restoreExpanded()
        app.recent = loadRecent()
        return loadChildren("")
    }).then(function () {
        renderTree()
        renderWelcomeRecent()
        return true
    })
}

function workspaceCountText() {
    return app.workspaces.length + " 个工作区"
}

/* ── 工作区切换 ───────────────────────────────────────────── */

function closeWorkspacePicker() {
    var overlay = byId("workspace-overlay")
    if (overlay !== null) overlay.hidden = true
}

function renderWorkspacePicker() {
    var list = byId("workspace-list")
    if (list === null) return
    clear(list)
    app.workspaces.forEach(function (workspace) {
        var row = el("button", "palette-item workspace-item")
        row.type = "button"
        row.setAttribute("role", "option")
        row.setAttribute("aria-selected", workspace.active === true ? "true" : "false")
        if (workspace.active === true) row.classList.add("is-current")
        if (workspace.accessible !== true) row.classList.add("is-disabled")
        var icon = el("span", "workspace-item-icon")
        icon.innerHTML = iconSvg(workspace.accessible === true ? "folder" : "warning", "icon icon-sm")
        row.appendChild(icon)
        row.appendChild(el("span", "workspace-item-name", workspace.name || workspace.id))
        if (workspace.conversationCount > 0) {
            row.appendChild(el("span", "workspace-item-count", workspace.conversationCount + " 会话"))
        }
        if (workspace.active === true) {
            row.appendChild(el("span", "workspace-item-current", "当前"))
        }
        row.appendChild(el("span", "workspace-item-path", workspace.root || ""))
        if (workspace.accessible !== true) {
            row.appendChild(el("span", "workspace-item-note", workspace.reason || "当前实例不可访问"))
        }
        row.addEventListener("click", function () {
            requestSwitchWorkspace(workspace)
        })
        list.appendChild(row)
    })
    var foot = [workspaceCountText()]
    if (app.workspaceError !== null) foot.push(app.workspaceError)
    else foot.push("由 code 插件独立管理，可添加任意文件夹")
    foot.push("↑↓ 选择 · Enter 切换 · Esc 关闭")
    setText("workspace-foot", foot.join(" · "))
}

function addWorkspace() {
    var button = byId("workspace-add")
    if (button !== null) button.disabled = true
    if (countDirty() > 0) {
        if (button !== null) button.disabled = false
        toast("请先保存当前工作区的未保存文件", "warning")
        return
    }
    toast("请在系统对话框中选择工作区文件夹…", "info", { duration: 3000 })
    apiSend("/api/workspaces/add", "POST", {})
        .then(function (data) {
            applyCatalog(data)
            applyWorkspaceChrome()
            saveJson(STORE_WORKSPACE, { id: data.active.id })
            resetTreeState()
            restoreExpanded()
            return loadChildren("").then(function () {
                renderTree()
                loadScmStatus(false)
                closeWorkspacePicker()
                toast("已添加工作区 " + (data.active.name || data.active.root), "info")
            })
        })
        .catch(function (error) {
            toast("添加工作区失败：" + error.message, "error", { duration: 8000 })
        })
        .then(function () {
            if (button !== null) button.disabled = false
        })
}

function openWorkspacePicker() {
    var overlay = byId("workspace-overlay")
    if (overlay === null) return
    var show = function () {
        renderWorkspacePicker()
        overlay.hidden = false
        var list = byId("workspace-list")
        setActiveListItem(list, 0)
        var items = list.querySelectorAll(".palette-item")
        if (items.length > 0) items[0].focus()
    }
    apiGet("/api/workspaces").then(function (data) {
        applyCatalog(data)
        applyWorkspaceChrome()
        show()
    }).catch(function (error) {
        toast("读取工作区失败：" + error.message, "error")
    })
}

function closeAllTabsSilently() {
    app.tabs.slice().forEach(function (tab) {
        removeTabObject(tab)
    })
    app.active = null
    app.editor.clear()
    renderTabs()
    showWelcome()
}

function requestSwitchWorkspace(target) {
    if (target === null || target === undefined) return
    if (target.accessible !== true) {
        toast(target.reason || "当前实例无法访问该工作区", "warning")
        return
    }
    if (app.workspace !== null && app.workspace.id === target.id) {
        closeWorkspacePicker()
        return
    }
    var decision = Promise.resolve("discard")
    if (countDirty() > 0) {
        decision = new Promise(function (resolve) {
            openModalShell({
                title: "切换工作区",
                body: el("p", "modal-text", "切换工作区会关闭当前未保存的编辑器。要对这些更改做什么？"),
                buttons: [
                    { label: "保存并切换", value: "save", primary: true },
                    { label: "放弃更改", value: "discard", danger: true },
                    { label: "取消", value: "cancel" }
                ],
                onClose: function (value) {
                    resolve(value === "save" || value === "discard" ? value : null)
                }
            })
        })
    }
    decision.then(function (choice) {
        if (choice === null) return false
        if (choice === "save") return saveAll()
        return true
    }).then(function (ok) {
        if (!ok) return undefined
        saveSession()
        closeAllTabsSilently()
        return apiSend("/api/workspace", "POST", { id: target.id }).then(function (data) {
            applyCatalog(data)
            saveJson(STORE_WORKSPACE, { id: data.active.id })
            return refreshWorkspaceState().then(function () {
                return data
            })
        }).then(function () {
            applyWorkspaceChrome()
            resetTreeState()
            restoreExpanded()
            return loadChildren("")
        }).then(function () {
            renderTree()
            app.recent = loadRecent()
            renderWelcomeRecent()
            closeWorkspacePicker()
            collapseSidebarOnMobile()
            loadScmStatus(false)
            toast("已切换到 " + (app.workspace !== null ? app.workspace.name : target.name), "info")
            return restoreSession()
        }).catch(function (error) {
            toast("切换工作区失败：" + error.message, "error")
            closeWorkspacePicker()
            return false
        })
    }).catch(function (error) {
        toast("切换工作区失败：" + error.message, "error")
    })
}

function resetTreeState() {
    app.tree = { children: {}, loaded: {}, expanded: {}, loading: {}, selected: "" }
}

/* ── 文件树 ───────────────────────────────────────────────── */

function loadChildren(path, force) {
    if (force !== true && app.tree.loaded[path] === true) {
        return Promise.resolve(app.tree.children[path] || [])
    }
    if (app.tree.loading[path] === true) {
        return new Promise(function (resolve) {
            var timer = setInterval(function () {
                if (app.tree.loading[path] !== true) {
                    clearInterval(timer)
                    resolve(app.tree.children[path] || [])
                }
            }, 40)
        })
    }
    app.tree.loading[path] = true
    return apiGet("/api/tree?path=" + enc(path)).then(function (data) {
        app.tree.children[path] = data.entries
        app.tree.loaded[path] = true
        app.tree.loading[path] = false
        return data.entries
    }).catch(function (error) {
        app.tree.loading[path] = false
        throw error
    })
}

function loadExpandedStore() {
    var stored = loadJson(STORE_EXPANDED, null)
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {}
    return stored
}

function saveExpanded() {
    var paths = Object.keys(app.tree.expanded).filter(function (path) {
        return app.tree.expanded[path] === true
    })
    var all = loadExpandedStore()
    all[currentWorkspaceId()] = paths
    saveJson(STORE_EXPANDED, all)
}

function restoreExpanded() {
    var all = loadExpandedStore()
    var paths = all[currentWorkspaceId()]
    if (!Array.isArray(paths)) return
    paths.forEach(function (path) {
        if (typeof path === "string" && path !== "") app.tree.expanded[path] = true
    })
}

function toggleExpand(path) {
    if (app.tree.expanded[path] === true) {
        delete app.tree.expanded[path]
        saveExpanded()
        renderTree()
        return
    }
    app.tree.expanded[path] = true
    saveExpanded()
    renderTree()
    loadChildren(path).then(function () {
        renderTree()
    }).catch(function (error) {
        toast("无法展开目录：" + error.message, "error")
    })
}

function createBadge(entry) {
    var badge = el("span", "file-badge tone-" + (entry.tone || "plain"), entry.badge || "?")
    return badge
}

function createTreeRow(entry, depth) {
    var row = el("div", "tree-row")
    row.dataset.path = entry.path
    row.dataset.type = entry.type
    row.tabIndex = -1
    row.setAttribute("role", "treeitem")
    row.style.paddingLeft = 8 + depth * 14 + "px"
    if (entry.type === "directory") {
        var expanded = app.tree.expanded[entry.path] === true
        row.setAttribute("aria-expanded", expanded ? "true" : "false")
        var chevron = el("span", "tree-chevron")
        chevron.innerHTML = iconSvg(expanded ? "chevron-down" : "chevron-right", "icon icon-xs")
        row.appendChild(chevron)
        var folder = el("span", "tree-icon")
        folder.innerHTML = iconSvg(expanded ? "folder-open" : "folder", "icon icon-sm")
        row.appendChild(folder)
        row.classList.add("is-directory")
    } else {
        row.appendChild(el("span", "tree-chevron"))
        row.appendChild(createBadge(entry))
    }
    var name = el("span", "tree-name", entry.name)
    row.appendChild(name)
    if (entry.type === "file" && isDirtyPath(entry.path)) {
        row.appendChild(el("span", "tree-dirty"))
    }
    if (app.tree.selected === entry.path) row.classList.add("is-selected")
    row.addEventListener("click", function (event) {
        event.stopPropagation()
        selectTreePath(entry.path)
        if (entry.type === "directory") toggleExpand(entry.path)
        else openFile(entry.path)
    })
    row.addEventListener("contextmenu", function (event) {
        event.preventDefault()
        event.stopPropagation()
        selectTreePath(entry.path)
        showTreeMenu(entry, event.clientX, event.clientY)
    })
    return row
}

function selectTreePath(path) {
    app.tree.selected = path
    var rows = document.querySelectorAll(".tree-row")
    for (var index = 0; index < rows.length; index += 1) {
        rows[index].classList.toggle("is-selected", rows[index].dataset.path === path)
    }
}

function appendTreeLevel(container, dirPath, depth) {
    var entries = app.tree.children[dirPath]
    if (entries === undefined) {
        if (app.tree.loading[dirPath] !== true) {
            loadChildren(dirPath).then(function () {
                renderTree()
            }).catch(function () {
                /* 目录可能已被删除 */
            })
        }
        return
    }
    entries.forEach(function (entry) {
        container.appendChild(createTreeRow(entry, depth))
        if (entry.type === "directory" && app.tree.expanded[entry.path] === true) {
            appendTreeLevel(container, entry.path, depth + 1)
        }
    })
}

function renderTree() {
    var container = byId("tree")
    if (container === null) return
    clear(container)
    var fragment = document.createDocumentFragment()
    appendTreeLevel(fragment, "", 0)
    container.appendChild(fragment)
    applyScmDecorations()
}

function reloadTree() {
    app.tree.children = {}
    app.tree.loaded = {}
    app.tree.loading = {}
    return loadChildren("", true).then(function () {
        renderTree()
        return true
    }).catch(function (error) {
        toast("刷新目录失败：" + error.message, "error")
        return false
    })
}

function expandToPath(path, callback) {
    var segments = path.split("/")
    var chain = []
    var current = ""
    for (var index = 0; index < segments.length - 1; index += 1) {
        current = current === "" ? segments[index] : current + "/" + segments[index]
        chain.push(current)
    }
    var sequence = Promise.resolve()
    chain.forEach(function (directory) {
        sequence = sequence.then(function () {
            app.tree.expanded[directory] = true
            return loadChildren(directory)
        })
    })
    return sequence.then(function () {
        saveExpanded()
        renderTree()
        if (typeof callback === "function") setTimeout(callback, 30)
    }).catch(function () {
        renderTree()
        if (typeof callback === "function") callback()
    })
}

function revealInTree(path) {
    var parent = dirname(path)
    var task = parent === "" ? Promise.resolve() : expandToPath(parent)
    return task.then(function () {
        selectTreePath(path)
        var row = document.querySelector('.tree-row[data-path="' + cssEscape(path) + '"]')
        if (row !== null) {
            row.scrollIntoView({ block: "nearest" })
            row.classList.add("is-flash")
            setTimeout(function () {
                row.classList.remove("is-flash")
            }, 900)
        }
        return true
    })
}

function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value)
    return value.replace(/["\\]/g, "\\$&")
}

function showTreeMenu(entry, x, y) {
    var items = []
    if (entry.type === "directory") {
        items.push({ label: "新建文件…", action: function () { newFileIn(entry.path) } })
        items.push({ label: "新建文件夹…", action: function () { newFolderIn(entry.path) } })
        items.push({ separator: true })
    } else {
        items.push({ label: "打开", action: function () { openFile(entry.path) } })
        items.push({ separator: true })
        items.push({ label: "新建文件…", action: function () { newFileIn(dirname(entry.path)) } })
        items.push({ separator: true })
    }
    items.push({ label: "重命名…", action: function () { renameEntry(entry) } })
    items.push({ label: "删除", danger: true, action: function () { deleteEntry(entry) } })
    items.push({ separator: true })
    items.push({ label: "复制相对路径", action: function () { copyText(entry.path) } })
    items.push({ label: "复制绝对路径", action: function () { copyText(absolutePath(entry.path)) } })
    items.push({ label: "在资源管理器中显示", action: function () { revealInTree(entry.path) } })
    showContextMenu(x, y, items)
}

function absolutePath(path) {
    var root = app.state && app.state.root ? app.state.root : ""
    if (root === "") return path
    return root.replace(/\/+$/, "") + "/" + path
}

function copyText(text) {
    var fallback = function () {
        var textarea = el("textarea", "sr-only")
        textarea.value = text
        document.body.appendChild(textarea)
        textarea.select()
        try {
            document.execCommand("copy")
            toast("已复制", "info", { duration: 1600 })
        } catch (error) {
            toast("复制失败", "error")
        }
        document.body.removeChild(textarea)
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(text).then(function () {
            toast("已复制", "info", { duration: 1600 })
        }).catch(fallback)
    } else {
        fallback()
    }
}

function newFileIn(parent) {
    showPrompt({
        title: "新建文件",
        label: "文件名",
        placeholder: parent === "" ? "example.ts" : "example.ts"
    }).then(function (name) {
        if (name === null) return
        var path = joinPath(parent, name.replace(/^\/+/, ""))
        apiSend("/api/file", "POST", { path: path, type: "file" }).then(function () {
            toast("已创建 " + baseName(path), "info")
            scheduleScmRefresh()
            return reloadTree().then(function () {
                return expandToPath(path)
            }).then(function () {
                openFile(path)
            })
        }).catch(function (error) {
            toast("新建文件失败：" + error.message, "error")
        })
    })
}

function newFolderIn(parent) {
    showPrompt({ title: "新建文件夹", label: "文件夹名", placeholder: "components" }).then(function (name) {
        if (name === null) return
        var path = joinPath(parent, name.replace(/^\/+/, ""))
        apiSend("/api/file", "POST", { path: path, type: "directory" }).then(function () {
            toast("已创建 " + baseName(path), "info")
            scheduleScmRefresh()
            app.tree.expanded[path] = true
            saveExpanded()
            return reloadTree().then(function () {
                return revealInTree(path)
            })
        }).catch(function (error) {
            toast("新建文件夹失败：" + error.message, "error")
        })
    })
}

function baseName(path) {
    return basename(path)
}

function renameEntry(entry) {
    showPrompt({ title: "重命名", label: "新名称", value: entry.name }).then(function (name) {
        if (name === null || name === entry.name) return
        var to = joinPath(dirname(entry.path), name)
        apiSend("/api/rename", "POST", { from: entry.path, to: to }).then(function () {
            app.tabs.forEach(function (tab) {
                if (tab.path === entry.path) {
                    tab.path = to
                    tab.name = basename(to)
                } else if (tab.path.indexOf(entry.path + "/") === 0) {
                    tab.path = to + tab.path.slice(entry.path.length)
                }
            })
            if (app.active !== null) {
                app.active.path = app.active.path
                renderTabs()
                renderBreadcrumbs()
            }
            toast("已重命名", "info")
            scheduleScmRefresh()
            return reloadTree().then(function () {
                return revealInTree(to)
            })
        }).catch(function (error) {
            toast("重命名失败：" + error.message, "error")
        })
    })
}

function deleteEntry(entry) {
    showConfirm(
        "删除",
        "确定删除 " + entry.name + "？目录会连同内容一起删除，此操作无法撤销。",
        "删除",
        true
    ).then(function (confirmed) {
        if (!confirmed) return
        fetch("/api/file?path=" + enc(entry.path), { method: "DELETE" }).then(parseApiResponse).then(function () {
            var removed = app.tabs.filter(function (tab) {
                return tab.path === entry.path || tab.path.indexOf(entry.path + "/") === 0
            })
            removed.forEach(function (tab) {
                removeTabObject(tab)
            })
            if (app.active !== null && removed.indexOf(app.active) !== -1) {
                app.active = app.tabs.length > 0 ? app.tabs[app.tabs.length - 1] : null
            }
            if (app.active !== null) {
                activateTab(app.active.path)
            } else {
                showWelcome()
            }
            renderTabs()
            toast("已删除 " + entry.name, "info")
            scheduleScmRefresh()
            reloadTree()
        }).catch(function (error) {
            toast("删除失败：" + error.message, "error")
        })
    })
}

/* ── 编辑器标签页 ─────────────────────────────────────────── */

function findTab(path) {
    for (var index = 0; index < app.tabs.length; index += 1) {
        if (app.tabs[index].path === path) return app.tabs[index]
    }
    return null
}

function isDirtyPath(path) {
    var tab = findTab(path)
    return tab !== null && tab.dirty === true
}

function countDirty() {
    return app.tabs.filter(function (tab) {
        return tab.dirty === true
    }).length
}

function createTab(data) {
    return {
        path: data.path,
        name: data.name || basename(data.path),
        language: data.language || (data.kind ? data.kind.language : "plaintext"),
        label: data.kind ? data.kind.label : "纯文本",
        badge: data.kind ? data.kind.badge : "",
        tone: data.kind ? data.kind.tone : "plain",
        content: data.content === undefined ? "" : data.content,
        savedContent: data.savedContent === undefined ? data.content : data.savedContent,
        mtimeMs: typeof data.mtimeMs === "number" ? data.mtimeMs : 0,
        size: typeof data.size === "number" ? data.size : 0,
        eol: data.eol || "lf",
        indent: data.indent || "",
        binary: data.binary === true,
        previewMode: data.previewMode === true,
        dirty: false,
        conflict: false,
        view: { scrollTop: 0, scrollLeft: 0, selectionStart: 0, selectionEnd: 0 }
    }
}

function addTab(tab) {
    var existing = findTab(tab.path)
    if (existing !== null) {
        return existing
    }
    while (app.tabs.length >= MAX_TABS) {
        var candidate = app.tabs.find(function (item) {
            return item.dirty !== true && item !== app.active
        })
        if (candidate === undefined) break
        removeTabObject(candidate)
    }
    app.tabs.push(tab)
    return tab
}

function removeTabObject(tab) {
    var index = app.tabs.indexOf(tab)
    if (index !== -1) app.tabs.splice(index, 1)
}

function openFile(path, options) {
    options = options || {}
    var existing = findTab(path)
    if (existing !== null) {
        activateTab(path)
        if (typeof options.line === "number") app.editor.revealLine(options.line, options.column)
        collapseSidebarOnMobile()
        return Promise.resolve(existing)
    }
    return apiGet("/api/file?path=" + enc(path)).then(function (data) {
        var tab
        if (data.binary === true) {
            tab = createTab({
                path: data.path,
                name: data.name,
                kind: data.kind,
                mtimeMs: data.mtimeMs,
                size: data.size,
                binary: true,
                previewMode: true
            })
        } else {
            tab = createTab({
                path: data.path,
                name: data.name,
                kind: data.kind,
                content: data.content,
                savedContent: data.content,
                mtimeMs: data.mtimeMs,
                size: data.size,
                eol: data.eol,
                indent: data.indent
            })
        }
        var savedView = savedViewFor(tab.path)
        if (savedView !== null && typeof options.line !== "number") tab.view = savedView
        addTab(tab)
        if (options.activate !== false) {
            activateTab(tab.path)
            if (typeof options.line === "number") app.editor.revealLine(options.line, options.column)
        }
        addRecent(tab)
        saveSession()
        collapseSidebarOnMobile()
        return tab
    }).catch(function (error) {
        if (options.silent !== true) toast("打开文件失败：" + error.message, "error")
        throw error
    })
}

function editorContent() {
    var textarea = byId("code-input")
    if (app.editor !== null && typeof app.editor.getValue === "function") return app.editor.getValue()
    return textarea === null ? "" : textarea.value
}

function editorComposing() {
    return app.editor !== null && typeof app.editor.isComposing === "function" && app.editor.isComposing() === true
}

function captureView() {
    if (app.active === null || app.active.binary === true || app.active.previewMode === true) return
    var textarea = byId("code-input")
    if (textarea === null) return
    app.active.content = editorContent()
    /* IME 组合期间 textarea 只有光标行，滚动/选区不是视口状态，别拿它覆盖已保存的位置 */
    if (editorComposing()) return
    app.active.view = {
        scrollTop: textarea.scrollTop,
        scrollLeft: textarea.scrollLeft,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd
    }
    rememberTabView(app.active)
}

function activateTab(path) {
    var tab = findTab(path)
    if (tab === null) return
    captureView()
    app.active = tab
    renderTabs()
    if (tab.binary === true || tab.previewMode === true) {
        showPreview(tab)
    } else {
        showEditorTab(tab)
    }
    renderBreadcrumbs()
    updateOutline()
    scheduleDiagnostics(true)
    updateStatusForTab(tab)
    saveSession()
    showDocumentTitle()
    editorFocusSoon()
}

function showEditorTab(tab) {
    if (tab.diff === true) {
        showDiffTab(tab)
        return
    }
    var welcome = byId("welcome")
    var editor = byId("editor")
    var preview = byId("preview")
    var diffView = byId("diff-view")
    welcome.hidden = true
    preview.hidden = true
    if (diffView !== null) diffView.hidden = true
    editor.hidden = false
    app.editor.setModel({
        path: tab.path,
        content: tab.content,
        language: tab.language,
        readOnly: app.readOnly === true
    })
    // 会话恢复出来的标签页可能还是默认位置，回退到按 workspace/path 保存的位置
    var view = tab.view
    var atOrigin =
        view === null ||
        view === undefined ||
        ((Number(view.scrollTop) || 0) === 0 &&
            (Number(view.scrollLeft) || 0) === 0 &&
            (Number(view.selectionStart) || 0) === 0)
    if (atOrigin) {
        var saved = savedViewFor(tab.path)
        if (saved !== null) view = saved
    }
    if (view !== null && view !== undefined) tab.view = view
    app.editor.setView(view)
}

function showPreview(tab) {
    var welcome = byId("welcome")
    var editor = byId("editor")
    var preview = byId("preview")
    var diffView = byId("diff-view")
    welcome.hidden = true
    editor.hidden = true
    if (diffView !== null) diffView.hidden = true
    preview.hidden = false
    captureView()
    setText("preview-title", tab.path)
    var body = byId("preview-body")
    clear(body)
    var kind = tab
    if (tab.binary === true) {
        if (tab.language === "image") {
            var image = el("img", "preview-image")
            image.alt = tab.name
            image.src = "/api/raw?path=" + enc(tab.path)
            body.appendChild(image)
            body.appendChild(el("p", "preview-meta", formatBytes(tab.size) + " · " + (tab.label || "图片")))
            image.addEventListener("error", function () {
                clear(body)
                body.appendChild(el("p", "preview-empty", "图片无法显示或已经被删除。"))
            })
        } else {
            body.appendChild(el("p", "preview-empty", "这个二进制文件不能预览。"))
            body.appendChild(el("p", "preview-meta", formatBytes(tab.size) + " · " + (tab.label || "二进制文件")))
        }
    } else if (tab.language === "markdown") {
        var article = el("article", "markdown-body")
        article.innerHTML = renderMarkdownDocument(tab.content)
        body.appendChild(article)
    } else {
        body.appendChild(el("p", "preview-empty", "该文件类型没有预览，关闭预览继续编辑。"))
    }
    updateStatusForTab(tab)
}

function closePreview() {
    if (app.active === null) return
    app.active.previewMode = false
    if (app.active.binary === true) {
        closeTab(app.active.path)
        return
    }
    showEditorTab(app.active)
    renderTabs()
    app.editor.focus()
}

function removeTabFromEditor(tab) {
    if (app.active === tab) {
        var index = app.tabs.indexOf(tab)
        var next = app.tabs[index + 1] || app.tabs[index - 1] || null
        removeTabObject(tab)
        if (next !== null) {
            activateTab(next.path)
        } else {
            app.active = null
            renderTabs()
            showWelcome()
            renderBreadcrumbs()
            updateOutline()
        }
        return true
    }
    removeTabObject(tab)
    return true
}

function closeTab(path) {
    var tab = findTab(path)
    if (tab === null) return Promise.resolve(false)
    if (tab === app.active) captureView()
    if (tab.dirty === true) {
        return new Promise(function (resolve) {
            openModalShell({
                title: "未保存的更改",
                body: el("p", "modal-text", "是否保存对 " + tab.name + " 的更改？"),
                buttons: [
                    { label: "保存", value: "save", primary: true },
                    { label: "不保存", value: "discard" },
                    { label: "取消", value: "cancel" }
                ],
                onClose: function (value) {
                    if (value === "save") {
                        saveTab(tab).then(function (saved) {
                            if (!saved) {
                                resolve(false)
                                return
                            }
                            removeTabFromEditor(tab)
                            saveSession()
                            resolve(true)
                        })
                    } else if (value === "discard") {
                        removeTabFromEditor(tab)
                        saveSession()
                        resolve(true)
                    } else {
                        resolve(false)
                    }
                }
            })
        })
    }
    removeTabFromEditor(tab)
    saveSession()
    return Promise.resolve(true)
}

function closeAllTabs() {
    var paths = app.tabs.map(function (tab) {
        return tab.path
    })
    var sequence = Promise.resolve()
    paths.forEach(function (path) {
        sequence = sequence.then(function () {
            return closeTab(path)
        })
    })
    return sequence
}

function cycleTab(direction) {
    if (app.tabs.length < 2) return
    var index = app.tabs.indexOf(app.active)
    var next = (index + direction + app.tabs.length) % app.tabs.length
    activateTab(app.tabs[next].path)
}

function loadSessionStore() {
    var stored = loadJson(STORE_SESSIONS, null)
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
        return { activeWorkspaceId: null, byWorkspace: {} }
    }
    var byWorkspace = stored.byWorkspace
    if (byWorkspace === null || typeof byWorkspace !== "object" || Array.isArray(byWorkspace)) {
        byWorkspace = {}
    }
    return {
        activeWorkspaceId: typeof stored.activeWorkspaceId === "string" ? stored.activeWorkspaceId : null,
        byWorkspace: byWorkspace
    }
}

function loadSessionFor(id) {
    var store = loadSessionStore()
    var saved = store.byWorkspace[id]
    if (saved === null || typeof saved !== "object" || !Array.isArray(saved.paths)) return null
    return saved
}

function saveSession() {
    var id = currentWorkspaceId()
    var store = loadSessionStore()
    store.activeWorkspaceId = id
    store.byWorkspace[id] = {
        paths: app.tabs
            .filter(function (tab) {
                return tab.diff !== true
            })
            .map(function (tab) {
                return tab.path
            }),
        active: app.active !== null && app.active.diff !== true ? app.active.path : null
    }
    saveJson(STORE_SESSIONS, store)
}

/* ── 文件浏览位置 ─────────────────────────────────────────── */

var viewSaveTimer = null

function loadViewStore() {
    var stored = loadJson(STORE_VIEWS, null)
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {}
    return stored
}

function viewMapFor(workspaceId) {
    var store = loadViewStore()
    var map = store[workspaceId]
    if (map === null || typeof map !== "object" || Array.isArray(map)) map = {}
    return map
}

/** 读取某个文件上次的滚动与光标位置 */
function savedViewFor(path) {
    var map = viewMapFor(currentWorkspaceId())
    var entry = map[path]
    if (entry === null || typeof entry !== "object") return null
    var view = {
        scrollTop: Math.max(0, Number(entry.scrollTop) || 0),
        scrollLeft: Math.max(0, Number(entry.scrollLeft) || 0),
        selectionStart: Math.max(0, Number(entry.selectionStart) || 0),
        selectionEnd: Math.max(0, Number(entry.selectionEnd) || 0)
    }
    if (view.selectionEnd < view.selectionStart) view.selectionEnd = view.selectionStart
    return view
}

/** 把标签页当前位置写入 workspace/path 维度的索引 */
function rememberTabView(tab) {
    if (tab === null || tab.diff === true || tab.binary === true || tab.previewMode === true) return
    if (tab.view === null || typeof tab.view !== "object") return
    var workspaceId = currentWorkspaceId()
    var store = loadViewStore()
    var map = viewMapFor(workspaceId)
    map[tab.path] = {
        scrollTop: Math.max(0, Number(tab.view.scrollTop) || 0),
        scrollLeft: Math.max(0, Number(tab.view.scrollLeft) || 0),
        selectionStart: Math.max(0, Number(tab.view.selectionStart) || 0),
        selectionEnd: Math.max(0, Number(tab.view.selectionEnd) || 0),
        at: Date.now()
    }
    var keys = Object.keys(map)
    if (keys.length > MAX_SAVED_VIEWS) {
        keys.sort(function (left, right) {
            return (Number(map[left].at) || 0) - (Number(map[right].at) || 0)
        })
        keys.slice(0, keys.length - MAX_SAVED_VIEWS).forEach(function (key) {
            delete map[key]
        })
    }
    store[workspaceId] = map
    saveJson(STORE_VIEWS, store)
}

function rememberActiveView() {
    var tab = app.active
    if (tab === null || tab.diff === true || tab.binary === true || tab.previewMode === true) return
    var textarea = byId("code-input")
    if (textarea === null) return
    tab.content = editorContent()
    if (editorComposing()) return
    tab.view = {
        scrollTop: textarea.scrollTop,
        scrollLeft: textarea.scrollLeft,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd
    }
    rememberTabView(tab)
}

function scheduleRememberView() {
    if (viewSaveTimer !== null) return
    viewSaveTimer = setTimeout(function () {
        viewSaveTimer = null
        rememberActiveView()
    }, 400)
}

function restoreSession() {
    var saved = loadSessionFor(currentWorkspaceId())
    if (saved === null || saved.paths.length === 0) {
        showWelcome()
        return Promise.resolve()
    }
    var paths = saved.paths.filter(function (path) {
        return typeof path === "string" && path !== ""
    }).slice(0, 12)
    var sequence = Promise.resolve()
    paths.forEach(function (path) {
        sequence = sequence.then(function () {
            return openFile(path, { activate: false, silent: true }).catch(function () {
                return null
            })
        })
    })
    return sequence.then(function () {
        if (saved.active && findTab(saved.active) !== null) {
            activateTab(saved.active)
        } else if (app.tabs.length > 0) {
            activateTab(app.tabs[0].path)
        } else {
            showWelcome()
        }
        renderWelcomeRecent()
        return true
    })
}

function showWelcome() {
    var welcome = byId("welcome")
    var editor = byId("editor")
    var preview = byId("preview")
    var diffView = byId("diff-view")
    if (welcome === null) return
    welcome.hidden = false
    editor.hidden = true
    preview.hidden = true
    if (diffView !== null) diffView.hidden = true
    app.editor.clear()
    app.active = null
    applyDiagnostics([], "")
    renderTabs()
    renderBreadcrumbs()
    renderWelcomeRecent()
    showDocumentTitle()
    updateCursorStatus({ line: 1, column: 1, selected: 0, lines: 1, characters: 0, readonly: false })
}

function showDocumentTitle() {
    var name = app.active !== null ? app.active.name : ""
    var dirty = app.active !== null && app.active.dirty === true
    document.title = (dirty ? "● " : "") + (name !== "" ? name + " — " : "") + "Wellspring Code"
}

function renderTabs() {
    var bar = byId("tab-bar")
    if (bar === null) return
    clear(bar)
    app.tabs.forEach(function (tab) {
        var node = el("div", "tab")
        node.dataset.path = tab.path
        node.setAttribute("role", "tab")
        node.setAttribute("aria-selected", tab === app.active ? "true" : "false")
        node.tabIndex = tab === app.active ? 0 : -1
        if (tab === app.active) node.classList.add("is-active")
        if (tab.dirty === true) node.classList.add("is-dirty")
        var badge = el("span", "file-badge tone-" + tab.tone, tab.badge || "TXT")
        node.appendChild(badge)
        var name = el("span", "tab-name", tab.name)
        node.appendChild(name)
        if (tab.conflict === true) {
            var conflict = el("span", "tab-conflict")
            conflict.innerHTML = iconSvg("warning", "icon icon-xs")
            conflict.title = "文件已在磁盘上修改"
            node.appendChild(conflict)
        }
        var close = el("span", "tab-close")
        close.setAttribute("role", "button")
        close.setAttribute("aria-label", "关闭 " + tab.name)
        close.innerHTML = iconSvg("close", "icon icon-xs")
        close.addEventListener("click", function (event) {
            event.stopPropagation()
            closeTab(tab.path)
        })
        node.appendChild(close)
        node.addEventListener("click", function () {
            activateTab(tab.path)
        })
        node.addEventListener("auxclick", function (event) {
            if (event.button === 1) {
                event.preventDefault()
                closeTab(tab.path)
            }
        })
        node.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                activateTab(tab.path)
            }
        })
        bar.appendChild(node)
    })
    var activeNode = bar.querySelector(".tab.is-active")
    if (activeNode !== null) activeNode.scrollIntoView({ block: "nearest", inline: "nearest" })
    var badge = byId("explorer-badge")
    var dirty = countDirty()
    if (badge !== null) {
        badge.hidden = dirty === 0
        badge.textContent = String(dirty)
    }
    showDocumentTitle()
}

function renderBreadcrumbs() {
    var container = byId("breadcrumbs")
    if (container === null) return
    clear(container)
    if (app.active === null || app.settings.breadcrumbs !== true) {
        container.hidden = true
        return
    }
    container.hidden = false
    if (app.active.diff === true) {
        var diffLabel = el("span", "crumb is-current", "差异 · " + (app.active.diffPath || ""))
        container.appendChild(diffLabel)
        return
    }
    var segments = app.active.path.split("/")
    var current = ""
    var rootButton = el("button", "crumb crumb-root")
    rootButton.type = "button"
    rootButton.innerHTML = iconSvg("folder", "icon icon-xs")
    rootButton.title = app.state && app.state.name ? app.state.name : "工作区"
    rootButton.addEventListener("click", function () {
        revealInTree("")
    })
    container.appendChild(rootButton)
    segments.forEach(function (segment, index) {
        current = current === "" ? segment : current + "/" + segment
        var last = index === segments.length - 1
        var button = el("button", "crumb" + (last ? " is-current" : ""), segment)
        button.type = "button"
        container.appendChild(button)
        if (!last) {
            var separator = el("span", "crumb-sep")
            separator.innerHTML = iconSvg("chevron-right", "icon icon-xs")
            container.appendChild(separator)
            button.addEventListener("click", function () {
                revealInTree(current)
            })
        }
    })
}

/* ── 保存与冲突 ───────────────────────────────────────────── */

function saveTab(tab) {
    if (tab === null || tab.binary === true || tab.diff === true) return Promise.resolve(false)
    if (app.readOnly === true) {
        toast("插件以只读模式运行，无法保存", "warning")
        return Promise.resolve(false)
    }
    captureView()
    return apiSend("/api/file", "PUT", {
        path: tab.path,
        content: tab.content,
        baseMtimeMs: tab.mtimeMs
    }).then(function (data) {
        tab.savedContent = tab.content
        tab.mtimeMs = data.mtimeMs
        tab.size = data.size
        tab.dirty = false
        tab.conflict = false
        renderTabs()
        flashStatus("已保存 " + tab.name)
        scheduleScmRefresh()
        return true
    }).catch(function (error) {
        if (error.status === 409) {
            tab.conflict = true
            renderTabs()
            return handleSaveConflict(tab)
        }
        toast("保存失败：" + error.message, "error")
        return false
    })
}

function saveActive() {
    if (app.active === null) return Promise.resolve(false)
    return saveTab(app.active)
}

function saveAll() {
    var dirty = app.tabs.filter(function (tab) {
        return tab.dirty === true && tab.binary !== true
    })
    if (dirty.length === 0) {
        toast("没有需要保存的文件", "info", { duration: 1800 })
        return Promise.resolve(true)
    }
    var sequence = Promise.resolve(true)
    dirty.forEach(function (tab) {
        sequence = sequence.then(function (ok) {
            if (!ok) return false
            return saveTab(tab)
        })
    })
    return sequence
}

function handleSaveConflict(tab) {
    return new Promise(function (resolve) {
        openModalShell({
            title: "保存冲突",
            body: el("p", "modal-text", tab.name + " 已在磁盘上被修改。可以重新加载磁盘上的版本，或者用当前编辑内容覆盖。"),
            buttons: [
                {
                    label: "取消",
                    value: "cancel"
                },
                {
                    label: "重新加载",
                    value: "reload"
                },
                {
                    label: "仍然覆盖",
                    value: "overwrite",
                    primary: true
                }
            ],
            onClose: function (value) {
                if (value === "reload") {
                    reloadTabFromDisk(tab).then(function () {
                        resolve(true)
                    })
                } else if (value === "overwrite") {
                    apiSend("/api/file", "PUT", { path: tab.path, content: tab.content }).then(function (data) {
                        tab.savedContent = tab.content
                        tab.mtimeMs = data.mtimeMs
                        tab.dirty = false
                        tab.conflict = false
                        renderTabs()
                        toast("已覆盖保存", "info")
                        resolve(true)
                    }).catch(function (error) {
                        toast("覆盖保存失败：" + error.message, "error")
                        resolve(false)
                    })
                } else {
                    resolve(false)
                }
            }
        })
    })
}

function reloadTabFromDisk(tab) {
    return apiGet("/api/file?path=" + enc(tab.path)).then(function (data) {
        if (data.binary === true) return
        tab.content = data.content
        tab.savedContent = data.content
        tab.mtimeMs = data.mtimeMs
        tab.size = data.size
        tab.eol = data.eol
        tab.indent = data.indent
        tab.dirty = false
        tab.conflict = false
        if (app.active === tab && tab.previewMode !== true) {
            showEditorTab(tab)
        }
        renderTabs()
        toast("已重新加载 " + tab.name, "info")
        return true
    }).catch(function (error) {
        toast("重新加载失败：" + error.message, "error")
        return false
    })
}

/* ── 状态栏 ───────────────────────────────────────────────── */

var lastCursorStatus = { line: 1, column: 1, selected: 0, lines: 1 }

function updateCursorStatus(status) {
    lastCursorStatus = status
    setText("cursor-pos", "Ln " + status.line + ", Col " + status.column)
    var selection = byId("status-selection")
    if (status.selected > 0) {
        selection.hidden = false
        setText("selection-pos", "已选择 " + status.selected + " 个字符")
    } else {
        selection.hidden = true
    }
}

function updateStatusForTab(tab) {
    var language = byId("status-language")
    if (language !== null) language.hidden = tab === null
    setText("language-label", tab !== null ? tab.label || "纯文本" : "纯文本")
    var indent = byId("status-indent")
    if (indent !== null) indent.hidden = tab === null || tab.diff === true
    var eol = byId("status-eol")
    if (eol !== null) eol.hidden = tab === null || tab.diff === true
    if (tab !== null) {
        var indentValue = tab.indent || String(app.settings.tabSize)
        setText("indent-label", indentValue === "tab" ? "Tab" : "空格: " + indentValue)
        setText("eol-label", tab.eol === "crlf" ? "CRLF" : "LF")
    }
}

/* ── 最近打开 ─────────────────────────────────────────────── */

function loadAllRecent() {
    var stored = loadJson(STORE_RECENT, null)
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {}
    return stored
}

function loadRecent() {
    var all = loadAllRecent()
    var saved = all[currentWorkspaceId()]
    if (!Array.isArray(saved)) return []
    return saved.filter(function (item) {
        return item !== null && typeof item === "object" && typeof item.path === "string"
    }).slice(0, MAX_RECENT)
}

function saveRecent() {
    var all = loadAllRecent()
    all[currentWorkspaceId()] = app.recent
    saveJson(STORE_RECENT, all)
}

function addRecent(tab) {
    var entry = {
        path: tab.path,
        name: tab.name,
        badge: tab.badge,
        tone: tab.tone
    }
    app.recent = app.recent.filter(function (item) {
        return item.path !== tab.path
    })
    app.recent.unshift(entry)
    app.recent = app.recent.slice(0, MAX_RECENT)
    saveRecent()
    renderWelcomeRecent()
}

function renderWelcomeRecent() {
    var list = byId("recent-list")
    if (list === null) return
    clear(list)
    if (app.recent.length === 0) {
        list.appendChild(el("p", "sidebar-empty", "还没有打开过文件。按 Ctrl+P 搜索文件。"))
        return
    }
    app.recent.forEach(function (item) {
        var button = el("button", "recent-item")
        button.type = "button"
        button.appendChild(el("span", "file-badge tone-" + (item.tone || "plain"), item.badge || "TXT"))
        button.appendChild(el("span", "recent-name", item.name || basename(item.path)))
        button.appendChild(el("span", "recent-path", item.path))
        button.addEventListener("click", function () {
            openFile(item.path).catch(function () {
                /* 文件可能已被删除 */
            })
        })
        list.appendChild(button)
    })
}

/* ── 搜索面板 ─────────────────────────────────────────────── */

var searchState = { caseSensitive: false, regex: false }

function runTextSearch() {
    var input = byId("search-input")
    var query = input.value.trim()
    var results = byId("search-results")
    var status = byId("search-status")
    if (query === "") {
        clear(results)
        status.textContent = "输入内容后按 Enter 搜索"
        return
    }
    status.textContent = "搜索中…"
    status.classList.add("is-busy")
    var url = "/api/search/text?q=" + enc(query)
    if (searchState.caseSensitive) url += "&case=1"
    if (searchState.regex) url += "&regex=1"
    apiGet(url).then(function (data) {
        status.classList.remove("is-busy")
        renderSearchResults(data, query)
    }).catch(function (error) {
        status.classList.remove("is-busy")
        status.textContent = "搜索失败：" + error.message
        clear(results)
    })
}

function renderSearchResults(data, query) {
    var results = byId("search-results")
    var status = byId("search-status")
    clear(results)
    if (data.matchCount === 0) {
        status.textContent = "没有找到匹配项 · 扫描 " + data.scanned + " 个文件"
        return
    }
    status.textContent = data.matchCount + " 个结果，共 " + data.files.length + " 个文件 · 扫描 " + data.scanned + " 个文件 · " + data.elapsedMs + " ms" + (data.truncated ? " · 已截断" : "")
    data.files.forEach(function (file) {
        var group = el("div", "search-file")
        var head = el("button", "search-file-head")
        head.type = "button"
        head.appendChild(el("span", "file-badge tone-" + (file.tone || "plain"), file.badge || "TXT"))
        head.appendChild(el("span", "search-file-name", file.name))
        var fileDirectory = dirname(file.path)
        if (fileDirectory !== "") {
            head.appendChild(el("span", "search-file-path", fileDirectory))
        }
        head.appendChild(el("span", "search-file-count", String(file.matches.length)))
        group.appendChild(head)
        file.matches.forEach(function (match) {
            var row = el("button", "search-match")
            row.type = "button"
            row.appendChild(el("span", "search-line", String(match.line)))
            var snippet = el("code", "search-snippet")
            snippet.innerHTML = highlightSnippet(match.text, query, searchState.caseSensitive, searchState.regex)
            row.appendChild(snippet)
            row.addEventListener("click", function () {
                openFile(file.path, { line: match.line, column: match.column })
            })
            group.appendChild(row)
        })
        results.appendChild(group)
    })
}

function escapeRegExpClient(value) {
    return value.replace(/[.*+?^\u0024()\[\]|\\{}]/g, "\\$&")
}

function highlightSnippet(text, query, caseSensitive, isRegex) {
    if (!query) return escapeHtml(text)
    var pattern
    try {
        pattern = new RegExp(isRegex ? query : escapeRegExpClient(query), caseSensitive ? "g" : "gi")
    } catch (error) {
        return escapeHtml(text)
    }
    var output = ""
    var last = 0
    var match
    while ((match = pattern.exec(text)) !== null) {
        if (match[0] === "") {
            pattern.lastIndex += 1
            continue
        }
        output += escapeHtml(text.slice(last, match.index))
        output += "<mark>" + escapeHtml(match[0]) + "</mark>"
        last = pattern.lastIndex
    }
    output += escapeHtml(text.slice(last))
    return output
}

function toggleSearchFlag(flag, button) {
    searchState[flag] = !searchState[flag]
    button.setAttribute("aria-pressed", searchState[flag] ? "true" : "false")
    button.classList.toggle("is-active", searchState[flag])
    if (byId("search-input").value.trim() !== "") runTextSearch()
}

/* ── 大纲 ─────────────────────────────────────────────────── */

function parseSymbols(content, language) {
    var symbols = []
    if (typeof content !== "string" || content === "") return symbols
    var lines = content.split("\n")
    var symbolsPattern = null
    var max = Math.min(lines.length, 8000)
    if (language === "typescript" || language === "javascript") {
        symbolsPattern = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/
    } else if (language === "python") {
        symbolsPattern = /^\s*(class|def|async def)\s+([A-Za-z_]\w*)/
    } else if (language === "rust") {
        symbolsPattern = /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|impl|mod|const|type)\s+([A-Za-z_]\w*)/
    } else if (language === "go") {
        symbolsPattern = /^\s*(func|type|var|const)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/
    } else if (language === "java" || language === "csharp") {
        symbolsPattern = /^\s*(?:public|private|protected|internal|static|abstract|final|sealed|partial|\s)*(class|interface|enum|record|void|[A-Za-z_][\w<>\[\]]*)\s+([A-Za-z_]\w*)\s*\(?/
    } else if (language === "css") {
        symbolsPattern = /^\s*([.#]?[A-Za-z_][\w-]*(?:[\s>+~][.#]?[A-Za-z_][\w-]*)*)\s*\{/
    } else if (language === "markdown") {
        symbolsPattern = /^(#{1,6})\s+(.+)$/
    } else if (language === "shell") {
        symbolsPattern = /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/
    } else if (language === "html") {
        symbolsPattern = /^(\s*)<([a-z][a-z0-9-]*)[^>]*\bid="([^"]+)"/
    } else if (language === "yaml" || language === "ini") {
        symbolsPattern = /^\s*([A-Za-z_][\w.-]*)\s*:/
    }
    if (symbolsPattern === null) return symbols

    for (var index = 0; index < max; index += 1) {
        var line = lines[index]
        if (line.length > 400) continue
        var match = symbolsPattern.exec(line)
        if (match === null) continue
        var name = ""
        var kind = "symbol"
        if (language === "markdown") {
            name = match[2].trim()
            kind = "heading"
        } else if (language === "html") {
            name = match[3]
            kind = "tag"
        } else if (language === "css") {
            name = match[1].trim()
            kind = "selector"
        } else if (language === "yaml" || language === "ini") {
            name = match[1]
            kind = "property"
        } else {
            name = match[2]
            kind = match[1]
            if (match[1] === "function" || match[1] === "fn" || match[1] === "def" || match[1] === "func") kind = "function"
            else if (match[1] === "class" || match[1] === "interface" || match[1] === "struct" || match[1] === "trait") kind = "class"
            else if (match[1] === "impl" || match[1] === "enum" || match[1] === "type" || match[1] === "record") kind = "type"
        }
        name = name.trim()
        if (name === "") continue
        var indent = line.length - line.replace(/^\s+/, "").length
        symbols.push({ name: name, line: index + 1, kind: kind, depth: Math.min(4, Math.floor(indent / 2)) })
        if (symbols.length >= 400) break
    }
    return symbols
}

function scheduleOutline() {
    if (app.outlineTimer !== null) clearTimeout(app.outlineTimer)
    app.outlineTimer = setTimeout(function () {
        app.outlineTimer = null
        updateOutline()
    }, 350)
}

function updateOutline() {
    var list = byId("outline-list")
    var empty = byId("outline-empty")
    if (list === null) return
    clear(list)
    if (app.active === null || app.active.binary === true) {
        empty.hidden = false
        setText("outline-file", "")
        return
    }
    setText("outline-file", app.active.name)
    var symbols = parseSymbols(app.active.content, app.active.language)
    if (symbols.length === 0) {
        empty.hidden = false
        return
    }
    empty.hidden = true
    symbols.forEach(function (symbol) {
        var row = el("button", "outline-item")
        row.type = "button"
        row.style.paddingLeft = 10 + symbol.depth * 12 + "px"
        var marker = el("span", "outline-kind outline-kind-" + symbol.kind, outlineMarker(symbol.kind))
        row.appendChild(marker)
        row.appendChild(el("span", "outline-name", symbol.name))
        row.appendChild(el("span", "outline-line", String(symbol.line)))
        row.addEventListener("click", function () {
            if (app.active !== null && app.active.previewMode === true) {
                app.active.previewMode = false
                showEditorTab(app.active)
            }
            app.editor.revealLine(symbol.line, 1)
        })
        list.appendChild(row)
    })
}

function outlineMarker(kind) {
    if (kind === "class") return "C"
    if (kind === "function") return "F"
    if (kind === "heading") return "#"
    if (kind === "selector") return "."
    if (kind === "property") return "P"
    if (kind === "tag") return "<>"
    if (kind === "type") return "T"
    return "S"
}

/* ── 语法诊断 ─────────────────────────────────────────────── */

var DIAGNOSTIC_DELAY = 250
var DIAGNOSTIC_MAX = 200

function scheduleDiagnostics(immediate) {
    if (app.diagnosticsTimer !== null) {
        clearTimeout(app.diagnosticsTimer)
        app.diagnosticsTimer = null
    }
    if (immediate === true) {
        runDiagnostics()
        return
    }
    app.diagnosticsTimer = setTimeout(function () {
        app.diagnosticsTimer = null
        runDiagnostics()
    }, DIAGNOSTIC_DELAY)
}

function runDiagnostics() {
    var tab = app.active
    if (tab === null) {
        applyDiagnostics([], "")
        return
    }
    if (tab.binary === true || tab.previewMode === true) {
        applyDiagnostics([], "当前文件不支持语法分析")
        return
    }
    var limit = typeof ANALYSIS_MAX_CHARS === "number" ? ANALYSIS_MAX_CHARS : 400000
    if (tab.content.length > limit) {
        applyDiagnostics([], "文件过大，已跳过语法分析")
        return
    }
    if (typeof analyzeSyntax !== "function") {
        applyDiagnostics([], "语法分析未加载")
        return
    }
    applyDiagnostics(analyzeSyntax(tab.content, tab.language), "")
}

function applyDiagnostics(items, skipReason) {
    app.diagnostics = Array.isArray(items) ? items.slice(0, DIAGNOSTIC_MAX) : []
    app.diagnosticsSkipReason = typeof skipReason === "string" ? skipReason : ""
    if (app.editor !== null) app.editor.setDiagnostics(app.diagnostics)
    renderDiagnosticChrome()
}

function renderDiagnosticChrome() {
    var count = app.diagnostics.length
    var status = byId("status-diagnostics")
    if (status !== null) {
        status.hidden = count === 0
        status.title = "语法问题：" + count + " 个"
        setText("diagnostics-count", String(count))
    }
    var badge = byId("problems-badge")
    if (badge !== null) {
        badge.hidden = count === 0
        badge.textContent = count > 99 ? "99+" : String(count)
    }
    if (app.view === "problems") renderProblemsList()
}

function renderProblemsList() {
    var list = byId("problems-list")
    var empty = byId("problems-empty")
    if (list === null) return
    clear(list)
    var tab = app.active
    setText("problems-file", tab === null ? "" : tab.name)
    if (tab === null) {
        empty.hidden = false
        empty.textContent = "没有打开的文件"
        return
    }
    if (app.diagnosticsSkipReason !== "") {
        empty.hidden = false
        empty.textContent = app.diagnosticsSkipReason
        return
    }
    if (app.diagnostics.length === 0) {
        empty.hidden = false
        empty.textContent = "当前文件没有语法问题"
        return
    }
    empty.hidden = true
    app.diagnostics.forEach(function (item) {
        var row = el("button", "problem-item")
        row.type = "button"
        var severity = item.severity === "warning" ? "warning" : "error"
        row.dataset.severity = severity
        row.appendChild(el("span", "problem-severity", severity === "warning" ? "!" : "×"))
        var body = el("span", "problem-body")
        body.appendChild(el("span", "problem-message", item.message || "语法错误"))
        body.appendChild(el("span", "problem-location", "行 " + item.line + "，列 " + item.column))
        row.appendChild(body)
        row.addEventListener("click", function () {
            if (app.active === null) return
            if (app.active.previewMode === true) {
                app.active.previewMode = false
                showEditorTab(app.active)
            }
            app.editor.revealLine(item.line, item.column)
            app.editor.focus()
        })
        list.appendChild(row)
    })
}

/* ── 源码管理（只读 Git） ─────────────────────────────────── */

function scheduleScmRefresh() {
    if (app.scm.timer !== null) clearTimeout(app.scm.timer)
    app.scm.timer = setTimeout(function () {
        app.scm.timer = null
        loadScmStatus(false)
    }, 350)
}

function loadScmStatus(showToast) {
    var seq = app.scm.seq + 1
    app.scm.seq = seq
    app.scm.loading = true
    apiGet("/api/git/status")
        .then(function (data) {
            if (app.scm.seq !== seq) return
            app.scm.loading = false
            app.scm.loaded = true
            app.scm.available = data.available !== false
            app.scm.repo = data.repo === true
            app.scm.branch = typeof data.branch === "string" ? data.branch : ""
            app.scm.ahead = typeof data.ahead === "number" ? data.ahead : 0
            app.scm.behind = typeof data.behind === "number" ? data.behind : 0
            app.scm.changes = Array.isArray(data.changes) ? data.changes : []
            app.scm.truncated = data.truncated === true
            app.scm.error = typeof data.error === "string" ? data.error : ""
            renderScm()
            applyScmDecorations()
        })
        .catch(function (error) {
            if (app.scm.seq !== seq) return
            app.scm.loading = false
            app.scm.loaded = true
            app.scm.available = false
            app.scm.repo = false
            app.scm.changes = []
            app.scm.error = error.message
            renderScm()
            if (showToast === true) toast("读取 Git 状态失败：" + error.message, "error")
        })
}

function scmUnstagedLetter(change) {
    return change.y !== " " && change.y !== "?" ? change.y : change.x
}

function renderScm() {
    var changes = app.scm.changes
    var badge = byId("scm-badge")
    if (badge !== null) {
        badge.hidden = changes.length === 0
        badge.textContent = changes.length > 99 ? "99+" : String(changes.length)
    }
    var branchNode = byId("scm-branch")
    if (branchNode !== null) {
        branchNode.textContent = app.scm.repo === true ? (app.scm.branch === "" ? "HEAD" : app.scm.branch) : "—"
    }
    var sync = byId("scm-sync")
    if (sync !== null) {
        var parts = []
        if (app.scm.ahead > 0) parts.push("↑" + app.scm.ahead)
        if (app.scm.behind > 0) parts.push("↓" + app.scm.behind)
        sync.textContent = parts.join(" ")
        sync.hidden = parts.length === 0
    }
    var hint = byId("scm-hint")
    if (hint !== null) {
        var hintText = ""
        if (app.scm.available !== true) hintText = app.scm.error || "Git 不可用"
        else if (app.scm.repo !== true) hintText = app.scm.error || "当前工作区不在 git 仓库里"
        else if (app.readOnly === true) hintText = "只读模式：不能暂存或修改文件"
        else if (app.scm.truncated) hintText = "改动过多，仅显示前 2000 项"
        hint.textContent = hintText
        hint.hidden = hintText === ""
    }
    var groups = byId("scm-groups")
    var empty = byId("scm-empty")
    if (groups === null) return
    clear(groups)
    if (app.scm.repo !== true || changes.length === 0) {
        if (empty !== null) {
            empty.hidden = app.scm.repo !== true
            empty.textContent = "没有更改"
        }
        var stageAllHidden = byId("scm-stage-all")
        if (stageAllHidden !== null) stageAllHidden.hidden = true
        var unstageAllHidden = byId("scm-unstage-all")
        if (unstageAllHidden !== null) unstageAllHidden.hidden = true
        return
    }
    if (empty !== null) empty.hidden = true
    var staged = changes.filter(function (change) { return change.staged === true })
    var unstaged = changes.filter(function (change) {
        return change.staged !== true && change.untracked !== true
    })
    var untracked = changes.filter(function (change) { return change.untracked === true })
    appendScmGroup(groups, "暂存的更改", staged, true, function (change) { return change.x })
    appendScmGroup(groups, "更改", unstaged, false, scmUnstagedLetter)
    appendScmGroup(groups, "未跟踪", untracked, false, function () { return "?" })
    var stageAll = byId("scm-stage-all")
    if (stageAll !== null) {
        stageAll.hidden = app.readOnly === true || unstaged.length + untracked.length === 0
    }
    var unstageAll = byId("scm-unstage-all")
    if (unstageAll !== null) {
        unstageAll.hidden = app.readOnly === true || staged.length === 0
    }
}

function appendScmGroup(container, title, changes, staged, letterOf) {
    if (changes.length === 0) return
    var group = el("div", "scm-group")
    var head = el("div", "scm-group-head")
    head.appendChild(el("span", null, title))
    head.appendChild(el("span", "scm-group-count", String(changes.length)))
    group.appendChild(head)
    changes.forEach(function (change) {
        group.appendChild(buildScmRow(change, staged, letterOf(change)))
    })
    container.appendChild(group)
}

function buildScmRow(change, staged, letter) {
    var row = el("div", "scm-item")
    row.dataset.path = change.path
    var badge = el("span", "scm-letter scm-letter-" + letter, letter)
    row.appendChild(badge)
    var open = el("button", "scm-open")
    open.type = "button"
    open.appendChild(el("span", "scm-name", basename(change.path)))
    var dir = dirname(change.path)
    if (dir !== "") open.appendChild(el("span", "scm-dir", dir))
    open.addEventListener("click", function () {
        if (letter === "D") {
            openScmDiff(change, staged)
            return
        }
        openFile(change.path)
            .then(function () {
                collapseSidebarOnMobile()
            })
            .catch(function (error) {
                toast("无法打开文件：" + error.message, "error")
            })
    })
    row.appendChild(open)
    if (app.readOnly !== true) {
        var actionLabel = staged === true ? "取消暂存" : "暂存"
        var action = el("button", "icon-btn sm scm-action")
        action.type = "button"
        action.title = actionLabel
        action.setAttribute("aria-label", actionLabel)
        action.innerHTML = iconSvg(staged === true ? "minus" : "plus", "icon icon-xs")
        action.addEventListener("click", function () {
            stageScmPaths([change.path], staged === true)
        })
        row.appendChild(action)
    }
    var diff = el("button", "text-btn scm-diff-btn", "差异")
    diff.type = "button"
    diff.addEventListener("click", function () {
        openScmDiff(change, staged)
    })
    row.appendChild(diff)
    return row
}

function applyScmDecorations() {
    var letters = {}
    if (app.scm.repo === true) {
        app.scm.changes.forEach(function (change) {
            letters[change.path] = change.untracked === true ? "?" : scmUnstagedLetter(change)
        })
    }
    var rows = document.querySelectorAll(".tree-row")
    for (var index = 0; index < rows.length; index += 1) {
        var row = rows[index]
        var existing = row.querySelector(".tree-scm")
        if (existing !== null) row.removeChild(existing)
        if (row.dataset.type !== "file") continue
        var letter = letters[row.dataset.path]
        if (letter === undefined) continue
        var badge = el("span", "tree-scm tree-scm-" + letter, letter)
        badge.title = "Git 状态：" + letter
        row.appendChild(badge)
    }
}

function stageScmPaths(paths, unstage) {
    if (!Array.isArray(paths)) return
    var unique = []
    paths.forEach(function (path) {
        if (typeof path === "string" && path !== "" && unique.indexOf(path) === -1) unique.push(path)
    })
    if (unique.length === 0) return
    var endpoint = unstage === true ? "/api/git/unstage" : "/api/git/stage"
    apiSend(endpoint, "POST", { paths: unique })
        .then(function (data) {
            if (data === null || data.ok !== true) {
                toast((data && data.error) || (unstage === true ? "取消暂存失败" : "暂存失败"), "error")
                return
            }
            flashStatus((unstage === true ? "已取消暂存 " : "已暂存 ") + unique.length + " 个文件")
            loadScmStatus(false)
        })
        .catch(function (error) {
            toast((unstage === true ? "取消暂存失败：" : "暂存失败：") + error.message, "error")
        })
}

function diffTabKey(path, staged) {
    return "diff:" + (staged === true ? "staged:" : "work:") + path
}

function openScmDiff(change, staged) {
    var key = diffTabKey(change.path, staged)
    apiGet("/api/git/diff?path=" + enc(change.path) + (staged === true ? "&staged=1" : ""))
        .then(function (data) {
            var tab = findTab(key)
            if (tab === null) {
                tab = createTab({
                    path: key,
                    name: basename(change.path) + (staged === true ? "（已暂存差异）" : "（差异）"),
                    kind: { language: "diff", label: "差异", badge: "D", tone: "plain" },
                    content: "",
                    savedContent: "",
                    mtimeMs: 0,
                    size: 0,
                    eol: "lf",
                    indent: ""
                })
                tab.diff = true
                tab.diffPath = change.path
                tab.diffStaged = staged === true
                tab.diffUntracked = change.untracked === true
                tab.diffData = data
                addTab(tab)
            } else {
                tab.diffData = data
                tab.diffUntracked = change.untracked === true
            }
            activateTab(tab.path)
        })
        .catch(function (error) {
            toast("读取差异失败：" + error.message, "error")
        })
}

function showDiffTab(tab) {
    var welcome = byId("welcome")
    var editor = byId("editor")
    var preview = byId("preview")
    var diffView = byId("diff-view")
    if (diffView === null) return
    if (welcome !== null) welcome.hidden = true
    if (editor !== null) editor.hidden = true
    if (preview !== null) preview.hidden = true
    diffView.hidden = false
    setText("diff-view-title", tab.diffPath || tab.name)
    setText("diff-view-mode", tab.diffStaged === true ? "已暂存" : "工作区")
    renderDiffTab(tab)
}

function closeDiffTab() {
    if (app.active !== null && app.active.diff === true) closeTab(app.active.path)
}

function refreshDiffTab() {
    var tab = app.active
    if (tab === null || tab.diff !== true) return
    apiGet("/api/git/diff?path=" + enc(tab.diffPath) + (tab.diffStaged === true ? "&staged=1" : ""))
        .then(function (data) {
            tab.diffData = data
            renderDiffTab(tab)
        })
        .catch(function (error) {
            toast("读取差异失败：" + error.message, "error")
        })
}

/** 把 unified diff 拆成左右两栏的行；连续删除/新增按序配对成一行 */
function buildDiffRows(content) {
    var rows = []
    var lines = String(content).split("\n")
    var index = 0
    var oldNo = 0
    var newNo = 0
    var pendingDel = []
    var pendingAdd = []

    function flush() {
        var count = Math.max(pendingDel.length, pendingAdd.length)
        for (var position = 0; position < count; position += 1) {
            var deleted = pendingDel[position]
            var added = pendingAdd[position]
            rows.push({
                kind:
                    deleted !== undefined && added !== undefined
                        ? "change"
                        : deleted !== undefined
                          ? "del"
                          : "add",
                oldNo: deleted === undefined ? null : oldNo++,
                oldText: deleted === undefined ? "" : deleted.slice(1),
                newNo: added === undefined ? null : newNo++,
                newText: added === undefined ? "" : added.slice(1)
            })
        }
        pendingDel = []
        pendingAdd = []
    }

    while (index < lines.length) {
        var line = lines[index]
        index += 1
        if (line.indexOf("@@") === 0) {
            flush()
            var header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
            if (header !== null) {
                oldNo = Number(header[1])
                newNo = Number(header[2])
            }
            rows.push({ kind: "hunk", text: line })
            continue
        }
        if (
            line.indexOf("diff --git") === 0 ||
            line.indexOf("index ") === 0 ||
            line.indexOf("--- ") === 0 ||
            line.indexOf("+++ ") === 0 ||
            line.indexOf("new file mode") === 0 ||
            line.indexOf("deleted file mode") === 0 ||
            line.indexOf("similarity index") === 0 ||
            line.indexOf("rename from") === 0 ||
            line.indexOf("rename to") === 0 ||
            line.indexOf("\\ No newline") === 0
        ) {
            flush()
            continue
        }
        if (line.charAt(0) === "-") {
            pendingDel.push(line)
            continue
        }
        if (line.charAt(0) === "+") {
            pendingAdd.push(line)
            continue
        }
        flush()
        if (line === "" && index === lines.length) continue
        var text = line.charAt(0) === " " ? line.slice(1) : line
        rows.push({ kind: "context", oldNo: oldNo++, oldText: text, newNo: newNo++, newText: text })
    }
    flush()
    return rows
}

function renderDiffTab(tab) {
    var body = byId("diff-view-body")
    if (body === null) return
    clear(body)
    body.scrollTop = 0
    var data = tab.diffData
    if (data === null || data === undefined || data.available !== true || data.repo !== true) {
        body.appendChild(el("p", "diff-view-note", (data && data.error) || "Git 不可用"))
        return
    }
    if (typeof data.content !== "string" || data.content === "") {
        body.appendChild(
            el(
                "p",
                "diff-view-note",
                tab.diffUntracked === true
                    ? "未跟踪文件没有 diff，可直接打开文件查看"
                    : "没有可显示的差异"
            )
        )
        return
    }
    var rows = buildDiffRows(data.content)
    if (rows.length === 0) {
        body.appendChild(el("p", "diff-view-note", "没有可显示的差异"))
        return
    }
    var table = el("div", "diff-view-rows")
    rows.forEach(function (row) {
        if (row.kind === "hunk") {
            table.appendChild(el("div", "diff-view-hunk", row.text))
            return
        }
        var line = el("div", "diff-view-row")
        var oldCellClass = "diff-cell diff-old"
        if (row.oldNo === null) oldCellClass += " is-empty"
        else if (row.kind === "del" || row.kind === "change") oldCellClass += " is-del"
        var newCellClass = "diff-cell diff-new"
        if (row.newNo === null) newCellClass += " is-empty"
        else if (row.kind === "add" || row.kind === "change") newCellClass += " is-add"
        line.appendChild(el("span", "diff-no", row.oldNo === null ? "" : String(row.oldNo)))
        line.appendChild(el("span", oldCellClass, row.oldText))
        line.appendChild(el("span", "diff-no", row.newNo === null ? "" : String(row.newNo)))
        line.appendChild(el("span", newCellClass, row.newText))
        table.appendChild(line)
    })
    body.appendChild(table)
    if (data.truncated === true) {
        body.appendChild(el("p", "diff-view-note", "差异过长，已截断"))
    }
}

/* ── 命令面板 / 快速打开 ──────────────────────────────────── */

var COMMANDS = [
    { id: "quick-open", label: "转到文件…", category: "文件", keys: "Ctrl+P", run: openQuickOpen },
    { id: "workspace-switch", label: "切换工作区…", category: "文件", run: openWorkspacePicker },
    { id: "workspace-add", label: "添加工作区…", category: "文件", run: addWorkspace },
    { id: "new-file", label: "新建文件…", category: "文件", keys: "Ctrl+N", run: function () { newFileIn(defaultParent()) } },
    { id: "new-folder", label: "新建文件夹…", category: "文件", run: function () { newFolderIn(defaultParent()) } },
    { id: "save", label: "保存", category: "文件", keys: "Ctrl+S", enabled: hasActiveText, run: saveActive },
    { id: "save-all", label: "全部保存", category: "文件", keys: "Ctrl+Shift+S", run: saveAll },
    { id: "close-editor", label: "关闭编辑器", category: "文件", keys: "Ctrl+W", enabled: hasActiveTab, run: function () { if (app.active !== null) closeTab(app.active.path) } },
    { id: "close-all", label: "关闭所有编辑器", category: "文件", enabled: hasTabs, run: closeAllTabs },
    { id: "refresh-tree", label: "刷新资源管理器", category: "文件", run: reloadTree },
    { id: "undo", label: "撤销", category: "编辑", keys: "Ctrl+Z", enabled: hasActiveText, run: function () { focusEditor(); document.execCommand("undo") } },
    { id: "redo", label: "重做", category: "编辑", keys: "Ctrl+Y", enabled: hasActiveText, run: function () { focusEditor(); document.execCommand("redo") } },
    { id: "find", label: "在文件中查找", category: "编辑", keys: "Ctrl+F", enabled: hasActiveText, run: function () { app.editor.openFind() } },
    { id: "replace", label: "替换", category: "编辑", keys: "Ctrl+H", enabled: hasActiveText, run: function () { if (hasActiveText()) app.editor.openFindReplace() } },
    { id: "select-all", label: "全选", category: "编辑", keys: "Ctrl+A", enabled: hasActiveText, run: function () { focusEditor(); byId("code-input").select() } },
    { id: "copy-path", label: "复制当前文件路径", category: "编辑", enabled: hasActiveTab, run: function () { if (app.active !== null) copyText(app.active.path) } },
    { id: "goto-line", label: "转到行…", category: "转到", keys: "Ctrl+G", enabled: hasActiveText, run: openGoto },
    { id: "symbol-search", label: "转到文件中的符号…", category: "转到", keys: "Ctrl+Shift+O", enabled: hasActiveText, run: openSymbolSearch },
    { id: "workspace-symbols", label: "转到工作区符号…", category: "转到", keys: "Ctrl+Alt+T", run: openWorkspaceSymbols },
    { id: "definition", label: "转到定义", category: "转到", keys: "F12", enabled: hasActiveText, run: definitionAtCaret },
    { id: "next-tab", label: "下一个编辑器", category: "转到", keys: "Ctrl+Tab", enabled: hasTabs, run: function () { cycleTab(1) } },
    { id: "previous-tab", label: "上一个编辑器", category: "转到", keys: "Ctrl+Shift+Tab", enabled: hasTabs, run: function () { cycleTab(-1) } },
    { id: "reveal-active", label: "在资源管理器中显示当前文件", category: "转到", enabled: hasActiveTab, run: function () { if (app.active !== null) revealInTree(app.active.path) } },
    { id: "explorer", label: "显示资源管理器", category: "查看", keys: "Ctrl+Shift+E", run: function () { setView("explorer") } },
    { id: "scm-view", label: "显示源码管理", category: "查看", run: function () { setView("scm") } },
    { id: "scm-refresh", label: "刷新源码管理", category: "查看", run: function () { loadScmStatus(true) } },
    { id: "search-view", label: "显示搜索", category: "查看", keys: "Ctrl+Shift+F", run: function () { setView("search", true) } },
    { id: "outline-view", label: "显示大纲", category: "查看", run: function () { setView("outline") } },
    { id: "problems-view", label: "显示问题", category: "查看", run: function () { setView("problems") } },
    { id: "settings-view", label: "显示设置", category: "查看", run: function () { setView("settings") } },
    { id: "toggle-sidebar", label: "切换侧边栏", category: "查看", keys: "Ctrl+B", run: toggleSidebar },
    { id: "toggle-theme", label: "切换深色 / 浅色主题", category: "查看", run: toggleTheme },
    { id: "toggle-minimap", label: "切换缩略图", category: "查看", run: toggleMinimap },
    { id: "toggle-terminal", label: "切换终端", category: "查看", keys: "Ctrl+Backquote", run: toggleTerminal },
    { id: "clear-terminal", label: "清屏终端", category: "查看", keys: "Ctrl+Shift+K", enabled: function () { return term.open === true && activeTermSession() !== null }, run: clearTerminal },
    { id: "toggle-preview", label: "预览 Markdown", category: "查看", keys: "Ctrl+Shift+V", enabled: function () { return app.active !== null && app.active.language === "markdown" && app.active.binary !== true }, run: togglePreview },
    { id: "palette", label: "命令面板", category: "帮助", keys: "Ctrl+Shift+P", run: openPalette },
    { id: "shortcuts", label: "键盘快捷键", category: "帮助", run: showShortcuts },
    { id: "about", label: "关于 Wellspring Code", category: "帮助", run: showAbout }
]

var COMMAND_MAP = {}
COMMANDS.forEach(function (command) {
    COMMAND_MAP[command.id] = command
})

var MENUS = {
    file: ["workspace-switch", "-", "new-file", "new-folder", "-", "save", "save-all", "-", "close-editor", "close-all", "-", "refresh-tree"],
    edit: ["undo", "redo", "-", "find", "replace", "select-all", "-", "copy-path"],
    view: ["palette", "quick-open", "workspace-switch", "-", "explorer", "scm-view", "scm-refresh", "search-view", "outline-view", "problems-view", "settings-view", "-", "toggle-sidebar", "toggle-theme", "toggle-minimap", "toggle-preview", "-", "toggle-terminal", "clear-terminal"],
    go: ["quick-open", "goto-line", "symbol-search", "workspace-symbols", "definition", "-", "next-tab", "previous-tab"],
    help: ["shortcuts", "about"]
}

function hasActiveTab() {
    return app.active !== null
}

function hasActiveText() {
    return (
        app.active !== null &&
        app.active.binary !== true &&
        app.active.previewMode !== true &&
        app.active.diff !== true
    )
}

function hasTabs() {
    return app.tabs.length > 0
}

function focusEditor() {
    var textarea = byId("code-input")
    if (textarea !== null && textarea.readOnly !== true) textarea.focus()
}

function defaultParent() {
    if (app.tree.selected !== "") {
        var selectedRow = document.querySelector('.tree-row[data-path="' + cssEscape(app.tree.selected) + '"]')
        if (selectedRow !== null) {
            if (selectedRow.dataset.type === "directory") return app.tree.selected
            return dirname(app.tree.selected)
        }
    }
    if (app.active !== null) return dirname(app.active.path)
    return ""
}

function executeCommand(id) {
    var command = COMMAND_MAP[id]
    if (command === undefined) return
    if (typeof command.enabled === "function" && !command.enabled()) {
        toast("当前上下文中不可用", "warning", { duration: 1800 })
        return
    }
    command.run()
}

function openPalette() {
    app.paletteMode = "commands"
    var overlay = byId("palette-overlay")
    var input = byId("palette-input")
    var prefix = overlay.querySelector(".palette-prefix")
    prefix.textContent = ">"
    input.value = ""
    input.placeholder = "输入命令名"
    overlay.hidden = false
    renderCommandPalette("")
    input.focus()
}

function openGoto() {
    app.paletteMode = "goto"
    var overlay = byId("palette-overlay")
    var input = byId("palette-input")
    var prefix = overlay.querySelector(".palette-prefix")
    prefix.textContent = ":"
    input.value = ""
    input.placeholder = "输入行号，Enter 跳转"
    overlay.hidden = false
    app.paletteItems = []
    var list = byId("palette-list")
    clear(list)
    setText("palette-foot", "输入行号后按 Enter 跳转")
    input.focus()
}

function renderCommandPalette(query) {
    var list = byId("palette-list")
    clear(list)
    var lower = query.toLowerCase()
    app.paletteItems = COMMANDS.filter(function (command) {
        if (lower === "") return true
        var haystack = (command.label + " " + command.category + " " + command.id).toLowerCase()
        return haystack.indexOf(lower) !== -1
    }).slice(0, 60)
    app.paletteItems.forEach(function (command, index) {
        var row = el("button", "palette-item")
        row.type = "button"
        row.dataset.index = String(index)
        row.appendChild(el("span", "palette-category", command.category))
        row.appendChild(el("span", "palette-label", command.label))
        if (command.keys) row.appendChild(el("kbd", "", command.keys))
        row.addEventListener("click", function () {
            closePalette()
            executeCommand(command.id)
        })
        list.appendChild(row)
    })
    setText("palette-foot", app.paletteItems.length === 0 ? "没有匹配的命令" : "↑↓ 选择 · Enter 执行 · Esc 关闭")
    setActiveListItem(list, 0)
}

function setActiveListItem(list, index) {
    if (list === null) return
    var items = list.querySelectorAll(".palette-item")
    if (items.length === 0) return
    var clamped = Math.max(0, Math.min(index, items.length - 1))
    for (var cursor = 0; cursor < items.length; cursor += 1) {
        items[cursor].classList.toggle("is-active", cursor === clamped)
    }
    var active = items[clamped]
    if (active !== null) active.scrollIntoView({ block: "nearest" })
    list.dataset.active = String(clamped)
}

function moveListActive(list, delta) {
    var items = list.querySelectorAll(".palette-item")
    if (items.length === 0) return
    var current = Number(list.dataset.active || "0")
    setActiveListItem(list, current + delta)
}

function activeListIndex(list) {
    return Number(list.dataset.active || "0")
}

function closePalette() {
    byId("palette-overlay").hidden = true
}

function closeQuickOpen() {
    byId("quickopen-overlay").hidden = true
}

function openQuickOpen() {
    openQuickOverlay("files")
}

function openSymbolSearch() {
    if (!hasActiveText()) {
        toast("当前没有可搜索的文件", "info")
        return
    }
    openQuickOverlay("symbols")
}

function openWorkspaceSymbols() {
    openQuickOverlay("workspace-symbols")
}

function openQuickOverlay(mode) {
    var overlay = byId("quickopen-overlay")
    var input = byId("quickopen-input")
    var palette = overlay.querySelector(".palette")
    app.quickMode = mode
    overlay.hidden = false
    input.value = ""
    var placeholder =
        mode === "workspace-symbols"
            ? "搜索工作区符号，Enter 跳转"
            : mode === "symbols"
              ? "搜索当前文件符号，Enter 跳转"
              : "按文件名搜索，Enter 打开"
    var label =
        mode === "workspace-symbols"
            ? "搜索工作区符号"
            : mode === "symbols"
              ? "搜索文件符号"
              : "搜索文件"
    input.placeholder = placeholder
    input.setAttribute("aria-label", label)
    if (palette !== null) palette.setAttribute("aria-label", label)
    renderQuickOpen("")
    input.focus()
}

function renderQuickOpen(query) {
    if (app.quickTimer !== null) clearTimeout(app.quickTimer)
    if (app.quickMode === "symbols") {
        renderSymbolQuickList(query)
        return
    }
    if (app.quickMode === "workspace-symbols") {
        renderWorkspaceSymbols(query)
        return
    }
    if (query === "") {
        var recentResults = app.recent.map(function (item) {
            return { path: item.path, name: item.name, badge: item.badge, tone: item.tone }
        })
        renderQuickList(recentResults, "最近打开")
        return
    }
    app.quickTimer = setTimeout(function () {
        apiGet("/api/search/files?q=" + enc(query)).then(function (data) {
            renderQuickList(data.entries, data.total + " 个文件" + (data.truncated ? "（索引已截断）" : ""))
        }).catch(function (error) {
            setText("quickopen-foot", "搜索失败：" + error.message)
        })
    }, 90)
}

function renderQuickList(entries, footText) {
    var list = byId("quickopen-list")
    clear(list)
    app.quickItems = entries
    entries.forEach(function (entry, index) {
        var row = el("button", "palette-item quick-item")
        row.type = "button"
        row.appendChild(el("span", "file-badge tone-" + (entry.tone || "plain"), entry.badge || "TXT"))
        row.appendChild(el("span", "quick-name", entry.name || basename(entry.path)))
        row.appendChild(el("span", "quick-path", dirname(entry.path) || "."))
        row.addEventListener("click", function () {
            closeQuickOpen()
            openFile(entry.path)
        })
        list.appendChild(row)
    })
    setText("quickopen-foot", entries.length === 0 ? "没有匹配的文件" : footText + " · ↑↓ 选择 · Enter 打开")
    setActiveListItem(list, 0)
}

function renderSymbolQuickList(query) {
    var list = byId("quickopen-list")
    var tab = app.active
    if (list === null) return
    clear(list)
    app.quickItems = []
    if (tab === null || tab.binary === true || tab.previewMode === true) {
        setText("quickopen-foot", "当前没有可搜索的文本文件")
        return
    }
    var symbols = parseSymbols(tab.content, tab.language)
    var needle = query.toLowerCase()
    var entries = []
    symbols.forEach(function (symbol) {
        var name = symbol.name || ""
        if (needle !== "" && name.toLowerCase().indexOf(needle) === -1) return
        entries.push({
            path: tab.path,
            name: name,
            line: symbol.line,
            kind: symbol.kind,
            depth: symbol.depth
        })
    })
    app.quickItems = entries
    entries.forEach(function (entry) {
        var row = el("button", "palette-item quick-item")
        row.type = "button"
        row.style.paddingLeft = 10 + (entry.depth || 0) * 12 + "px"
        row.appendChild(el("span", "outline-kind outline-kind-" + entry.kind, outlineMarker(entry.kind)))
        row.appendChild(el("span", "quick-name", entry.name))
        row.appendChild(el("span", "quick-path", "行 " + entry.line))
        row.addEventListener("click", function () {
            closeQuickOpen()
            jumpToSymbol(entry)
        })
        list.appendChild(row)
    })
    var foot = entries.length === 0
        ? (needle === "" ? "当前文件没有可跳转的符号" : "没有匹配的符号")
        : entries.length + " 个符号 · ↑↓ 选择 · Enter 跳转"
    setText("quickopen-foot", foot)
    setActiveListItem(list, 0)
}

function renderWorkspaceSymbols(query) {
    if (app.quickTimer !== null) clearTimeout(app.quickTimer)
    var seq = (app.quickSeq || 0) + 1
    app.quickSeq = seq
    setText("quickopen-foot", "搜索中…")
    app.quickTimer = setTimeout(function () {
        app.quickTimer = null
        apiGet("/api/symbols?q=" + enc(query))
            .then(function (data) {
                if (app.quickSeq !== seq || app.quickMode !== "workspace-symbols") return
                renderWorkspaceSymbolList(data, query)
            })
            .catch(function (error) {
                if (app.quickSeq !== seq) return
                setText("quickopen-foot", "搜索失败：" + error.message)
            })
    }, 160)
}

function renderWorkspaceSymbolList(data, query) {
    var list = byId("quickopen-list")
    if (list === null) return
    clear(list)
    var entries = Array.isArray(data.symbols) ? data.symbols : []
    app.quickItems = entries
    entries.forEach(function (entry) {
        var row = el("button", "palette-item quick-item")
        row.type = "button"
        row.style.paddingLeft = 10 + (entry.depth || 0) * 12 + "px"
        row.appendChild(el("span", "outline-kind outline-kind-" + entry.kind, outlineMarker(entry.kind)))
        row.appendChild(el("span", "quick-name", entry.name))
        row.appendChild(el("span", "quick-path", entry.path + ":" + entry.line))
        row.addEventListener("click", function () {
            closeQuickOpen()
            jumpToSymbol(entry)
        })
        list.appendChild(row)
    })
    var foot
    if (entries.length === 0) {
        foot = query === "" ? "工作区没有可搜索的符号" : "没有匹配的符号"
    } else {
        var suffix = data.truncated === true ? "（索引已截断）" : ""
        foot = String(data.total) + " 个符号" + suffix + " · ↑↓ 选择 · Enter 跳转"
    }
    setText("quickopen-foot", foot)
    setActiveListItem(list, 0)
}

function jumpToSymbol(entry) {
    if (entry === null || entry === undefined) return
    if (app.active !== null && app.active.path === entry.path) {
        app.editor.revealLine(entry.line, 1)
        app.editor.focus()
        return
    }
    openFile(entry.path)
        .then(function () {
            if (app.active !== null && app.active.path === entry.path) {
                app.editor.revealLine(entry.line, 1)
                app.editor.focus()
            }
        })
        .catch(function (error) {
            toast("无法打开文件：" + error.message, "error")
        })
}

/* ── 转到定义 ─────────────────────────────────────────────── */

function findSymbolInTab(tab, word) {
    if (tab === null || tab.binary === true || tab.previewMode === true) return null
    var symbols = parseSymbols(tab.content, tab.language)
    for (var index = 0; index < symbols.length; index += 1) {
        if (symbols[index].name === word) return symbols[index]
    }
    return null
}

function lookupDefinition(word) {
    var active = app.active
    var found = findSymbolInTab(active, word)
    if (found !== null) return { tab: active, symbol: found }
    for (var index = 0; index < app.tabs.length; index += 1) {
        var tab = app.tabs[index]
        if (tab === active) continue
        var other = findSymbolInTab(tab, word)
        if (other !== null) return { tab: tab, symbol: other }
    }
    return null
}

/** 当前文件优先，其次在已打开的标签里找同名符号 */
function goToDefinition(word) {
    var name = typeof word === "string" ? word : ""
    if (name === "") return
    var result = lookupDefinition(name)
    if (result === null) {
        toast("未找到定义：" + name, "info")
        return
    }
    if (result.tab !== app.active) activateTab(result.tab.path)
    app.editor.revealLine(result.symbol.line, 1)
    app.editor.focus()
    announce("已跳转到 " + name)
}

function definitionAtCaret() {
    if (app.editor !== null) app.editor.goToDefinition()
}

/* ── 菜单 ─────────────────────────────────────────────────── */

function closeMenus() {
    var existing = document.querySelector(".menu-popup")
    if (existing !== null) existing.parentNode.removeChild(existing)
    var buttons = document.querySelectorAll(".menubar-item")
    for (var index = 0; index < buttons.length; index += 1) {
        buttons[index].setAttribute("aria-expanded", "false")
    }
}

function openMenu(name, anchor) {
    var existing = document.querySelector(".menu-popup")
    if (existing !== null && existing.dataset.menu === name) {
        closeMenus()
        return
    }
    closeMenus()
    var items = MENUS[name] || []
    var popup = el("div", "menu-popup")
    popup.dataset.menu = name
    popup.setAttribute("role", "menu")
    items.forEach(function (id) {
        if (id === "-") {
            popup.appendChild(el("div", "menu-separator"))
            return
        }
        var command = COMMAND_MAP[id]
        if (command === undefined) return
        var row = el("button", "menu-item")
        row.type = "button"
        row.setAttribute("role", "menuitem")
        var disabled = typeof command.enabled === "function" && !command.enabled()
        if (disabled) row.classList.add("is-disabled")
        row.appendChild(el("span", "menu-label", command.label))
        if (command.keys) row.appendChild(el("kbd", "", command.keys))
        row.addEventListener("click", function () {
            closeMenus()
            if (!disabled) executeCommand(id)
        })
        popup.appendChild(row)
    })
    var rect = anchor.getBoundingClientRect()
    popup.style.top = rect.bottom + 4 + "px"
    popup.style.left = Math.min(rect.left, window.innerWidth - 280) + "px"
    document.body.appendChild(popup)
    anchor.setAttribute("aria-expanded", "true")
}

/* ── 右键菜单 ─────────────────────────────────────────────── */

function closeContextMenu() {
    var menu = byId("context-menu")
    menu.hidden = true
    clear(menu)
}

function showContextMenu(x, y, items) {
    var menu = byId("context-menu")
    clear(menu)
    items.forEach(function (item) {
        if (item.separator === true) {
            menu.appendChild(el("div", "menu-separator"))
            return
        }
        var row = el("button", "menu-item" + (item.danger ? " is-danger" : ""))
        row.type = "button"
        row.setAttribute("role", "menuitem")
        row.appendChild(el("span", "menu-label", item.label))
        row.addEventListener("click", function () {
            closeContextMenu()
            item.action()
        })
        menu.appendChild(row)
    })
    menu.hidden = false
    var width = menu.offsetWidth
    var height = menu.offsetHeight
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - width - 6)) + "px"
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - height - 6)) + "px"
    setTimeout(function () {
        document.addEventListener("click", closeContextMenu, { once: true })
    }, 0)
}

/* ── 视图切换 ─────────────────────────────────────────────── */

function setView(view, focusSearch, preserveSidebar) {
    app.view = view
    var buttons = document.querySelectorAll(".activity")
    for (var index = 0; index < buttons.length; index += 1) {
        var button = buttons[index]
        button.classList.toggle("is-active", button.dataset.view === view)
    }
    var panels = document.querySelectorAll(".sidebar-view")
    for (var panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
        panels[panelIndex].hidden = panels[panelIndex].dataset.panel !== view
    }
    if (preserveSidebar !== true && app.sidebarVisible !== true) toggleSidebar(true)
    if (view === "search" && focusSearch === true) {
        byId("search-input").focus()
    }
    if (view === "explorer") {
        var tree = byId("tree")
        if (tree !== null) tree.focus()
    }
    if (view === "problems") renderProblemsList()
    if (view === "scm") {
        renderScm()
        loadScmStatus(false)
    }
}

function toggleSidebar(force) {
    var sidebar = byId("sidebar")
    var workbench = byId("workbench")
    var next = typeof force === "boolean" ? force : !app.sidebarVisible
    app.sidebarVisible = next
    sidebar.classList.toggle("is-hidden", !next)
    workbench.classList.toggle("sidebar-hidden", !next)
    saveJson(STORE_SIDEBAR, { visible: next })
}

function isMobileLayout() {
    return window.matchMedia !== undefined && window.matchMedia("(max-width: 760px)").matches
}

/** 软键盘会压缩可视视口：工作台高度用 visualViewport 的高度，避免底部被键盘挡住 */
function syncAppHeight() {
    var view = window.visualViewport
    var height = view !== null && typeof view.height === "number" && view.height > 0
        ? view.height
        : window.innerHeight
    document.documentElement.style.setProperty("--app-height", Math.round(height) + "px")
}

/** 移动端点开文件或切换工作区后收起侧栏，把内容让出来 */
function collapseSidebarOnMobile() {
    if (isMobileLayout() && app.sidebarVisible === true) toggleSidebar(false)
}

function toggleMinimap() {
    updateSetting("minimap", app.settings.minimap !== true)
    toast(app.settings.minimap ? "已显示缩略图" : "已隐藏缩略图", "info", { duration: 1600 })
}

function togglePreview() {
    if (app.active === null || app.active.language !== "markdown" || app.active.binary === true) {
        toast("当前文件不支持预览", "warning")
        return
    }
    if (app.active.previewMode === true) {
        closePreview()
        return
    }
    captureView()
    app.active.previewMode = true
    showPreview(app.active)
    renderTabs()
}

/* ── 快捷键 ───────────────────────────────────────────────── */

function isTypingTarget(target) {
    if (target === null || target === undefined) return false
    var tag = target.tagName
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

function onGlobalKeydown(event) {
    var modifier = event.ctrlKey || event.metaKey
    var key = event.key
    if (!modifier) {
        if (key === "Escape") {
            if (!byId("context-menu").hidden) {
                closeContextMenu()
                event.preventDefault()
                return
            }
            if (!byId("modal").hidden) return
            if (!byId("workspace-overlay").hidden) {
                closeWorkspacePicker()
                event.preventDefault()
                return
            }
            if (!byId("palette-overlay").hidden) {
                closePalette()
                event.preventDefault()
                return
            }
            if (!byId("quickopen-overlay").hidden) {
                closeQuickOpen()
                event.preventDefault()
                return
            }
            if (byId("editor").hidden !== true && app.editor !== null && app.editor.handleGlobalKey(event)) {
                event.preventDefault()
            }
        }
        return
    }
    var lower = key.toLowerCase()
    /*
     * 焦点在控制台里：键盘先归终端。控制台自己的复制粘贴与 PTY 控制码都在
     * handleConsoleKeydown 里处理，这里再走一遍全局快捷键就会做两次——
     * 比如 Ctrl+Shift+V 既往终端粘贴、又切出 Markdown 预览。
     */
    if (terminalFocused() && terminalOwnsKey(lower)) return
    if (lower === "t" && event.altKey) {
        event.preventDefault()
        openWorkspaceSymbols()
        return
    }
    if (lower === "s" && event.shiftKey) {
        event.preventDefault()
        saveAll()
        return
    }
    if (lower === "s") {
        event.preventDefault()
        saveActive()
        return
    }
    if (lower === "o" && event.shiftKey) {
        event.preventDefault()
        openSymbolSearch()
        return
    }
    if (lower === "p" && event.shiftKey) {
        event.preventDefault()
        openPalette()
        return
    }
    if (lower === "p") {
        event.preventDefault()
        openQuickOpen()
        return
    }
    if (key === "\u0060" || key === "~") {
        event.preventDefault()
        toggleTerminal()
        return
    }
    if (lower === "b") {
        event.preventDefault()
        toggleSidebar()
        return
    }
    if (lower === "w" && !event.shiftKey) {
        if (app.active !== null) {
            event.preventDefault()
            closeTab(app.active.path)
        }
        return
    }
    if (lower === "f" && event.shiftKey) {
        event.preventDefault()
        setView("search", true)
        return
    }
    if (lower === "f") {
        if (hasActiveText()) {
            event.preventDefault()
            app.editor.openFind()
        }
        return
    }
    if (lower === "h") {
        if (hasActiveText()) {
            event.preventDefault()
            app.editor.openFindReplace()
        }
        return
    }
    if (lower === "g" && event.shiftKey) {
        event.preventDefault()
        definitionAtCaret()
        return
    }
    if (lower === "g") {
        event.preventDefault()
        openGoto()
        return
    }
    if (lower === "e" && event.shiftKey) {
        event.preventDefault()
        setView("explorer")
        return
    }
    if (lower === "v" && event.shiftKey) {
        event.preventDefault()
        togglePreview()
        return
    }
    if (lower === "tab") {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
        return
    }
    if (lower === "n" && !event.shiftKey) {
        event.preventDefault()
        newFileIn(defaultParent())
        return
    }
    if (lower === "z" && event.shiftKey) {
        event.preventDefault()
        focusEditor()
        document.execCommand("redo")
        return
    }
    if (lower === "z") {
        if (hasActiveText() && !isTypingTarget(event.target)) {
            focusEditor()
        }
        return
    }
}

/* ── 终端 / 控制台 ────────────────────────────────────────── */

var TERM_POLL_INTERVAL = 100
var TERM_MAX_SESSIONS = 4
/* 单次写入 PTY 的按键长度上限 */
var TERM_MAX_INPUT = 4096

var term = {
    open: false,
    ptyReady: false,
    ptyReason: null,
    ptyWarned: false,
    checked: false,
    sessions: [],
    activeId: null,
    pollTimer: null,
    history: [],
    historyIndex: -1,
    draft: "",
    metrics: null,
    restored: false
}

function termOutput() {
    return byId("terminal-output")
}

function termSession(id) {
    for (var index = 0; index < term.sessions.length; index += 1) {
        if (term.sessions[index].id === id) return term.sessions[index]
    }
    return null
}

function activeTermSession() {
    return term.activeId === null ? null : termSession(term.activeId)
}

/* ── 尺寸测算 ─────────────────────────────────────────────── */

/** 用探针量出等宽字符宽度，并换算成 cols/rows */
function termMetrics() {
    var output = termOutput()
    if (output === null) return { cols: 100, rows: 28, charWidth: 7.8, rowHeight: 19 }
    var style = getComputedStyle(output)
    if (term.metrics !== null && term.metrics.font === style.font) return term.metrics
    var probe = el("span", "vt-probe")
    probe.textContent = new Array(101).join("0")
    output.appendChild(probe)
    var charWidth = probe.getBoundingClientRect().width / 100
    probe.remove()
    if (!(charWidth > 0)) charWidth = 7.8
    var fontSize = parseFloat(style.fontSize) || 13
    var rowHeight = Math.round(fontSize * 1.45)
    var paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    var paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    var usableWidth = Math.max(1, output.clientWidth - paddingX)
    var usableHeight = Math.max(1, output.clientHeight - paddingY)
    var metrics = {
        font: style.font,
        charWidth: charWidth,
        rowHeight: rowHeight,
        cols: Math.max(20, Math.floor(usableWidth / charWidth)),
        rows: Math.max(6, Math.floor(usableHeight / rowHeight))
    }
    var root = document.documentElement
    root.style.setProperty("--vt-char-width", charWidth + "px")
    root.style.setProperty("--vt-row-height", rowHeight + "px")
    term.metrics = metrics
    return metrics
}

/* ── 高度调整 ─────────────────────────────────────────────── */

/** 当前窗口下终端能拉到多高：给编辑器和标签页留出余量 */
function terminalMaxHeight() {
    var area = byId("editor-area")
    if (area === null) return 1200
    return Math.max(TERM_MIN_HEIGHT, area.clientHeight - TERM_AREA_RESERVED)
}

/** 当前字号下终端能缩到多矮：至少留出 TERM_MIN_VISIBLE_ROWS 行可见 */
function terminalMinHeight() {
    var panel = byId("terminal")
    var output = termOutput()
    if (panel === null || output === null || panel.offsetHeight === 0) return TERM_MIN_HEIGHT
    var style = getComputedStyle(output)
    var fontSize = parseFloat(style.fontSize) || 13
    var rowHeight = Math.round(fontSize * 1.45)
    var paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    var chrome = Math.max(0, panel.offsetHeight - output.clientHeight)
    return Math.max(TERM_MIN_HEIGHT, Math.ceil(chrome + paddingY + rowHeight * TERM_MIN_VISIBLE_ROWS))
}

function syncTerminalResizer() {
    var resizer = byId("terminal-resizer")
    if (resizer === null) return
    resizer.setAttribute("aria-valuenow", String(app.settings.terminalHeight))
    resizer.setAttribute("aria-valuemin", String(terminalMinHeight()))
    resizer.setAttribute("aria-valuemax", String(terminalMaxHeight()))
}

/** 设置终端高度；persist=true 时写回设置（localStorage） */
function setTerminalHeight(value, persist) {
    var minHeight = terminalMinHeight()
    var maxHeight = Math.max(minHeight, terminalMaxHeight())
    var next = clampNumber(value, minHeight, maxHeight, DEFAULT_SETTINGS.terminalHeight)
    app.settings.terminalHeight = next
    document.documentElement.style.setProperty("--terminal-height", next + "px")
    if (term !== undefined) term.metrics = null
    syncTerminalResizer()
    if (persist === true) saveSettings()
    return next
}

/** 面板尺寸变化后重新量 cols/rows，并把新尺寸同步给 PTY */
function refitTerminal() {
    if (term.open !== true) return
    term.metrics = null
    var session = activeTermSession()
    if (session === null || session.screen === null) return
    var output = termOutput()
    if (output === null) return
    var metrics = termMetrics()
    session.screen.resize(metrics.cols, metrics.rows)
    session.screen.render(output)
    if (session.serverId !== null && session.running === true) {
        apiSend("/api/console/resize", "POST", {
            id: session.serverId,
            cols: metrics.cols,
            rows: metrics.rows
        }).catch(function () {
            /* 尺寸同步失败不影响使用 */
        })
    }
    syncTerminalScroll()
}

var termRefitTimer = null

function scheduleTerminalRefit() {
    if (termRefitTimer !== null) return
    termRefitTimer = setTimeout(function () {
        termRefitTimer = null
        refitTerminal()
    }, 120)
}

/* ── 会话 ─────────────────────────────────────────────────── */

function newTermSession(kind) {
    // 新会话接管输出区前，先让当前会话的屏幕脱离容器
    var previous = activeTermSession()
    if (previous !== null && previous.screen !== null) previous.screen.detach()
    var session = {
        id: "local-" + Date.now() + "-" + term.sessions.length,
        kind: kind,
        serverId: null,
        running: false,
        screen: null,
        transcript: "",
        exitCode: null,
        command: "",
        pendingOutput: false
    }
    if (kind === "pty") {
        var metrics = termMetrics()
        session.screen = createVtScreen({ cols: metrics.cols, rows: metrics.rows })
    }
    term.sessions.push(session)
    term.activeId = session.id
    return session
}

function openPtySession() {
    var session = newTermSession("pty")
    var metrics = termMetrics()
    renderTerminalTabs()
    renderTerminalState()
    apiSend("/api/console/open", "POST", { cols: metrics.cols, rows: metrics.rows })
        .then(function (data) {
            session.serverId = data.id
            session.running = true
            session.command = data.shell || ""
            renderTerminalTabs()
            renderTerminalState()
            startTermPoll()
        })
        .catch(function (error) {
            session.running = false
            session.transcript += "[控制台启动失败] " + error.message + "\n"
            renderTerminalOutput()
            renderTerminalState()
        })
    return session
}

/** 关闭一个终端标签：结束它的 PTY，并把焦点交给相邻会话；其他会话不受影响 */
function closeTermSession(session) {
    if (session === null) return
    var index = term.sessions.indexOf(session)
    if (index === -1) return
    if (session.serverId !== null) {
        var endpoint = session.kind === "pty" ? "/api/console/close" : "/api/term/stop"
        apiSend(endpoint, "POST", { id: session.serverId }).catch(function () {
            /* 进程可能已经退出 */
        })
    }
    if (session.screen !== null) session.screen.detach()
    term.sessions.splice(index, 1)
    if (term.sessions.length === 0) {
        term.activeId = null
        stopTermPoll()
        renderTerminalTabs()
        renderTerminalOutput()
        renderTerminalState()
        return
    }
    if (term.activeId === session.id) {
        var next = term.sessions[Math.min(index, term.sessions.length - 1)]
        term.activeId = next.id
    }
    renderTerminalTabs()
    renderTerminalOutput()
    renderTerminalState()
    var active = activeTermSession()
    if (active !== null && active.running === true) startTermPoll()
    else stopTermPoll()
    refitTerminal()
    focusTerminal()
}

function switchTermSession(id) {
    var session = termSession(id)
    if (session === null) return
    var current = activeTermSession()
    if (current !== null && current.screen !== null) current.screen.detach()
    term.activeId = id
    renderTerminalTabs()
    renderTerminalOutput()
    renderTerminalState()
    if (session.running === true) startTermPoll()
    else stopTermPoll()
}

/* ── 渲染 ─────────────────────────────────────────────────── */

function renderTerminalTabs() {
    var bar = byId("terminal-tabs")
    if (bar === null) return
    clear(bar)
    term.sessions.forEach(function (session, index) {
        var label = (session.kind === "pty" ? "控制台 " : "终端 ") + (index + 1)
        var tab = el("div", "terminal-tab")
        tab.setAttribute("role", "tab")
        if (session.running === true) tab.classList.add("is-running")
        if (session.id === term.activeId) {
            tab.classList.add("is-active")
            tab.setAttribute("aria-selected", "true")
        }
        var name = el("button", "terminal-tab-name")
        name.type = "button"
        name.textContent = label
        name.title = label
        name.addEventListener("click", function () {
            switchTermSession(session.id)
        })
        var close = el("button", "terminal-tab-close")
        close.type = "button"
        close.textContent = "\u00d7"
        close.title = "关闭这个终端"
        close.setAttribute("aria-label", "关闭" + label)
        close.addEventListener("click", function (event) {
            event.stopPropagation()
            closeTermSession(session)
        })
        tab.appendChild(name)
        tab.appendChild(close)
        bar.appendChild(tab)
    })
}

function renderTerminalState() {
    var session = activeTermSession()
    var input = byId("terminal-input")
    var cwd = byId("terminal-cwd")
    if (cwd !== null) {
        var root = (app.workspace && app.workspace.root) || app.hostRoot || ""
        cwd.textContent = root
        cwd.title = root
    }
    if (input !== null) {
        input.disabled = app.readOnly === true
        if (session === null) {
            input.placeholder = "没有终端会话，点 + 新建控制台"
        } else if (session.kind === "pty" && session.running !== true) {
            input.placeholder = "会话已退出，按 Enter 重新开始"
        } else if (term.ptyReady === true) {
            input.placeholder = "输入命令，Enter 发送；点输出区可直接敲键盘"
        } else {
            input.placeholder = "输入命令，Enter 执行"
        }
    }
}

function renderTerminalOutput() {
    var output = termOutput()
    if (output === null) return
    var session = activeTermSession()
    clear(output)
    if (session === null) {
        output.appendChild(el("div", "terminal-empty", "没有终端会话，点右上角的 + 新建一个"))
        return
    }
    if (session.screen !== null) {
        session.screen.render(output)
        return
    }
    if (session.transcript !== "") {
        var node = el("span", "")
        node.textContent = session.transcript
        output.appendChild(node)
    }
    output.scrollTop = output.scrollHeight
    syncTerminalScroll()
}

/** 回看状态同步到滚动条滑块与“回到底部”按钮 */
function syncTerminalScroll() {
    var session = activeTermSession()
    var track = byId("terminal-scrollbar")
    var thumb = byId("terminal-scrollbar-thumb")
    var jump = byId("terminal-jump")
    if (track === null || thumb === null || jump === null) return
    if (session === null || session.screen === null) {
        track.hidden = true
        jump.hidden = true
        return
    }
    var info = session.screen.scrollInfo()
    track.hidden = info.maxTop <= 0
    if (info.maxTop > 0 && track.clientHeight > 0) {
        var trackHeight = track.clientHeight
        var thumbHeight = Math.max(18, Math.round((trackHeight * info.rows) / Math.max(info.rows, info.total)))
        thumbHeight = Math.min(trackHeight, thumbHeight)
        var thumbTop = Math.round((info.top / info.maxTop) * (trackHeight - thumbHeight))
        thumb.style.height = thumbHeight + "px"
        thumb.style.top = thumbTop + "px"
    }
    if (info.following === true) session.pendingOutput = false
    var pending = session.pendingOutput === true
    jump.hidden = info.following === true && pending !== true
    jump.textContent = pending === true ? "↓ 有新输出" : "↓ 回到底部"
}

function termAppend(session, text, className) {
    var output = termOutput()
    if (output === null || text === "") return
    var node = el("span", className || "")
    node.textContent = text
    output.appendChild(node)
    var nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40
    if (nearBottom) output.scrollTop = output.scrollHeight
}

/* ── 轮询 ─────────────────────────────────────────────────── */

function pollTerm() {
    var session = activeTermSession()
    if (session === null || session.running !== true || session.serverId === null) {
        stopTermPoll()
        return
    }
    if (session.kind === "pty") pollPtySession(session)
    else pollCommandSession(session)
}

function pollPtySession(session) {
    apiGet("/api/console/poll?id=" + enc(session.serverId))
        .then(function (data) {
            if (data.chunk) {
                session.screen.write(data.chunk)
                if (session === activeTermSession()) {
                    var info = session.screen.scrollInfo()
                    if (info.following !== true) session.pendingOutput = true
                    session.screen.render(termOutput())
                    syncTerminalScroll()
                }
            }
            if (data.done === true) {
                session.running = false
                session.exitCode = data.exitCode
                if (session.screen !== null) {
                    var code = typeof data.exitCode === "number" ? data.exitCode : null
                    var notice = "[进程已退出" + (code === null ? "" : "，退出码 " + code) + "]"
                    // 退出提示用暗色/红色区分，并隐藏光标（会话已结束）
                    var tone = code === null || code === 0 ? "\u001b[2m" : "\u001b[31m"
                    session.screen.write("\r\n\u001b[?25l" + tone + notice + "\u001b[0m\r\n")
                    if (session === activeTermSession()) session.screen.render(termOutput())
                }
                renderTerminalTabs()
                renderTerminalState()
                syncTerminalScroll()
                stopTermPoll()
            }
        })
        .catch(function (error) {
            session.running = false
            if (session === activeTermSession()) {
                termAppend(session, "[拉取输出失败] " + error.message + "\n", "terminal-line-error")
            }
            renderTerminalTabs()
            renderTerminalState()
            stopTermPoll()
        })
}

function pollCommandSession(session) {
    apiGet("/api/term/poll?id=" + enc(session.serverId))
        .then(function (data) {
            if (data.chunk && session === activeTermSession()) termAppend(session, data.chunk)
            if (data.done === true) {
                session.running = false
                session.exitCode = data.exitCode
                if (session === activeTermSession()) {
                    var status = ""
                    if (data.timedOut === true) status = "[超时终止]"
                    else if (data.truncated === true) status = "[输出已截断]"
                    else if (typeof data.exitCode === "number" && data.exitCode !== 0) status = "[退出码 " + data.exitCode + "]"
                    if (status !== "") termAppend(session, status + "\n", "terminal-line-error")
                }
                renderTerminalTabs()
                renderTerminalState()
                stopTermPoll()
            }
        })
        .catch(function (error) {
            session.running = false
            if (session === activeTermSession()) {
                termAppend(session, "[拉取输出失败] " + error.message + "\n", "terminal-line-error")
            }
            renderTerminalTabs()
            renderTerminalState()
            stopTermPoll()
        })
}

function startTermPoll() {
    if (term.pollTimer !== null) return
    term.pollTimer = setInterval(pollTerm, TERM_POLL_INTERVAL)
}

function stopTermPoll() {
    if (term.pollTimer !== null) {
        clearInterval(term.pollTimer)
        term.pollTimer = null
    }
}

/* ── 输入 ─────────────────────────────────────────────────── */

/** 把一段按键写进 PTY */
function termSendKeys(session, data) {
    if (session === null || session.serverId === null || data === "") return
    apiSend("/api/console/input", "POST", { id: session.serverId, data: data.slice(0, TERM_MAX_INPUT) })
        .catch(function (error) {
            toast("写入终端失败：" + error.message, "error")
        })
}

/** 输出区里选中的文字；没选中或选在别处时返回空串 */
function terminalSelectionText() {
    var output = termOutput()
    var selection = window.getSelection()
    if (output === null || selection === null || selection.isCollapsed === true) return ""
    var anchor = selection.anchorNode
    var focus = selection.focusNode
    if (anchor === null || focus === null) return ""
    if (output.contains(anchor) !== true || output.contains(focus) !== true) return ""
    return selection.toString()
}

function copyTerminalText(text) {
    if (text === "") return
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(text).then(function () {
            toast("已复制 " + text.length + " 个字符", "info", { duration: 1600 })
        }).catch(function () {
            toast("复制失败：浏览器拒绝访问剪贴板", "error")
        })
        return
    }
    toast("当前浏览器不支持剪贴板 API，请手动选中复制", "warning")
}

function pasteIntoTerminal(session) {
    if (session === null || session.kind !== "pty" || session.serverId === null) return
    if (navigator.clipboard === undefined || typeof navigator.clipboard.readText !== "function") {
        toast("当前浏览器不支持读取剪贴板，请在终端输入框里粘贴", "warning")
        return
    }
    navigator.clipboard.readText().then(function (text) {
        if (typeof text !== "string" || text === "") return
        termSendKeys(session, text)
    }).catch(function () {
        toast("粘贴失败：浏览器拒绝读取剪贴板", "error")
    })
}

/** 会话已退出时，按 Enter 在终端里重开一个 shell */
function restartPtySession(session) {
    if (session === null || session.kind !== "pty") return
    closeTermSession(session)
    ensureTerminalReady().then(function () {
        if (term.open !== true) return
        openPtySession()
        focusTerminal()
    })
}

/** 键盘事件转成终端字节序列 */
function termKeyBytes(event) {
    var key = event.key
    if (key === "Enter") return "\r"
    if (key === "Backspace") return "\u007f"
    if (key === "Tab") return "\t"
    if (key === "Escape") return "\u001b"
    if (key === "Delete") return "\u001b[3~"
    if (key === "Home") return "\u001b[H"
    if (key === "End") return "\u001b[F"
    if (key === "ArrowUp") return "\u001b[A"
    if (key === "ArrowDown") return "\u001b[B"
    if (key === "ArrowRight") return "\u001b[C"
    if (key === "ArrowLeft") return "\u001b[D"
    if (event.ctrlKey && key.length === 1) {
        var code = key.toUpperCase().charCodeAt(0)
        if (code >= 65 && code <= 90) return String.fromCharCode(code - 64)
        if (key === "[") return "\u001b"
        if (key === "\\") return "\u001c"
    }
    if (key.length === 1) return key
    return ""
}

function runTerminalInput(value) {
    var session = activeTermSession()
    if (session === null) return
    if (session.kind === "pty") {
        if (session.running !== true) {
            // shell 已退出：Enter 在这个标签重开一个
            restartPtySession(session)
            return
        }
        termSendKeys(session, value + "\r")
        if (value.trim() !== "") {
            term.history.push(value)
            term.historyIndex = -1
        }
        return
    }
    if (session.running === true) {
        toast("当前终端还有命令在运行", "warning")
        return
    }
    var trimmed = value.trim()
    if (trimmed === "") return
    session.command = trimmed
    session.running = true
    term.history.push(trimmed)
    term.historyIndex = -1
    termAppend(session, "$ " + trimmed + "\n", "terminal-line-command")
    renderTerminalTabs()
    renderTerminalState()
    apiSend("/api/term/run", "POST", { command: trimmed })
        .then(function (data) {
            session.serverId = data.id
            startTermPoll()
        })
        .catch(function (error) {
            session.running = false
            termAppend(session, "[启动失败] " + error.message + "\n", "terminal-line-error")
            renderTerminalTabs()
            renderTerminalState()
        })
}

/** 工具栏关闭按钮：关掉当前终端并移除它的标签（和标签上的 × 一致） */
function stopTerminalSession() {
    var session = activeTermSession()
    if (session === null) return
    closeTermSession(session)
}

function clearTerminal() {
    var session = activeTermSession()
    if (session === null) return
    if (session.screen !== null) {
        session.screen.clear()
        session.screen.render(termOutput())
        syncTerminalScroll()
        return
    }
    session.transcript = ""
    renderTerminalOutput()
}

/* ── 开关 ─────────────────────────────────────────────────── */

/**
 * 页面刷新后恢复终端：会话和 PTY 都在插件服务里，只有服务重启才会消失。
 * 历史输出已经被旧页面消费掉，这里只接管会话，并让 shell 重画提示符。
 */
function restoreTermSessions() {
    if (term.restored === true || term.sessions.length > 0) return
    term.restored = true
    apiGet("/api/console/list")
        .then(function (data) {
            var list = data !== null && typeof data === "object" && Array.isArray(data.sessions)
                ? data.sessions
                : []
            list.forEach(function (entry) {
                if (entry === null || typeof entry !== "object") return
                if (typeof entry.id !== "string" || entry.done === true) return
                var cols = typeof entry.cols === "number" ? entry.cols : 100
                var rows = typeof entry.rows === "number" ? entry.rows : 28
                var session = {
                    id: "restored-" + entry.id,
                    kind: "pty",
                    serverId: entry.id,
                    running: true,
                    screen: createVtScreen({ cols: cols, rows: rows }),
                    transcript: "",
                    exitCode: null,
                    command: ""
                }
                // 重放保留的输出，屏幕内容跟着恢复；没有历史时让 shell 重画提示符
                if (typeof entry.history === "string" && entry.history !== "") {
                    session.screen.write(entry.history)
                } else {
                    apiSend("/api/console/input", "POST", { id: entry.id, data: "\u000c" }).catch(function () {
                        /* 会话可能刚好退出 */
                    })
                }
                term.sessions.push(session)
                term.activeId = session.id
            })
            if (term.sessions.length === 0) return
            renderTerminalTabs()
            renderTerminalOutput()
            renderTerminalState()
            syncTerminalScroll()
        })
        .catch(function () {
            /* 列表接口失败就按没有恢复会话处理 */
        })
}

function ensureTerminalReady() {
    if (term.checked === true) return Promise.resolve(term.ptyReady)
    term.checked = true
    return apiGet("/api/console/state")
        .then(function (data) {
            term.ptyReady = data.available === true
            term.ptyReason = typeof data.reason === "string" ? data.reason : null
            return term.ptyReady
        })
        .catch(function (error) {
            term.ptyReady = false
            term.ptyReason = error.message
            return false
        })
}

function openTerminal() {
    var panel = byId("terminal")
    if (panel === null) return
    panel.hidden = false
    term.open = true
    term.metrics = null
    setTerminalHeight(app.settings.terminalHeight, false)
    syncTerminalActivity()
    renderTerminalState()
    ensureTerminalReady().then(function (ready) {
        if (ready !== true && term.ptyWarned !== true) {
            term.ptyWarned = true
            var reason = term.ptyReason === null ? "" : "：" + term.ptyReason
            toast("node-pty 不可用，控制台退回命令模式" + reason, "warning", { duration: 7000 })
        }
        if (term.sessions.length === 0) {
            if (ready === true) openPtySession()
            else newTermSession("cmd")
        }
        renderTerminalTabs()
        renderTerminalOutput()
        renderTerminalState()
        var resumed = activeTermSession()
        if (resumed !== null && resumed.running === true) startTermPoll()
        requestAnimationFrame(function () {
            var session = activeTermSession()
            if (session !== null && session.screen !== null) {
                session.screen.render(termOutput())
            }
            refitTerminal()
            syncTerminalCursorFocus()
            syncTerminalScroll()
        })
        focusTerminal()
    })
}

function closeTerminal() {
    var panel = byId("terminal")
    if (panel === null) return
    panel.hidden = true
    term.open = false
    syncTerminalActivity()
    stopTermPoll()
    if (app.editor !== null) app.editor.focus()
}

function toggleTerminal() {
    if (term.open === true) closeTerminal()
    else openTerminal()
}

/** 左下角活动栏按钮的开关态 */
function syncTerminalActivity() {
    var button = byId("activity-terminal")
    if (button !== null) button.classList.toggle("is-on", term.open === true)
}

function focusTerminal() {
    if (focusConsole() === true) return
    var input = byId("terminal-input")
    if (input !== null && input.disabled !== true) input.focus()
}

/** PTY 会话：把焦点放到不可见的 textarea 上，移动端软键盘才会弹出 */
function focusConsole() {
    var session = activeTermSession()
    var capture = byId("terminal-capture")
    if (session !== null && session.kind === "pty" && session.serverId !== null && capture !== null) {
        capture.focus()
        return true
    }
    return false
}

/** 把隐藏输入框里收到的文字原样送进 PTY（回车/退格由 beforeinput 处理） */
function sendConsoleText(text) {
    var session = activeTermSession()
    if (session === null || session.kind !== "pty" || session.serverId === null) return
    if (typeof text === "string" && text !== "") termSendKeys(session, text)
}

/** 终端输出区或命令框是否持有焦点；用于切换块光标 / 空心光标 */
function terminalFocused() {
    var output = termOutput()
    var input = byId("terminal-input")
    var capture = byId("terminal-capture")
    var active = document.activeElement
    return active !== null && (active === output || active === input || active === capture)
}

/**
 * 焦点在控制台里时，这条全局快捷键是否让位给终端
 *
 * 控制台是终端：Ctrl+Shift+V / Ctrl+Shift+C 是它自己的粘贴与复制，Ctrl+B、Ctrl+F、
 * Ctrl+W、Ctrl+P 这些还得按控制码发给 PTY。以前两套处理同时生效——既往 PTY 发字节，
 * 又顺手切预览 / 侧栏 / 标签，表现出来就是「焦点在控制台里按快捷键还在动编辑器」。
 * 只留「关掉控制台」这一条，否则键盘焦点会困在终端里出不来。
 */
function terminalOwnsKey(lower) {
    return lower !== "\u0060" && lower !== "~"
}

function syncTerminalCursorFocus() {
    var output = termOutput()
    if (output === null) return
    output.classList.toggle("is-idle", !terminalFocused())
    var session = activeTermSession()
    if (session !== null && session.screen !== null) session.screen.render(output)
}

/* ── 绑定 ─────────────────────────────────────────────────── */

function bindTerminal() {
    var panel = byId("terminal")
    if (panel === null) return
    var form = byId("terminal-form")
    var input = byId("terminal-input")
    var output = termOutput()

    form.addEventListener("submit", function (event) {
        event.preventDefault()
        var value = input.value
        input.value = ""
        runTerminalInput(value)
    })

    input.addEventListener("keydown", function (event) {
        if (event.key === "ArrowUp") {
            event.preventDefault()
            if (term.history.length === 0) return
            if (term.historyIndex === -1) {
                term.draft = input.value
                term.historyIndex = term.history.length - 1
            } else if (term.historyIndex > 0) {
                term.historyIndex -= 1
            }
            input.value = term.history[term.historyIndex]
            return
        }
        if (event.key === "ArrowDown") {
            event.preventDefault()
            if (term.historyIndex === -1) return
            if (term.historyIndex < term.history.length - 1) {
                term.historyIndex += 1
                input.value = term.history[term.historyIndex]
            } else {
                term.historyIndex = -1
                input.value = term.draft
            }
            return
        }
        if (event.key === "Escape") {
            event.stopPropagation()
            if (app.editor !== null) app.editor.focus()
            return
        }
        /* PTY 会话里 Ctrl+C 直接把中断送给前台进程 */
        if (term.ptyReady === true && event.ctrlKey && event.key.toLowerCase() === "c" && input.value === "") {
            var session = activeTermSession()
            if (session !== null && session.kind === "pty") {
                event.preventDefault()
                termSendKeys(session, "\u0003")
            }
        }
    })

    // 焦点在终端里才显示实心块光标，否则显示空心框
    panel.addEventListener("focusin", syncTerminalCursorFocus)
    panel.addEventListener("focusout", function () {
        window.setTimeout(syncTerminalCursorFocus, 0)
    })

    /* 输出区/隐藏输入框聚焦后键盘直通 PTY，交互式程序（vim / top）因此可用 */
    function handleConsoleKeydown(event) {
        var session = activeTermSession()
        if (session === null) return
        var key = event.key.toLowerCase()
        // 有选中文字时 Ctrl+C 交给浏览器复制，不再往 PTY 发 SIGINT
        if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "c") {
            if (terminalSelectionText() !== "") return
        }
        if (event.ctrlKey && event.shiftKey && key === "c") {
            var selected = terminalSelectionText()
            if (selected !== "") {
                event.preventDefault()
                copyTerminalText(selected)
                return
            }
        }
        if (event.ctrlKey && key === "v") {
            event.preventDefault()
            pasteIntoTerminal(session)
            return
        }
        /*
         * Ctrl+Shift+<字母> 是应用自己的组合（Ctrl+Shift+K 清屏、Ctrl+Shift+C 复制…），
         * 不能再当控制码发给 PTY：否则清屏会顺手发 ^K 把命令行后半段删掉，
         * 没选中文字时按 Ctrl+Shift+C 还会给前台进程一个 SIGINT。
         */
        if (event.ctrlKey && event.shiftKey) return
        if (session.kind !== "pty" || session.serverId === null) return
        if (event.key === "PageUp" || event.key === "PageDown") {
            event.preventDefault()
            session.screen.scrollBy(event.key === "PageUp" ? -session.screen.rows() : session.screen.rows())
            session.screen.render(output)
            syncTerminalScroll()
            return
        }
        var bytes = termKeyBytes(event)
        if (bytes === "") return
        event.preventDefault()
        termSendKeys(session, bytes)
    }

    output.addEventListener("keydown", handleConsoleKeydown)

    /* 移动端：点击输出区先聚焦隐藏 textarea，软键盘才会弹出 */
    var capture = byId("terminal-capture")
    if (capture !== null) {
        var captureComposing = false
        capture.addEventListener("keydown", handleConsoleKeydown)
        capture.addEventListener("compositionstart", function () {
            captureComposing = true
        })
        capture.addEventListener("compositionend", function (event) {
            captureComposing = false
            capture.value = ""
            sendConsoleText(event.data)
        })
        capture.addEventListener("beforeinput", function (event) {
            var session = activeTermSession()
            if (session === null || session.kind !== "pty" || session.serverId === null) {
                capture.value = ""
                return
            }
            if (event.inputType === "deleteContentBackward") {
                event.preventDefault()
                capture.value = ""
                termSendKeys(session, "\u007f")
                return
            }
            if (event.inputType === "deleteContentForward") {
                event.preventDefault()
                capture.value = ""
                termSendKeys(session, "\u001b[3~")
                return
            }
            if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
                event.preventDefault()
                capture.value = ""
                termSendKeys(session, "\r")
            }
        })
        capture.addEventListener("input", function (event) {
            var session = activeTermSession()
            if (session === null || session.kind !== "pty" || session.serverId === null) {
                capture.value = ""
                return
            }
            if (captureComposing) return
            var text = event.inputType === "insertText" && typeof event.data === "string"
                ? event.data
                : capture.value
            capture.value = ""
            if (text === "") return
            termSendKeys(session, text)
        })
    }

    output.addEventListener("click", function () {
        var session = activeTermSession()
        if (session !== null && session.kind === "pty") focusConsole()
        else focusTerminal()
    })

    output.addEventListener("wheel", function (event) {
        var session = activeTermSession()
        if (session === null || session.screen === null) return
        if (event.deltaY === 0) return
        event.preventDefault()
        session.screen.scrollBy(event.deltaY > 0 ? 2 : -2)
        session.screen.render(output)
        syncTerminalScroll()
    }, { passive: false })

    // 回看滚动条：拖滑块或点轨道跳转；右下角按钮一键回到底部
    var scrollTrack = byId("terminal-scrollbar")
    var scrollThumb = byId("terminal-scrollbar-thumb")
    if (scrollTrack !== null && scrollThumb !== null) {
        var scrollDrag = null
        var scrollToPointer = function (clientY) {
            var session = activeTermSession()
            if (session === null || session.screen === null) return
            var info = session.screen.scrollInfo()
            if (info.maxTop <= 0) return
            var rect = scrollTrack.getBoundingClientRect()
            var thumbHeight = scrollThumb.offsetHeight
            var span = Math.max(1, rect.height - thumbHeight)
            var ratio = (clientY - rect.top - thumbHeight / 2) / span
            ratio = Math.max(0, Math.min(1, ratio))
            session.screen.scrollTo(ratio * info.maxTop)
            session.screen.render(output)
            syncTerminalScroll()
        }
        scrollThumb.addEventListener("pointerdown", function (event) {
            var session = activeTermSession()
            if (session === null || session.screen === null) return
            event.preventDefault()
            event.stopPropagation()
            scrollDrag = { y: event.clientY, top: session.screen.scrollInfo().top }
            scrollThumb.setPointerCapture(event.pointerId)
            scrollTrack.classList.add("is-active")
        })
        scrollThumb.addEventListener("pointermove", function (event) {
            if (scrollDrag === null) return
            var session = activeTermSession()
            if (session === null || session.screen === null) return
            var info = session.screen.scrollInfo()
            if (info.maxTop <= 0) return
            var rect = scrollTrack.getBoundingClientRect()
            var thumbHeight = scrollThumb.offsetHeight
            var span = Math.max(1, rect.height - thumbHeight)
            session.screen.scrollTo(scrollDrag.top + ((event.clientY - scrollDrag.y) / span) * info.maxTop)
            session.screen.render(output)
            syncTerminalScroll()
        })
        var stopScrollDrag = function () {
            if (scrollDrag === null) return
            scrollDrag = null
            scrollTrack.classList.remove("is-active")
        }
        scrollThumb.addEventListener("pointerup", stopScrollDrag)
        scrollThumb.addEventListener("pointercancel", stopScrollDrag)
        scrollTrack.addEventListener("pointerdown", function (event) {
            if (event.target === scrollThumb) return
            event.preventDefault()
            scrollToPointer(event.clientY)
        })
    }
    var jump = byId("terminal-jump")
    if (jump !== null) {
        jump.addEventListener("click", function () {
            var session = activeTermSession()
            if (session === null || session.screen === null) return
            session.pendingOutput = false
            session.screen.scrollToEnd()
            session.screen.render(output)
            syncTerminalScroll()
            output.focus()
        })
    }

    var activityBtn = byId("activity-terminal")
    if (activityBtn !== null) activityBtn.addEventListener("click", toggleTerminal)
    byId("terminal-close").addEventListener("click", closeTerminal)
    // 垃圾桶 = 关闭当前终端（移除标签）；清屏走命令面板 / Ctrl+Shift+K
    byId("terminal-clear").addEventListener("click", stopTerminalSession)
    byId("terminal-new").addEventListener("click", function () {
        if (term.ptyReady === true) openPtySession()
        else {
            newTermSession("cmd")
            renderTerminalTabs()
            renderTerminalOutput()
        }
        focusTerminal()
    })

    window.addEventListener("resize", function () {
        if (term.open !== true) return
        syncTerminalResizer()
        refitTerminal()
    })

    /* 拖动终端顶部的分隔条调整高度；双击复位，聚焦后方向键微调 */
    var terminalResizer = byId("terminal-resizer")
    if (terminalResizer !== null) {
        var dragState = null
        terminalResizer.addEventListener("pointerdown", function (event) {
            if (typeof event.button === "number" && event.button !== 0) return
            var panel = byId("terminal")
            if (panel === null) return
            event.preventDefault()
            dragState = { y: event.clientY, height: panel.getBoundingClientRect().height }
            if (typeof terminalResizer.setPointerCapture === "function") {
                terminalResizer.setPointerCapture(event.pointerId)
            }
            document.body.classList.add("is-resizing-terminal")
        })
        terminalResizer.addEventListener("pointermove", function (event) {
            if (dragState === null) return
            event.preventDefault()
            setTerminalHeight(dragState.height + (dragState.y - event.clientY), false)
            scheduleTerminalRefit()
        })
        var finishTerminalResize = function () {
            if (dragState === null) return
            dragState = null
            document.body.classList.remove("is-resizing-terminal")
            saveSettings()
            refitTerminal()
        }
        terminalResizer.addEventListener("pointerup", finishTerminalResize)
        terminalResizer.addEventListener("pointercancel", finishTerminalResize)
        terminalResizer.addEventListener("keydown", function (event) {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
            event.preventDefault()
            var step = event.shiftKey === true ? 48 : 16
            var delta = event.key === "ArrowUp" ? step : -step
            setTerminalHeight(app.settings.terminalHeight + delta, true)
            refitTerminal()
        })
        terminalResizer.addEventListener("dblclick", function () {
            setTerminalHeight(DEFAULT_SETTINGS.terminalHeight, true)
            refitTerminal()
        })
    }
}

/* ── Markdown 预览 ────────────────────────────────────────── */

var MARKDOWN_LANGUAGES = {
    ts: "typescript",
    tsx: "typescript",
    typescript: "typescript",
    js: "javascript",
    jsx: "javascript",
    javascript: "javascript",
    json: "json",
    css: "css",
    scss: "css",
    html: "html",
    xml: "html",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    python: "python",
    sh: "shell",
    bash: "shell",
    shell: "shell",
    rust: "rust",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    csharp: "csharp",
    diff: "diff"
}

function sanitizeLink(url) {
    if (/^https?:\/\//i.test(url)) return url
    if (/^mailto:/i.test(url)) return url
    return null
}

function renderInlineMarkdown(text) {
    var output = escapeHtml(text)
    output = output.replace(/(\u0060[^\u0060]+\u0060)/g, function (match) {
        return "<code>" + match.slice(1, match.length - 1) + "</code>"
    })
    output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
        var safe = sanitizeLink(url)
        if (safe === null) return match
        return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + "</a>"
    })
    return output
}

function renderMarkdownDocument(source) {
    var lines = source.split("\n")
    var output = []
    var paragraph = []
    var list = null
    var fence = null
    var fenceLanguage = ""
    var fenceLines = []

    function flushParagraph() {
        if (paragraph.length > 0) {
            output.push("<p>" + paragraph.map(renderInlineMarkdown).join(" ") + "</p>")
            paragraph = []
        }
    }

    function flushList() {
        if (list !== null) {
            var tag = list.ordered ? "ol" : "ul"
            output.push("<" + tag + ">" + list.items.map(function (item) {
                return "<li>" + renderInlineMarkdown(item) + "</li>"
            }).join("") + "</" + tag + ">")
            list = null
        }
    }

    for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index]
        if (fence !== null) {
            var closeFence = /^\s*(\u0060{3,}|~{3,})\s*$/.exec(line)
            if (closeFence !== null) {
                var language = MARKDOWN_LANGUAGES[fenceLanguage] || ""
                var code = fenceLines.join("\n")
                var highlighted = language === "" ? escapeHtml(code) : highlightCode(code, language)
                output.push('<pre class="md-code"><code>' + highlighted + "</code></pre>")
                fence = null
                fenceLines = []
            } else {
                fenceLines.push(line)
            }
            continue
        }
        var openFence = /^\s*(\u0060{3,}|~{3,})\s*([\w+#-]*)/.exec(line)
        if (openFence !== null) {
            flushParagraph()
            flushList()
            fence = openFence[1]
            fenceLanguage = (openFence[2] || "").toLowerCase()
            fenceLines = []
            continue
        }
        if (/^\s*$/.test(line)) {
            flushParagraph()
            flushList()
            continue
        }
        var heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
            flushParagraph()
            flushList()
            var level = heading[1].length
            output.push("<h" + level + ">" + renderInlineMarkdown(heading[2]) + "</h" + level + ">")
            continue
        }
        if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
            flushParagraph()
            flushList()
            output.push("<hr>")
            continue
        }
        if (/^\s*>/.test(line)) {
            flushParagraph()
            flushList()
            output.push("<blockquote>" + renderInlineMarkdown(line.replace(/^\s*>\s?/, "")) + "</blockquote>")
            continue
        }
        var ulItem = /^\s*[-*+]\s+(.*)$/.exec(line)
        var olItem = /^\s*\d+\.\s+(.*)$/.exec(line)
        if (ulItem !== null || olItem !== null) {
            flushParagraph()
            var isOrdered = olItem !== null
            var itemText = isOrdered ? olItem[1] : ulItem[1]
            if (list === null || list.ordered !== isOrdered) {
                flushList()
                list = { ordered: isOrdered, items: [] }
            }
            var taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemText)
            if (taskMatch !== null) {
                var checked = taskMatch[1] !== " "
                list.items.push((checked ? "☑ " : "☐ ") + taskMatch[2])
            } else {
                list.items.push(itemText)
            }
            continue
        }
        if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]+\|/.test(lines[index + 1] || "")) {
            flushParagraph()
            flushList()
            var cells = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|")
            var table = "<table><thead><tr>" + cells.map(function (cell) {
                return "<th>" + renderInlineMarkdown(cell.trim()) + "</th>"
            }).join("") + "</tr></thead><tbody>"
            index += 2
            while (index < lines.length && /^\s*\|/.test(lines[index])) {
                var rowCells = lines[index].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|")
                table += "<tr>" + rowCells.map(function (cell) {
                    return "<td>" + renderInlineMarkdown(cell.trim()) + "</td>"
                }).join("") + "</tr>"
                index += 1
            }
            index -= 1
            table += "</tbody></table>"
            output.push('<div class="md-table-wrap">' + table + "</div>")
            continue
        }
        if (/^(\s*)\[[^\]]+\]:\s+\S+/.test(line)) continue
        paragraph.push(line.trim())
    }
    flushParagraph()
    flushList()
    if (fence !== null && fenceLines.length > 0) {
        output.push('<pre class="md-code"><code>' + escapeHtml(fenceLines.join("\n")) + "</code></pre>")
    }
    return output.join("\n")
}

/* ── 弹窗内容 ─────────────────────────────────────────────── */

function showShortcuts() {
    var table = el("div", "shortcut-table")
    var shortcuts = [
        ["Ctrl+P", "快速打开文件"],
        ["Ctrl+Shift+P", "命令面板"],
        ["Ctrl+S", "保存当前文件"],
        ["Ctrl+Shift+S", "全部保存"],
        ["Ctrl+F", "在文件中查找"],
        ["Ctrl+G", "转到行"],
        ["Ctrl+B", "切换侧边栏"],
        ["Ctrl+W", "关闭编辑器"],
        ["Ctrl+Tab", "切换到下一个编辑器"],
        ["Ctrl+Shift+E", "资源管理器"],
        ["Ctrl+Shift+F", "搜索"],
        ["Ctrl+Shift+V", "预览 Markdown"],
        ["Ctrl+N", "新建文件"],
        ["Esc", "关闭查找 / 菜单 / 弹窗"]
    ]
    shortcuts.forEach(function (item) {
        var row = el("div", "shortcut-row")
        row.appendChild(el("span", "shortcut-label", item[1]))
        row.appendChild(el("kbd", "", item[0]))
        table.appendChild(row)
    })
    openModalShell({
        title: "键盘快捷键",
        body: table,
        buttons: [{ label: "关闭", value: null, primary: true }]
    })
}

function showAbout() {
    var state = app.state || {}
    var host = state.host || {}
    var wrap = el("div", "about")
    var brand = el("div", "about-brand")
    brand.innerHTML = '<svg class="about-logo" aria-hidden="true"><use href="#i-logo"/></svg>'
    wrap.appendChild(brand)
    wrap.appendChild(el("p", "about-version", "Wellspring Code " + (state.version || "")))
    var workspace = app.workspace || {}
    var rows = [
        ["工作区", (workspace.name || "—") + (workspace.root ? " · " + workspace.root : "")],
        ["来源", workspace.source === "host" ? "Wellspring 宿主工作区注册表" : "服务进程当前目录"],
        ["服务目录", app.hostRoot || "—"],
        ["分支", state.branch || "—"],
        ["宿主", (host.platform || "unknown") + " " + (host.arch || "") + " · " + (host.node || "")],
        ["插件 API", String(state.apiVersion || "")],
        ["模式", state.readOnly === true ? "只读" : "可读写"]
    ]
    var table = el("dl", "about-table")
    rows.forEach(function (row) {
        var dt = el("dt", "", row[0])
        var dd = el("dd", "", row[1])
        table.appendChild(dt)
        table.appendChild(dd)
    })
    wrap.appendChild(table)
    wrap.appendChild(el("p", "about-hint", "工作区列表来自 Wellspring 宿主的注册表（名称、路径）；不读取其它插件的数据；文件读写被限制在当前工作区内。"))
    openModalShell({
        title: "关于 Wellspring Code",
        body: wrap,
        buttons: [{ label: "关闭", value: null, primary: true }]
    })
}

/* ── 外部修改轮询 ─────────────────────────────────────────── */

function startPolling() {
    if (app.pollTimer !== null) return
    app.pollTimer = setInterval(pollExternalChanges, POLL_INTERVAL)
}

function stopPolling() {
    if (app.pollTimer !== null) {
        clearInterval(app.pollTimer)
        app.pollTimer = null
    }
}

function pollExternalChanges() {
    if (document.hidden || app.readOnly === true || app.settings.poll !== true) return
    var tabs = app.tabs.filter(function (tab) {
        return tab.binary !== true
    })
    if (tabs.length === 0) return
    var query = tabs.map(function (tab) {
        return "path=" + enc(tab.path)
    }).join("&")
    apiGet("/api/stat?" + query).then(function (data) {
        if (!data.entries) return
        data.entries.forEach(function (entry) {
            if (entry === null || entry.exists !== true) return
            var tab = findTab(entry.path)
            if (tab === null || tab.binary === true) return
            if (Math.abs(entry.mtimeMs - tab.mtimeMs) <= 1) return
            if (tab.dirty === true) {
                if (tab.conflict !== true) {
                    tab.conflict = true
                    renderTabs()
                    toast(tab.name + " 已在磁盘上修改，保存前请先处理冲突", "warning")
                }
                return
            }
            apiGet("/api/file?path=" + enc(tab.path)).then(function (file) {
                if (file.binary === true) return
                tab.content = file.content
                tab.savedContent = file.content
                tab.mtimeMs = file.mtimeMs
                tab.size = file.size
                tab.eol = file.eol
                tab.indent = file.indent
                tab.dirty = false
                tab.conflict = false
                if (app.active === tab && tab.previewMode !== true) {
                    showEditorTab(tab)
                }
                renderTabs()
                toast("已重新加载 " + tab.name, "info", { duration: 2600 })
            }).catch(function () {
                /* 文件可能已被删除 */
            })
        })
    }).catch(function () {
        /* 轮询失败静默处理 */
    })
}

/* ── 初始化与事件绑定 ─────────────────────────────────────── */

function bindWorkspacePicker() {
    var switcher = byId("workspace-switch")
    if (switcher !== null) switcher.addEventListener("click", openWorkspacePicker)
    var statusRoot = byId("status-root")
    if (statusRoot !== null) statusRoot.addEventListener("click", openWorkspacePicker)
    var addButton = byId("workspace-add")
    if (addButton !== null) addButton.addEventListener("click", addWorkspace)
    var quickAdd = byId("workspace-add-quick")
    if (quickAdd !== null) quickAdd.addEventListener("click", addWorkspace)
    var overlay = byId("workspace-overlay")
    if (overlay === null) return
    overlay.addEventListener("click", function (event) {
        if (event.target.dataset.close === "workspace") closeWorkspacePicker()
    })
    overlay.addEventListener("keydown", function (event) {
        var list = byId("workspace-list")
        if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            closeWorkspacePicker()
            return
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            moveListActive(list, event.key === "ArrowDown" ? 1 : -1)
            var items = list.querySelectorAll(".palette-item")
            var active = items[activeListIndex(list)]
            if (active !== undefined) active.focus()
            return
        }
        if (event.key === "Enter") {
            event.preventDefault()
            var target = app.workspaces[activeListIndex(list)]
            if (target !== undefined) requestSwitchWorkspace(target)
        }
    })
}

function bindChrome() {
    byId("btn-theme").addEventListener("click", toggleTheme)
    byId("status-theme").addEventListener("click", toggleTheme)
    var scmRefresh = byId("btn-refresh-scm")
    if (scmRefresh !== null) {
        scmRefresh.addEventListener("click", function () {
            loadScmStatus(true)
        })
    }
    var scmStageAll = byId("scm-stage-all")
    if (scmStageAll !== null) {
        scmStageAll.addEventListener("click", function () {
            stageScmPaths(
                app.scm.changes
                    .filter(function (change) { return change.staged !== true })
                    .map(function (change) { return change.path }),
                false
            )
        })
    }
    var scmUnstageAll = byId("scm-unstage-all")
    if (scmUnstageAll !== null) {
        scmUnstageAll.addEventListener("click", function () {
            stageScmPaths(
                app.scm.changes
                    .filter(function (change) { return change.staged === true })
                    .map(function (change) { return change.path }),
                true
            )
        })
    }
    window.addEventListener("focus", function () {
        if (app.view === "scm") loadScmStatus(false)
    })
    byId("btn-about").addEventListener("click", showAbout)
    byId("activity-about").addEventListener("click", showAbout)
    byId("quickopen-trigger").addEventListener("click", openQuickOpen)
    byId("status-cursor").addEventListener("click", openGoto)
    bindWorkspacePicker()
    byId("status-branch").addEventListener("click", function () {
        if (app.state && app.state.branch) copyText(app.state.branch)
    })
    byId("status-indent").addEventListener("click", function () {
        setView("settings")
    })
    byId("status-language").addEventListener("click", function () {
        if (app.active !== null) toast(app.active.label + " · " + app.active.path, "info")
    })
    byId("status-diagnostics").addEventListener("click", function () {
        setView("problems")
    })
    byId("diff-close").addEventListener("click", closeDiffTab)
    byId("diff-open-file").addEventListener("click", function () {
        if (app.active !== null && app.active.diff === true) openFile(app.active.diffPath)
    })
    byId("diff-refresh").addEventListener("click", refreshDiffTab)
    byId("btn-clear-search").addEventListener("click", function () {
        byId("search-input").value = ""
        clear(byId("search-results"))
        setText("search-status", "输入内容后按 Enter 搜索")
    })
    var activities = document.querySelectorAll(".activity")
    for (var index = 0; index < activities.length; index += 1) {
        activities[index].addEventListener("click", function (event) {
            var view = event.currentTarget.dataset.view
            if (view === undefined) return
            if (app.view === view && app.sidebarVisible === true) {
                toggleSidebar(false)
                return
            }
            setView(view)
        })
    }
    var menuButtons = document.querySelectorAll(".menubar-item")
    for (var menuIndex = 0; menuIndex < menuButtons.length; menuIndex += 1) {
        menuButtons[menuIndex].addEventListener("click", function (event) {
            event.stopPropagation()
            var button = event.currentTarget
            openMenu(button.dataset.menu, button)
        })
    }
    document.addEventListener("click", function (event) {
        if (event.target.closest(".menubar-item") === null && event.target.closest(".menu-popup") === null) {
            closeMenus()
        }
    })
    document.addEventListener("keydown", onGlobalKeydown)
    document.addEventListener("keydown", function (event) {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "k") {
            if (term.open !== true || activeTermSession() === null) return
            event.preventDefault()
            clearTerminal()
            focusTerminal()
        }
    })
    var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null
    if (media !== null) {
        var listener = function () {
            if (app.settings.theme === "system") applySettings()
        }
        if (typeof media.addEventListener === "function") media.addEventListener("change", listener)
        else if (typeof media.addListener === "function") media.addListener(listener)
    }
    window.addEventListener("beforeunload", function (event) {
        if (countDirty() > 0) {
            event.preventDefault()
            event.returnValue = "有未保存的文件"
            return "有未保存的文件"
        }
        return undefined
    })
    // 离开页面前把当前文件位置写回索引，刷新后可恢复
    window.addEventListener("pagehide", function () {
        if (app.active !== null) captureView()
    })
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden" && app.active !== null) captureView()
    })
    window.addEventListener("resize", function () {
        syncAppHeight()
        if (app.editor !== null) app.editor.redrawMinimap()
    })
    var resizer = byId("sidebar-resizer")
    if (resizer !== null) {
        var resizing = false
        resizer.addEventListener("pointerdown", function (event) {
            resizing = true
            resizer.setPointerCapture(event.pointerId)
            document.body.classList.add("is-resizing")
        })
        resizer.addEventListener("pointermove", function (event) {
            if (!resizing) return
            var width = Math.max(180, Math.min(520, event.clientX))
            document.documentElement.style.setProperty("--sidebar-width", width + "px")
        })
        var stopResize = function () {
            if (!resizing) return
            resizing = false
            document.body.classList.remove("is-resizing")
            saveJson(STORE_SIDEBAR, {
                visible: app.sidebarVisible,
                width: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10) || 280
            })
        }
        resizer.addEventListener("pointerup", stopResize)
        resizer.addEventListener("pointercancel", stopResize)
    }
    var savedSidebar = loadJson(STORE_SIDEBAR, null)
    if (savedSidebar !== null) {
        if (typeof savedSidebar.width === "number") {
            document.documentElement.style.setProperty("--sidebar-width", Math.max(180, Math.min(520, savedSidebar.width)) + "px")
        }
        if (savedSidebar.visible === false) toggleSidebar(false)
    } else if (window.innerWidth <= 760) {
        toggleSidebar(false)
    }
}

function bindExplorer() {
    byId("btn-new-file").addEventListener("click", function () { newFileIn(defaultParent()) })
    byId("btn-new-folder").addEventListener("click", function () { newFolderIn(defaultParent()) })
    byId("btn-refresh-tree").addEventListener("click", function () { reloadTree() })
    byId("btn-collapse-tree").addEventListener("click", function () {
        app.tree.expanded = {}
        saveExpanded()
        renderTree()
    })
    var tree = byId("tree")
    tree.addEventListener("keydown", function (event) {
        var rows = Array.prototype.slice.call(document.querySelectorAll(".tree-row"))
        var focused = document.activeElement
        var index = rows.indexOf(focused)
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            if (rows.length === 0) return
            var next = index === -1 ? 0 : index + (event.key === "ArrowDown" ? 1 : -1)
            next = Math.max(0, Math.min(rows.length - 1, next))
            rows[next].focus()
            selectTreePath(rows[next].dataset.path)
        } else if (event.key === "ArrowRight") {
            if (index === -1) return
            var current = rows[index]
            if (current.dataset.type === "directory" && app.tree.expanded[current.dataset.path] !== true) {
                event.preventDefault()
                toggleExpand(current.dataset.path)
            }
        } else if (event.key === "ArrowLeft") {
            if (index === -1) return
            var row = rows[index]
            if (row.dataset.type === "directory" && app.tree.expanded[row.dataset.path] === true) {
                event.preventDefault()
                toggleExpand(row.dataset.path)
            } else if (row.dataset.path !== "") {
                event.preventDefault()
                var parent = dirname(row.dataset.path)
                selectTreePath(parent)
                var parentRow = document.querySelector('.tree-row[data-path="' + cssEscape(parent) + '"]')
                if (parentRow !== null) parentRow.focus()
            }
        } else if (event.key === "Enter") {
            if (index !== -1) {
                event.preventDefault()
                rows[index].click()
            }
        } else if (event.key === "F2") {
            event.preventDefault()
            var target = app.tree.selected
            var entryRow = document.querySelector('.tree-row[data-path="' + cssEscape(target) + '"]')
            if (entryRow !== null && target !== "") {
                renameEntry({ path: target, name: basename(target), type: entryRow.dataset.type })
            }
        } else if (event.key === "Delete") {
            event.preventDefault()
            var deleteTarget = app.tree.selected
            var deleteRow = document.querySelector('.tree-row[data-path="' + cssEscape(deleteTarget) + '"]')
            if (deleteRow !== null && deleteTarget !== "") {
                deleteEntry({ path: deleteTarget, name: basename(deleteTarget), type: deleteRow.dataset.type })
            }
        }
    })
}

function bindSearch() {
    var input = byId("search-input")
    input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault()
            runTextSearch()
        }
    })
    input.addEventListener("input", function () {
        if (app.searchTimer !== null) clearTimeout(app.searchTimer)
        var value = input.value.trim()
        if (value.length < 2) return
        app.searchTimer = setTimeout(function () {
            runTextSearch()
        }, 420)
    })
    byId("search-case").addEventListener("click", function (event) {
        toggleSearchFlag("caseSensitive", event.currentTarget)
    })
    byId("search-regex").addEventListener("click", function (event) {
        toggleSearchFlag("regex", event.currentTarget)
    })
}

function bindSettings() {
    byId("setting-theme").addEventListener("change", function (event) {
        updateSetting("theme", event.currentTarget.value)
    })
    byId("setting-ui-font").addEventListener("change", function (event) {
        updateSetting("uiFontSize", Number(event.currentTarget.value))
    })
    byId("setting-font-size").addEventListener("change", function (event) {
        updateSetting("fontSize", clampNumber(event.currentTarget.value, 11, 22, 13))
        event.currentTarget.value = String(app.settings.fontSize)
    })
    byId("setting-tab-size").addEventListener("change", function (event) {
        updateSetting("tabSize", Number(event.currentTarget.value))
    })
    byId("setting-minimap").addEventListener("change", function (event) {
        updateSetting("minimap", event.currentTarget.checked)
    })
    byId("setting-breadcrumbs").addEventListener("change", function (event) {
        updateSetting("breadcrumbs", event.currentTarget.checked)
    })
    byId("setting-poll").addEventListener("change", function (event) {
        updateSetting("poll", event.currentTarget.checked)
    })
    byId("btn-reset-settings").addEventListener("click", function () {
        app.settings = {}
        Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
            app.settings[key] = DEFAULT_SETTINGS[key]
        })
        saveSettings()
        applySettings()
        toast("设置已重置", "info")
    })
    bindPasswordSettings()
}

function bindTabs() {
    var bar = byId("tab-bar")
    bar.addEventListener("wheel", function (event) {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            bar.scrollLeft += event.deltaY
            event.preventDefault()
        }
    }, { passive: false })
    byId("preview-close").addEventListener("click", closePreview)
    byId("preview-download").addEventListener("click", function () {
        if (app.active === null) return
        window.location.href = "/api/raw?path=" + enc(app.active.path) + "&download=1"
    })
}

function bindPalette() {
    var input = byId("palette-input")
    input.addEventListener("input", function () {
        if (app.paletteMode === "commands") {
            renderCommandPalette(input.value.trim())
        } else {
            setText("palette-foot", input.value.trim() === "" ? "输入行号后按 Enter 跳转" : "Enter 跳到第 " + input.value.trim() + " 行")
        }
    })
    input.addEventListener("keydown", function (event) {
        var list = byId("palette-list")
        if (event.key === "Escape") {
            event.preventDefault()
            closePalette()
            return
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            if (app.paletteMode === "commands") moveListActive(list, event.key === "ArrowDown" ? 1 : -1)
            return
        }
        if (event.key === "Enter") {
            event.preventDefault()
            if (app.paletteMode === "goto") {
                var line = parseInt(input.value.trim().replace(/^:/, ""), 10)
                closePalette()
                if (isFinite(line) && line > 0) {
                    if (app.active === null) {
                        toast("没有打开的编辑器", "warning")
                        return
                    }
                    if (app.active.previewMode === true) {
                        app.active.previewMode = false
                        showEditorTab(app.active)
                    }
                    app.editor.revealLine(line, 1)
                }
                return
            }
            var index = activeListIndex(list)
            var command = app.paletteItems[index]
            if (command !== undefined) {
                closePalette()
                executeCommand(command.id)
            }
        }
    })
    byId("palette-overlay").addEventListener("click", function (event) {
        if (event.target.dataset.close === "palette") closePalette()
    })

    var quickInput = byId("quickopen-input")
    quickInput.addEventListener("input", function () {
        renderQuickOpen(quickInput.value.trim())
    })
    quickInput.addEventListener("keydown", function (event) {
        var list = byId("quickopen-list")
        if (event.key === "Escape") {
            event.preventDefault()
            closeQuickOpen()
            return
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            moveListActive(list, event.key === "ArrowDown" ? 1 : -1)
            return
        }
        if (event.key === "Enter") {
            event.preventDefault()
            var entry = app.quickItems[activeListIndex(list)]
            if (entry !== undefined) {
                closeQuickOpen()
                if (app.quickMode === "symbols" || app.quickMode === "workspace-symbols") jumpToSymbol(entry)
                else openFile(entry.path)
            }
        }
    })
    byId("quickopen-overlay").addEventListener("click", function (event) {
        if (event.target.dataset.close === "quickopen") closeQuickOpen()
    })
}

function bindWelcome() {
    var buttons = document.querySelectorAll("[data-command]")
    for (var index = 0; index < buttons.length; index += 1) {
        buttons[index].addEventListener("click", function (event) {
            var id = event.currentTarget.dataset.command
            if (id !== undefined) executeCommand(id)
        })
    }
}

function editorFocusSoon() {
    if (
        app.active === null ||
        app.active.binary === true ||
        app.active.previewMode === true ||
        app.active.diff === true
    ) {
        return
    }
    setTimeout(function () {
        if (app.active === null || app.active.binary === true || app.active.previewMode === true || app.active.diff === true) {
            return
        }
        app.editor.focus()
        if (app.active.view !== null && app.active.view !== undefined) {
            app.editor.setView(app.active.view)
        }
    }, 10)
}

function bindAuth(state) {
    var input = byId("auth-password")
    var form = byId("auth-form")
    if (state !== "login" || input === null || form === null) {
        return
    }
    input.focus()
    form.addEventListener("submit", function (event) {
        event.preventDefault()
        submitLogin(input)
    })
}

function submitLogin(input) {
    var errorNode = byId("auth-error")
    var submit = byId("auth-submit")
    function showError(message) {
        if (errorNode === null) return
        errorNode.hidden = false
        errorNode.textContent = message
    }
    var password = input.value
    if (password === "") {
        showError("请输入访问密码")
        return
    }
    if (errorNode !== null) errorNode.hidden = true
    if (submit !== null) {
        submit.disabled = true
        submit.textContent = "登录中…"
    }
    fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: password })
    })
        .then(function (response) {
            return response
                .json()
                .catch(function () {
                    return {}
                })
                .then(function (data) {
                    if (response.ok) {
                        window.location.reload()
                        return
                    }
                    showError(data && data.error ? data.error : "登录失败（" + response.status + "）")
                    if (submit !== null) {
                        submit.disabled = false
                        submit.textContent = "进入"
                    }
                    input.select()
                })
        })
        .catch(function (error) {
            showError("无法连接服务器：" + error.message)
            if (submit !== null) {
                submit.disabled = false
                submit.textContent = "进入"
            }
        })
}

function bindPasswordSettings() {
    var save = byId("password-save")
    if (save === null) return
    var current = byId("password-current")
    var next = byId("password-new")
    var confirm = byId("password-confirm")
    var stateNode = byId("password-state")
    var messageNode = byId("password-message")
    var logout = byId("password-logout")
    var currentRow = byId("password-current-row")

    function setMessage(text) {
        if (messageNode === null) return
        messageNode.hidden = text === ""
        messageNode.textContent = text
    }

    function setConfigured(configured) {
        app.authConfigured = configured
        document.body.setAttribute("data-auth-configured", configured ? "true" : "false")
        if (stateNode !== null) {
            stateNode.textContent = configured
                ? "已设置：远程访问需要登录；改完 host 与 TLS 后重启生效"
                : "未设置：远程访问前需要先设置"
        }
        if (currentRow !== null) currentRow.hidden = !configured
        if (logout !== null) logout.hidden = !configured
    }

    setConfigured(app.authConfigured)

    save.addEventListener("click", function () {
        var newPassword = next.value
        var confirmPassword = confirm.value
        if (newPassword.length < 6) {
            setMessage("密码至少 6 位")
            next.focus()
            return
        }
        if (newPassword !== confirmPassword) {
            setMessage("两次输入的新密码不一致")
            confirm.focus()
            return
        }
        save.disabled = true
        apiSend("/api/auth/password", "POST", {
            currentPassword: current.value,
            newPassword: newPassword
        })
            .then(function () {
                setConfigured(true)
                current.value = ""
                next.value = ""
                confirm.value = ""
                setMessage("已更新，其它设备需要重新登录")
                toast("访问密码已更新", "info")
            })
            .catch(function (error) {
                setMessage(error.message)
            })
            .then(function () {
                save.disabled = false
            })
    })

    if (logout !== null) {
        logout.addEventListener("click", function () {
            apiSend("/api/auth/logout", "POST", {})
                .catch(function () {
                    /* 会话可能已经失效，直接刷新回到登录页 */
                })
                .then(function () {
                    window.location.reload()
                })
        })
    }
}

function boot() {
    app.settings = loadSettings()
    applySettings()
    syncAppHeight()
    if (window.visualViewport !== null && typeof window.visualViewport.addEventListener === "function") {
        window.visualViewport.addEventListener("resize", syncAppHeight)
    }
    window.addEventListener("orientationchange", function () {
        window.setTimeout(syncAppHeight, 120)
    })
    app.authConfigured = document.body.getAttribute("data-auth-configured") === "true"
    var authState = document.body.getAttribute("data-auth-state") || "none"
    if (authState !== "none") {
        bindAuth(authState)
        return
    }
    app.editor = createEditor({
        onChange: function (value) {
            if (app.active === null) return
            app.active.content = value
            var dirty = value !== app.active.savedContent
            if (dirty !== app.active.dirty) {
                app.active.dirty = dirty
                renderTabs()
            }
            var composing = typeof app.editor.isComposing === "function" && app.editor.isComposing() === true
            if (app.view === "outline" && !composing) scheduleOutline()
            if (!composing) scheduleDiagnostics()
        },
        onViewChange: function () {
            scheduleRememberView()
        },
        onSave: function () {
            saveActive()
        },
        onDefinition: goToDefinition,
        onStatus: updateCursorStatus
    })
    app.editor.setSettings(app.settings)
    bindChrome()
    bindTerminal()
    bindExplorer()
    bindSearch()
    bindSettings()
    bindTabs()
    bindPalette()
    bindWelcome()
    restoreTermSessions()
    loadWorkspace()
        .then(function () {
            return restoreSession()
        })
        .then(function () {
            setView("explorer", false, true)
            showWelcomeIfEmpty()
            announce("Wellspring Code 已就绪")
            loadScmStatus(false)
        })
        .catch(function (error) {
            toast("初始化失败：" + error.message, "error", { duration: 12000 })
        })
}

function showWelcomeIfEmpty() {
    if (app.tabs.length === 0) showWelcome()
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot)
} else {
    boot()
}
`
