/*
 * Web 扩展（安装部分）：把上传的 `.vue` 单文件组件编译成同源 ES 模块。
 *
 * 内置扩展（plugins/wellspring-web/plugins/*.vue）由前端构建期打包；
 * 这里只负责网页上传的扩展：源码与编译产物写到插件数据目录，浏览器按需 import。
 * 编译在插件进程里用 @vue/compiler-sfc 完成，浏览器不需要 eval / new Function。
 */

import { createHash } from "node:crypto"

import type * as VueCompiler from "@vue/compiler-sfc"
import type { PluginApi } from "wellspring/api/host/index.ts"

const EXTENSIONS_DIR = "extensions"
const MANIFEST_FILE = `${EXTENSIONS_DIR}/index.json`
const BUILTIN_STATE_FILE = `${EXTENSIONS_DIR}/builtin-state.json`
const VUE_RUNTIME_URL = "/assets/app-vue.js"
const MAX_SOURCE_CHARS = 512 * 1024

export interface ExtensionItem {
    readonly id: string
    readonly name: string
    readonly source: "installed"
    readonly size: number
    readonly createdAt: number | null
    readonly moduleUrl: string
    readonly styleUrl: string | null
}

interface StoredExtension {
    readonly id: string
    readonly name: string
    readonly size: number
    readonly createdAt: number
}

interface Manifest {
    readonly version: 1
    readonly items: StoredExtension[]
}

interface CompiledExtension {
    readonly module: string
    readonly css: string
}

let api: PluginApi | null = null
/** 内置扩展文件只读，网页端「删除」实际是记到隐藏列表 */
const hiddenBuiltin = new Set<string>()
let compilerPromise: Promise<typeof VueCompiler> | null = null
const installed = new Map<string, StoredExtension>()
const compiled = new Map<string, CompiledExtension>()

/** 懒加载 SFC 编译器：没装 @vue/compiler-sfc 时网页本身仍能正常运行 */
function loadCompiler(): Promise<typeof VueCompiler> {
    compilerPromise ??= import(
        // 必须用纯浏览器构建：Node 条件入口会 require("fs")，而插件进程禁止直接访问 fs。
        "@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js"
    ) as Promise<typeof VueCompiler>
    return compilerPromise
}

function getApi(): PluginApi {
    if (api === null) {
        throw new Error("wellspring-web 扩展系统尚未初始化")
    }
    return api
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    if (error !== null && typeof error === "object" && "message" in error) {
        return String((error as { message: unknown }).message)
    }
    return String(error)
}

function slugOf(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/\.vue$/, "")
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
    return slug === "" ? "extension" : slug
}

function idOf(name: string, content: string): string {
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 8)
    return `${slugOf(name)}-${hash}`
}

function moduleUrlOf(id: string): string {
    return `/extensions/${encodeURIComponent(id)}.js`
}

function toItem(entry: StoredExtension): ExtensionItem {
    return {
        id: entry.id,
        name: entry.name,
        source: "installed",
        size: entry.size,
        createdAt: entry.createdAt,
        moduleUrl: moduleUrlOf(entry.id),
        styleUrl: `/extensions/${encodeURIComponent(entry.id)}.css`,
    }
}

/* ── 编译 ─────────────────────────────────────────────────── */

async function compileVue(filename: string, source: string): Promise<CompiledExtension> {
    const { compileScript, compileStyle, compileTemplate, parse } = await loadCompiler()
    if (source.length > MAX_SOURCE_CHARS) {
        throw new Error(`扩展源码超过 ${Math.floor(MAX_SOURCE_CHARS / 1024)}KB 上限`)
    }
    if (!/<template[\s>]/.test(source)) {
        throw new Error("扩展必须包含 <template>")
    }
    const { descriptor, errors } = parse(source, { filename })
    if (errors.length > 0) {
        throw new Error(`SFC 解析失败：${errors.map(errorText).join("；")}`)
    }
    const id = idOf(filename, source)
    const template = compileTemplate({
        source: descriptor.template?.content ?? "",
        filename,
        id,
        compilerOptions: { mode: "module" },
    })
    if (template.errors.length > 0) {
        throw new Error(`模板编译失败：${template.errors.map(errorText).join("；")}`)
    }
    let content = ""
    if (descriptor.scriptSetup !== null) {
        for (const line of descriptor.scriptSetup.content.split("\n")) {
            if (!/^\s*import\s+/.test(line)) continue
            if (!/from\s+["']vue["']/.test(line) && !/from\s+["']vue\//.test(line)) {
                throw new Error("扩展只能 import vue；其它依赖请在构建期打包")
            }
        }
        content = compileScript(descriptor, { id, inlineTemplate: true }).content
    } else if (descriptor.script !== null) {
        // 普通 <script>：命名导出照抄，模板单独编译后挂到默认组件上
        content = descriptor.script.content
        let defaultExpr: string | null = null
        if (/export\s+default\b/.test(content)) {
            defaultExpr = "__user_default__"
            content = content.replace(/export\s+default\b/, `const ${defaultExpr} =`)
        }
        content += `\n${template.code}\n`
        content += defaultExpr === null
            ? `const __sfc__ = {}\n`
            : `const __sfc__ = Object.assign({}, ${defaultExpr})\n`
        content += `__sfc__.render = render\n__sfc__.__file = ${JSON.stringify(filename)}\nexport default __sfc__\n`
    } else {
        content = `${template.code}\nconst __sfc__ = {}\n__sfc__.render = render\n__sfc__.__file = ${JSON.stringify(filename)}\nexport default __sfc__\n`
    }
    content = content.replace(/from\s+["']vue["']/g, `from "${VUE_RUNTIME_URL}"`)
    let css = ""
    for (const style of descriptor.styles) {
        if (style.scoped === true) {
            throw new Error("暂不支持 scoped 样式；请用唯一 class 前缀避免冲突")
        }
        const result = compileStyle({ source: style.content, filename, id, scoped: false })
        if (result.errors.length > 0) {
            throw new Error(`样式编译失败：${result.errors.map(errorText).join("；")}`)
        }
        css += `${result.code}\n`
    }
    return { module: content, css }
}

/* ── 初始化 / 列表 ────────────────────────────────────────── */

async function readManifest(): Promise<Manifest> {
    const value = await getApi().fs.readJson<Manifest>(MANIFEST_FILE)
    if (value === null || !Array.isArray(value.items)) {
        return { version: 1, items: [] }
    }
    return {
        version: 1,
        items: value.items.filter(
            (item): item is StoredExtension =>
                item !== null &&
                typeof item === "object" &&
                typeof item.id === "string" &&
                typeof item.name === "string" &&
                typeof item.size === "number",
        ),
    }
}

async function writeManifest() {
    const manifest: Manifest = {
        version: 1,
        items: [...installed.values()].sort((left, right) => right.createdAt - left.createdAt),
    }
    await getApi().fs.mkdir(EXTENSIONS_DIR)
    await getApi().fs.writeJson(MANIFEST_FILE, manifest)
}

interface BuiltinState {
    readonly version: 1
    readonly hidden: string[]
}

async function readBuiltinState(): Promise<void> {
    const value = await getApi().fs.readJson<BuiltinState>(BUILTIN_STATE_FILE)
    hiddenBuiltin.clear()
    if (value === null || !Array.isArray(value.hidden)) return
    for (const id of value.hidden) {
        if (typeof id === "string") hiddenBuiltin.add(id)
    }
}

async function writeBuiltinState(): Promise<void> {
    await getApi().fs.mkdir(EXTENSIONS_DIR)
    const state: BuiltinState = { version: 1, hidden: [...hiddenBuiltin].sort() }
    await getApi().fs.writeJson(BUILTIN_STATE_FILE, state)
}

export function hiddenBuiltinExtensions(): string[] {
    return [...hiddenBuiltin].sort()
}

/** 隐藏/恢复内置扩展（插件目录只读，网页删除内部记为隐藏） */
export async function setBuiltinHidden(id: string, hidden: boolean): Promise<boolean> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !id.startsWith("bundled-")) {
        return false
    }
    if (hidden) hiddenBuiltin.add(id)
    else hiddenBuiltin.delete(id)
    await writeBuiltinState()
    return true
}

export async function initExtensions(current: PluginApi): Promise<void> {
    api = current
    installed.clear()
    compiled.clear()
    const manifest = await readManifest()
    for (const item of manifest.items) {
        installed.set(item.id, item)
    }
    await readBuiltinState()
}

export function listExtensions(): ExtensionItem[] {
    return [...installed.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(toItem)
}

async function ensureCompiled(item: StoredExtension): Promise<CompiledExtension | null> {
    const cached = compiled.get(item.id)
    if (cached !== undefined) return cached
    const source = await getApi().fs.readText(`${EXTENSIONS_DIR}/${item.id}.vue`)
    if (source === null) return null
    const result = await compileVue(`${item.name}.vue`, source)
    compiled.set(item.id, result)
    return result
}

export async function extensionAssets(id: string): Promise<CompiledExtension | null> {
    const cached = compiled.get(id)
    if (cached !== undefined) return cached
    const item = installed.get(id)
    if (item === undefined) return null
    try {
        return await ensureCompiled(item)
    } catch {
        return null
    }
}

/* ── 安装 / 卸载 ──────────────────────────────────────────── */

export async function installExtension(
    filename: string,
    dataBase64: string,
): Promise<{ ok: true; extension: ExtensionItem } | { ok: false; error: string }> {
    const name = filename.split(/[\\/]/).pop() ?? filename
    if (!/\.vue$/i.test(name)) {
        return { ok: false, error: "只支持 .vue 单文件组件" }
    }
    let source: string
    try {
        source = Buffer.from(dataBase64, "base64").toString("utf8")
    } catch {
        return { ok: false, error: "上传内容不是合法的 base64" }
    }
    if (source.trim() === "") {
        return { ok: false, error: "扩展内容为空" }
    }
    let compiledResult: CompiledExtension
    try {
        compiledResult = await compileVue(name, source)
    } catch (error) {
        return { ok: false, error: errorText(error) }
    }
    const id = idOf(name, source)
    const item: StoredExtension = {
        id,
        name: name.replace(/\.vue$/i, ""),
        size: source.length,
        createdAt: Date.now(),
    }
    await getApi().fs.mkdir(EXTENSIONS_DIR)
    await getApi().fs.writeText(`${EXTENSIONS_DIR}/${id}.vue`, source)
    await getApi().fs.writeText(`${EXTENSIONS_DIR}/${id}.mjs`, compiledResult.module)
    await getApi().fs.writeText(`${EXTENSIONS_DIR}/${id}.css`, compiledResult.css)
    installed.set(id, item)
    compiled.set(id, compiledResult)
    await writeManifest()
    getApi().logger.info({ id, name: item.name }, "已安装 Web 扩展")
    return { ok: true, extension: toItem(item) }
}

export async function removeExtension(id: string): Promise<boolean> {
    const item = installed.get(id)
    if (item === undefined) return false
    installed.delete(id)
    compiled.delete(id)
    await getApi().fs.remove(`${EXTENSIONS_DIR}/${id}.vue`)
    await getApi().fs.remove(`${EXTENSIONS_DIR}/${id}.mjs`)
    await getApi().fs.remove(`${EXTENSIONS_DIR}/${id}.css`)
    await writeManifest()
    getApi().logger.info({ id }, "已删除 Web 扩展")
    return true
}
