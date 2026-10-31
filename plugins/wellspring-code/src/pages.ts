/*
 * 页面外壳。脚本与样式作为独立静态资源加载，HTML 里不出现内联 style/script，
 * 以便服务端下发严格 CSP。
 */

import { ICON_SPRITE } from "./assets/icons.ts"

const SPRITE = ICON_SPRITE

const MENUBAR = `<nav class="menubar" id="menubar" aria-label="菜单">
        <button class="menubar-item" type="button" data-menu="file">文件</button>
        <button class="menubar-item" type="button" data-menu="edit">编辑</button>
        <button class="menubar-item" type="button" data-menu="view">查看</button>
        <button class="menubar-item" type="button" data-menu="go">转到</button>
        <button class="menubar-item" type="button" data-menu="help">帮助</button>
      </nav>`

const ACTIVITY_BAR = `<nav class="activitybar" aria-label="活动栏">
      <div class="activity-group">
        <button class="activity is-active" type="button" data-view="explorer" aria-label="资源管理器" title="资源管理器 (Ctrl+Shift+E)">
          <svg class="icon" aria-hidden="true"><use href="#i-files"/></svg>
          <span class="activity-badge" id="explorer-badge" hidden></span>
        </button>
        <button class="activity" type="button" data-view="search" aria-label="搜索" title="搜索 (Ctrl+Shift+F)">
          <svg class="icon" aria-hidden="true"><use href="#i-search"/></svg>
        </button>
        <button class="activity" type="button" data-view="scm" aria-label="源码管理" title="源码管理（只读）">
          <svg class="icon" aria-hidden="true"><use href="#i-git-branch"/></svg>
          <span class="activity-badge" id="scm-badge" hidden></span>
        </button>
        <button class="activity" type="button" data-view="outline" aria-label="大纲" title="大纲">
          <svg class="icon" aria-hidden="true"><use href="#i-outline"/></svg>
        </button>
        <button class="activity" type="button" data-view="problems" aria-label="问题" title="语法问题">
          <svg class="icon" aria-hidden="true"><use href="#i-warning"/></svg>
          <span class="activity-badge" id="problems-badge" hidden></span>
        </button>
      </div>
      <div class="activity-group activity-bottom">
        <button class="activity" type="button" id="activity-terminal" aria-label="控制台" title="控制台 (Ctrl+Backquote)">
          <svg class="icon" aria-hidden="true"><use href="#i-terminal"/></svg>
        </button>
        <button class="activity" type="button" data-view="settings" aria-label="设置" title="设置">
          <svg class="icon" aria-hidden="true"><use href="#i-settings"/></svg>
        </button>
        <button class="activity" type="button" id="activity-about" aria-label="关于" title="关于 Wellspring Code">
          <svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>
        </button>
      </div>
    </nav>`

const SIDEBAR = `<aside class="sidebar" id="sidebar" aria-label="侧边栏">
      <div class="sidebar-resizer" id="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整侧边栏宽度" tabindex="-1"></div>

      <section class="sidebar-view" data-panel="explorer" aria-label="资源管理器">
        <header class="sidebar-head">
          <h2>资源管理器</h2>
          <div class="sidebar-actions">
            <button class="icon-btn sm" type="button" id="btn-new-file" title="新建文件 (Ctrl+N)" aria-label="新建文件"><svg class="icon" aria-hidden="true"><use href="#i-new-file"/></svg></button>
            <button class="icon-btn sm" type="button" id="btn-new-folder" title="新建文件夹" aria-label="新建文件夹"><svg class="icon" aria-hidden="true"><use href="#i-new-folder"/></svg></button>
            <button class="icon-btn sm" type="button" id="btn-refresh-tree" title="刷新" aria-label="刷新"><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg></button>
            <button class="icon-btn sm" type="button" id="btn-collapse-tree" title="全部折叠" aria-label="全部折叠"><svg class="icon" aria-hidden="true"><use href="#i-collapse"/></svg></button>
          </div>
        </header>
        <button class="workspace-caption" type="button" id="workspace-switch" title="切换工作区（Wellspring 工作区）" aria-haspopup="dialog">
          <span class="workspace-caption-text">
            <span class="workspace-name" id="workspace-name">工作区</span>
            <span class="workspace-path" id="workspace-path"></span>
          </span>
          <span class="workspace-chevron" aria-hidden="true"><svg class="icon icon-xs"><use href="#i-chevron-down"/></svg></span>
        </button>
        <div class="tree" id="tree" role="tree" aria-label="文件树" tabindex="0"></div>
      </section>

      <section class="sidebar-view" data-panel="scm" hidden aria-label="源码管理">
        <header class="sidebar-head">
          <h2>源码管理</h2>
          <div class="sidebar-actions">
            <button class="text-btn" type="button" id="scm-stage-all" title="全部暂存" hidden>全部暂存</button>
            <button class="text-btn" type="button" id="scm-unstage-all" title="全部取消暂存" hidden>全部取消</button>
            <button class="icon-btn sm" type="button" id="btn-refresh-scm" title="刷新" aria-label="刷新源码管理"><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg></button>
          </div>
        </header>
        <div class="scm" id="scm-panel">
          <div class="scm-branch">
            <svg class="icon icon-sm" aria-hidden="true"><use href="#i-git-branch"/></svg>
            <span class="scm-branch-name" id="scm-branch">—</span>
            <span class="scm-sync" id="scm-sync" hidden></span>
          </div>
          <p class="sidebar-hint" id="scm-hint" hidden></p>
          <div class="scm-groups" id="scm-groups"></div>
          <p class="sidebar-empty" id="scm-empty" hidden>没有更改</p>
        </div>
      </section>

      <section class="sidebar-view" data-panel="search" hidden aria-label="搜索">
        <header class="sidebar-head">
          <h2>搜索</h2>
          <div class="sidebar-actions">
            <button class="icon-btn sm" type="button" id="btn-clear-search" title="清空" aria-label="清空搜索"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
          </div>
        </header>
        <div class="search-form">
          <div class="field-inline">
            <input class="input" id="search-input" type="text" placeholder="搜索内容" autocomplete="off" spellcheck="false" aria-label="搜索内容">
            <button class="toggle-btn" type="button" id="search-case" aria-pressed="false" title="区分大小写">Aa</button>
            <button class="toggle-btn" type="button" id="search-regex" aria-pressed="false" title="使用正则表达式">.*</button>
          </div>
          <p class="search-status" id="search-status" role="status" aria-live="polite">输入内容后按 Enter 搜索</p>
        </div>
        <div class="search-results" id="search-results"></div>
      </section>

      <section class="sidebar-view" data-panel="outline" hidden aria-label="大纲">
        <header class="sidebar-head">
          <h2>大纲</h2>
          <span class="sidebar-hint" id="outline-file"></span>
        </header>
        <div class="outline-list" id="outline-list" role="tree" aria-label="符号列表"></div>
        <p class="sidebar-empty" id="outline-empty">当前文件没有可展示的符号</p>
      </section>

      <section class="sidebar-view" data-panel="problems" hidden aria-label="问题">
        <header class="sidebar-head">
          <h2>问题</h2>
          <span class="sidebar-hint" id="problems-file"></span>
        </header>
        <div class="problems" id="problems-list" role="list" aria-label="语法问题"></div>
        <p class="sidebar-empty" id="problems-empty">当前文件没有语法问题</p>
      </section>

      <section class="sidebar-view" data-panel="settings" hidden aria-label="设置">
        <header class="sidebar-head">
          <h2>设置</h2>
          <div class="sidebar-actions"><button class="text-btn" type="button" id="btn-reset-settings">重置</button></div>
        </header>
        <div class="settings">
          <label class="setting"><span>主题</span>
            <select class="select input-sm" id="setting-theme">
              <option value="system">跟随系统</option>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
          <label class="setting"><span>界面字号</span>
            <select class="select input-sm" id="setting-ui-font">
              <option value="0.875">紧凑</option>
              <option value="1">默认</option>
              <option value="1.125">较大</option>
              <option value="1.25">大</option>
            </select>
          </label>
          <label class="setting"><span>代码字号</span>
            <input class="input input-sm" id="setting-font-size" type="number" min="11" max="22" step="1">
          </label>
          <label class="setting"><span>Tab 宽度</span>
            <select class="select input-sm" id="setting-tab-size">
              <option value="2">2</option>
              <option value="4">4</option>
              <option value="8">8</option>
            </select>
          </label>
          <label class="setting setting-check"><input id="setting-minimap" type="checkbox"><span>显示缩略图</span></label>
          <label class="setting setting-check"><input id="setting-breadcrumbs" type="checkbox"><span>显示面包屑</span></label>
          <label class="setting setting-check"><input id="setting-poll" type="checkbox"><span>检测磁盘上的外部修改</span></label>
          <div class="settings-group">
            <p class="settings-title">访问密码</p>
            <p class="sidebar-hint" id="password-state">未设置：远程访问前需要先设置</p>
            <label class="setting setting-stack" id="password-current-row"><span>当前密码</span>
              <input class="input input-sm" id="password-current" type="password" autocomplete="current-password">
            </label>
            <label class="setting setting-stack"><span>新密码</span>
              <input class="input input-sm" id="password-new" type="password" autocomplete="new-password">
            </label>
            <label class="setting setting-stack"><span>确认新密码</span>
              <input class="input input-sm" id="password-confirm" type="password" autocomplete="new-password">
            </label>
            <div class="settings-row">
              <button class="btn btn-primary" type="button" id="password-save">保存密码</button>
              <button class="text-btn" type="button" id="password-logout" hidden>退出登录</button>
            </div>
            <p class="sidebar-hint" id="password-message" hidden></p>
          </div>
          <div class="settings-foot">
            <p class="sidebar-hint">设置保存在浏览器 localStorage，按设备生效。</p>
            <p class="sidebar-hint" id="settings-root"></p>
          </div>
        </div>
      </section>
    </aside>`

const WELCOME = `<section class="welcome" id="welcome">
          <div class="welcome-inner">
            <div class="welcome-brand">
              <svg class="welcome-logo" aria-hidden="true"><use href="#i-logo"/></svg>
              <div>
                <h1>Wellspring Code</h1>
                <p class="welcome-sub">浏览器里的 VS Code 风格编辑器</p>
              </div>
            </div>
            <div class="welcome-grid">
              <div class="welcome-card">
                <h2>开始</h2>
                <button class="link-row" type="button" data-command="quick-open"><span>打开文件</span><kbd>Ctrl P</kbd></button>
                <button class="link-row" type="button" data-command="palette"><span>命令面板</span><kbd>Ctrl Shift P</kbd></button>
                <button class="link-row" type="button" data-command="new-file"><span>新建文件</span><kbd>Ctrl N</kbd></button>
                <button class="link-row" type="button" data-command="workspace-switch"><span>切换工作区…</span><kbd></kbd></button>
                <button class="link-row" type="button" data-command="toggle-theme"><span>切换主题</span><kbd></kbd></button>
              </div>
              <div class="welcome-card">
                <h2>快捷键</h2>
                <div class="kv"><span>保存</span><kbd>Ctrl S</kbd></div>
                <div class="kv"><span>在文件中查找</span><kbd>Ctrl F</kbd></div>
                <div class="kv"><span>替换</span><kbd>Ctrl H</kbd></div>
                <div class="kv"><span>转到行</span><kbd>Ctrl G</kbd></div>
                <div class="kv"><span>关闭编辑器</span><kbd>Ctrl W</kbd></div>
                <div class="kv"><span>切换侧边栏</span><kbd>Ctrl B</kbd></div>
              </div>
              <div class="welcome-card welcome-recent">
                <h2>最近打开</h2>
                <div class="recent-list" id="recent-list"></div>
              </div>
            </div>
            <p class="welcome-foot" id="welcome-root"></p>
          </div>
        </section>`

const EDITOR = `<section class="editor" id="editor" hidden>
          <div class="find-bar" id="find-bar" hidden>
            <div class="find-row">
              <div class="find-input-wrap">
                <svg class="icon" aria-hidden="true"><use href="#i-search"/></svg>
                <input class="input input-sm" id="find-input" type="text" placeholder="在文件中查找" autocomplete="off" spellcheck="false" aria-label="在文件中查找">
              </div>
              <span class="find-count" id="find-count">0/0</span>
              <button class="icon-btn sm" type="button" id="find-toggle-replace" title="替换 (Ctrl+H)" aria-label="显示替换" aria-expanded="false"><svg class="icon" aria-hidden="true"><use href="#i-chevron-right"/></svg></button>
              <button class="icon-btn sm" type="button" id="find-prev" title="上一个匹配 (Shift+Enter)" aria-label="上一个匹配"><svg class="icon" aria-hidden="true"><use href="#i-arrow-up"/></svg></button>
              <button class="icon-btn sm" type="button" id="find-next" title="下一个匹配 (Enter)" aria-label="下一个匹配"><svg class="icon" aria-hidden="true"><use href="#i-arrow-down"/></svg></button>
              <button class="icon-btn sm" type="button" id="find-close" title="关闭 (Esc)" aria-label="关闭查找"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
            </div>
            <div class="find-row find-replace-row" id="find-replace-row" hidden>
              <div class="find-input-wrap">
                <svg class="icon" aria-hidden="true"><use href="#i-pencil"/></svg>
                <input class="input input-sm" id="replace-input" type="text" placeholder="替换为" autocomplete="off" spellcheck="false" aria-label="替换为">
              </div>
              <button class="text-btn" type="button" id="replace-one" title="替换当前 (Ctrl+Enter)">替换</button>
              <button class="text-btn" type="button" id="replace-all" title="全部替换">全部替换</button>
            </div>
          </div>
          <div class="editor-body">
            <div class="gutter" id="gutter" aria-hidden="true"><pre class="gutter-text" id="gutter-text"></pre></div>
            <div class="code-view" id="code-view">
              <div class="active-line" id="active-line"></div>
              <pre class="code-layer" id="code-highlight" aria-hidden="true"></pre>
              <textarea class="code-input" id="code-input" spellcheck="false" wrap="off" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="代码编辑器" aria-autocomplete="list" aria-controls="autocomplete" aria-expanded="false"></textarea>
              <div class="autocomplete" id="autocomplete" role="listbox" aria-label="代码补全" hidden>
                <ul class="autocomplete-list" id="autocomplete-list" role="presentation"></ul>
                <p class="autocomplete-foot"><kbd>Tab</kbd> / <kbd>Enter</kbd> 补全 · <kbd>Esc</kbd> 关闭</p>
              </div>
            </div>
            <canvas class="minimap" id="minimap" aria-hidden="true"></canvas>
          </div>
        </section>

        <section class="preview" id="preview" hidden>
          <div class="preview-bar">
            <span class="preview-title" id="preview-title"></span>
            <div class="preview-actions">
              <button class="text-btn" type="button" id="preview-download">下载</button>
              <button class="icon-btn sm" type="button" id="preview-close" title="关闭" aria-label="关闭预览"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
            </div>
          </div>
          <div class="preview-body" id="preview-body"></div>
        </section>

        <section class="diff-view" id="diff-view" hidden aria-label="差异比较">
          <div class="diff-view-bar">
            <span class="diff-view-title" id="diff-view-title"></span>
            <span class="diff-view-mode" id="diff-view-mode"></span>
            <div class="diff-view-actions">
              <button class="text-btn" type="button" id="diff-open-file">打开文件</button>
              <button class="text-btn" type="button" id="diff-refresh">刷新</button>
              <button class="icon-btn sm" type="button" id="diff-close" title="关闭差异" aria-label="关闭差异"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
            </div>
          </div>
          <div class="diff-view-body" id="diff-view-body"></div>
        </section>`

const TERMINAL = `<section class="terminal" id="terminal" hidden aria-label="终端">
        <div class="terminal-resizer" id="terminal-resizer" role="separator" aria-orientation="horizontal" aria-label="拖动调整终端高度" title="拖动调整终端高度（双击复位，聚焦后可用方向键）" tabindex="0"></div>
        <div class="terminal-bar">
          <div class="terminal-tabs" id="terminal-tabs" role="tablist" aria-label="终端会话"></div>
          <div class="terminal-actions">
            <span class="terminal-cwd" id="terminal-cwd" title="工作目录"></span>
            <button class="icon-btn sm" type="button" id="terminal-new" title="新建控制台" aria-label="新建控制台"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg></button>
            <button class="icon-btn sm" type="button" id="terminal-clear" title="关闭当前终端（移除标签）" aria-label="关闭当前终端"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
            <button class="icon-btn sm" type="button" id="terminal-close" title="隐藏终端面板 (Ctrl+Backquote)，会话保留" aria-label="隐藏终端面板"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
          </div>
        </div>
        <div class="terminal-view" id="terminal-view">
          <div class="terminal-body" id="terminal-output" role="log" aria-live="polite" tabindex="0"></div>
          <div class="terminal-scrollbar" id="terminal-scrollbar" hidden>
            <div class="terminal-scrollbar-thumb" id="terminal-scrollbar-thumb"></div>
          </div>
          <button class="terminal-jump" id="terminal-jump" type="button" title="回到底部，继续跟随新输出" aria-label="回到底部" hidden>↓</button>
          <textarea class="terminal-capture" id="terminal-capture" rows="1" tabindex="-1" inputmode="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="enter" aria-label="终端键盘输入"></textarea>
        </div>
        <form class="terminal-input-row" id="terminal-form">
          <span class="terminal-prompt" id="terminal-prompt" aria-hidden="true">$</span>
          <input class="terminal-input" id="terminal-input" type="text" placeholder="输入命令，Enter 执行" autocomplete="off" spellcheck="false" aria-label="终端命令">
        </form>
      </section>`

const STATUS_BAR = `<footer class="statusbar" aria-label="状态栏">
      <div class="status-left">
        <button class="status-item" type="button" id="status-branch" title="Git 分支">
          <svg class="icon" aria-hidden="true"><use href="#i-git-branch"/></svg>
          <span id="branch-name">—</span>
        </button>
        <button class="status-item" type="button" id="status-remote" title="Wellspring 插件">
          <svg class="icon" aria-hidden="true"><use href="#i-logo"/></svg>
          <span>Wellspring</span>
        </button>
        <button class="status-item status-muted" type="button" id="status-root" title="切换工作区"></button>
      </div>
      <div class="status-right">
        <button class="status-item" type="button" id="status-diagnostics" title="语法问题" hidden>
          <svg class="icon" aria-hidden="true"><use href="#i-warning"/></svg>
          <span id="diagnostics-count">0</span>
        </button>
        <button class="status-item" type="button" id="status-readonly" hidden>只读</button>
        <button class="status-item" type="button" id="status-cursor" title="转到行 (Ctrl+G)"><span id="cursor-pos">Ln 1, Col 1</span></button>
        <button class="status-item" type="button" id="status-selection" hidden><span id="selection-pos"></span></button>
        <button class="status-item" type="button" id="status-indent"><span id="indent-label">空格: 4</span></button>
        <button class="status-item" type="button" id="status-eol"><span id="eol-label">LF</span></button>
        <button class="status-item" type="button" id="status-encoding">UTF-8</button>
        <button class="status-item" type="button" id="status-language"><span id="language-label">纯文本</span></button>
        <button class="status-item" type="button" id="status-theme" title="切换主题" aria-label="切换主题">
          <svg class="icon" aria-hidden="true"><use id="status-theme-icon" href="#i-sun"/></svg>
        </button>
      </div>
    </footer>`

const OVERLAYS = `<div class="overlay" id="workspace-overlay" hidden>
      <div class="overlay-backdrop" data-close="workspace"></div>
      <div class="palette workspace-palette" role="dialog" aria-modal="true" aria-label="切换工作区">
        <div class="palette-input-row workspace-palette-head">
          <span class="palette-prefix" aria-hidden="true">◈</span>
          <span class="workspace-palette-title">切换工作区</span>
          <kbd>Esc</kbd>
        </div>
        <ul class="palette-list" id="workspace-list" role="listbox" aria-label="工作区列表"></ul>
        <p class="palette-foot" id="workspace-foot"></p>
      </div>
    </div>

    <div class="overlay" id="palette-overlay" hidden>
      <div class="overlay-backdrop" data-close="palette"></div>
      <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="palette-input-row">
          <span class="palette-prefix" aria-hidden="true">&gt;</span>
          <input class="palette-input" id="palette-input" type="text" placeholder="输入命令名" autocomplete="off" spellcheck="false" aria-label="命令">
        </div>
        <ul class="palette-list" id="palette-list" role="listbox" aria-label="命令列表"></ul>
        <p class="palette-foot" id="palette-foot"></p>
      </div>
    </div>

    <div class="overlay" id="quickopen-overlay" hidden>
      <div class="overlay-backdrop" data-close="quickopen"></div>
      <div class="palette" role="dialog" aria-modal="true" aria-label="快速打开文件">
        <div class="palette-input-row">
          <span class="palette-prefix" aria-hidden="true">⌕</span>
          <input class="palette-input" id="quickopen-input" type="text" placeholder="按文件名搜索，Enter 打开" autocomplete="off" spellcheck="false" aria-label="搜索文件">
        </div>
        <ul class="palette-list" id="quickopen-list" role="listbox" aria-label="文件列表"></ul>
        <p class="palette-foot" id="quickopen-foot"></p>
      </div>
    </div>

    <div class="context-menu" id="context-menu" role="menu" hidden></div>

    <div class="modal-backdrop" id="modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 class="modal-title" id="modal-title"></h2>
        <div class="modal-body" id="modal-body"></div>
        <div class="modal-actions" id="modal-actions"></div>
      </div>
    </div>


    <div class="toasts" id="toasts" aria-live="polite"></div>
    <div class="sr-only" id="announcer" role="status" aria-live="polite"></div>`

const AUTH = (state: "none" | "login" | "blocked"): string => {
    if (state === "none") {
        return ""
    }
    const blocked = state === "blocked"
    return `<div class="auth" id="auth">
  <div class="auth-card" role="dialog" aria-labelledby="auth-title">
    <div class="auth-brand">
      <svg class="auth-logo" aria-hidden="true"><use href="#i-logo"/></svg>
      <span>Wellspring <b>Code</b></span>
    </div>
    <h1 class="auth-title" id="auth-title">${blocked ? "远程访问未启用" : "输入访问密码"}</h1>
    <p class="auth-hint" id="auth-hint">${
        blocked
            ? "还没有设置访问密码。请先在服务器本机打开本页面设置密码，或通过 SSH 端口转发访问本机地址。"
            : "使用本机设置的访问密码登录。"
    }</p>
    <form class="auth-form" id="auth-form"${blocked ? " hidden" : ""}>
      <label class="sr-only" for="auth-password">访问密码</label>
      <input class="input auth-input" id="auth-password" type="password" autocomplete="current-password" required>
      <p class="auth-error" id="auth-error" role="alert" hidden></p>
      <button class="btn btn-primary auth-submit" id="auth-submit" type="submit">进入</button>
    </form>
  </div>
</div>`
}

export interface HomeAuthState {
    /** none=直接进应用；login=要登录；blocked=远程访问但还没设密码 */
    readonly state: "none" | "login" | "blocked"
    readonly configured: boolean
}

export function renderHome(auth: HomeAuthState = { state: "none", configured: false }): string {
    const hidden = auth.state === "none" ? "" : " hidden"
    return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<meta name="color-scheme" content="dark light">
<meta name="description" content="Wellspring Code：浏览器里的 VS Code 风格代码编辑器">
<title>Wellspring Code</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css">
</head>
<body data-auth-state="${auth.state}" data-auth-configured="${auth.configured ? "true" : "false"}">
${SPRITE}
${AUTH(auth.state)}
<div class="workbench" id="workbench"${hidden}>
  <header class="titlebar">
    <div class="titlebar-left">
      <a class="brand" href="/" title="Wellspring Code">
        <svg class="brand-mark" aria-hidden="true"><use href="#i-logo"/></svg>
        <span class="brand-name">Wellspring <b>Code</b></span>
      </a>
      ${MENUBAR}
    </div>
    <button class="titlebar-center" type="button" id="quickopen-trigger" aria-label="搜索文件">
      <svg class="icon" aria-hidden="true"><use href="#i-search"/></svg>
      <span>搜索文件或运行命令</span>
      <kbd>Ctrl P</kbd>
    </button>
    <div class="titlebar-right">
      <button class="icon-btn" type="button" id="btn-theme" title="切换主题" aria-label="切换主题">
        <svg class="icon" aria-hidden="true"><use id="titlebar-theme-icon" href="#i-sun"/></svg>
      </button>
      <button class="icon-btn" type="button" id="btn-about" title="关于" aria-label="关于 Wellspring Code">
        <svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>
      </button>
    </div>
  </header>

  <div class="workbench-body">
    ${ACTIVITY_BAR}
    ${SIDEBAR}
    <main class="editor-area" id="editor-area">
      <div class="tabs" id="tab-bar" role="tablist" aria-label="打开的编辑器"></div>
      <div class="breadcrumbs" id="breadcrumbs" aria-label="面包屑"></div>
      <div class="editor-host" id="editor-host">
        ${WELCOME}
        ${EDITOR}
      </div>
      ${TERMINAL}
    </main>
  </div>

  ${STATUS_BAR}
</div>
${OVERLAYS}
<script src="/assets/app.js" defer></script>
</body>
</html>
`
}
