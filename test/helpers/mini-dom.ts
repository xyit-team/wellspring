/*
 * 测试用最小 DOM：只实现 Markdown 渲染器用到的 API
 * 在 node --test 里验证客户端渲染，不引入浏览器与第三方依赖
 */

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const FRAGMENT_NODE = 11

export interface MiniTextNode {
    readonly nodeType: number
    parentNode: MiniParentNode | null
    data: string
    textContent: string
}

export interface MiniParentNode {
    readonly nodeType: number
    parentNode: MiniParentNode | null
    readonly childNodes: MiniChildNode[]
    readonly firstChild: MiniChildNode | null
    textContent: string
    appendChild<T extends MiniChildNode>(child: T): T
    removeChild<T extends MiniChildNode>(child: T): T
}

export type MiniChildNode = MiniElementNode | MiniTextNode

export interface MiniElementNode extends MiniParentNode {
    readonly tagName: string
    readonly namespaceURI: string
    className: string
    type: string
    disabled: boolean
    checked: boolean
    href: string
    target: string
    rel: string
    readonly attributes: Map<string, string>
    readonly listeners: Map<string, Array<() => void>>
    setAttribute(name: string, value: string): void
    getAttribute(name: string): string | null
    addEventListener(name: string, listener: () => void): void
}

function escapeText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

class TextNode {
    readonly nodeType = TEXT_NODE
    parentNode: MiniParentNode | null = null
    data: string

    constructor(data: string) {
        this.data = data
    }

    get textContent(): string {
        return this.data
    }

    set textContent(value: string) {
        this.data = value
    }
}

abstract class ParentNode {
    abstract readonly nodeType: number
    parentNode: MiniParentNode | null = null
    readonly childNodes: MiniChildNode[] = []

    get firstChild(): MiniChildNode | null {
        return this.childNodes[0] ?? null
    }

    get textContent(): string {
        return this.childNodes.map((child) => child.textContent).join("")
    }

    set textContent(value: string) {
        this.childNodes.length = 0
        if (value !== "") {
            this.appendChild(new TextNode(String(value)))
        }
    }

    appendChild<T extends MiniChildNode>(child: T): T {
        if (child.parentNode !== null) {
            child.parentNode.removeChild(child)
        }
        this.childNodes.push(child)
        child.parentNode = this as unknown as MiniParentNode
        return child
    }

    removeChild<T extends MiniChildNode>(child: T): T {
        const index = this.childNodes.indexOf(child)
        if (index !== -1) {
            this.childNodes.splice(index, 1)
            child.parentNode = null
        }
        return child
    }
}

class ElementNode extends ParentNode {
    readonly nodeType = ELEMENT_NODE
    readonly tagName: string
    readonly namespaceURI: string
    readonly attributes = new Map<string, string>()
    readonly listeners = new Map<string, Array<() => void>>()
    className = ""
    type = ""
    disabled = false
    checked = false
    href = ""
    target = ""
    rel = ""

    constructor(tagName: string, namespaceURI: string) {
        super()
        this.tagName = tagName
        this.namespaceURI = namespaceURI
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value)
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null
    }

    addEventListener(name: string, listener: () => void): void {
        const list = this.listeners.get(name) ?? []
        list.push(listener)
        this.listeners.set(name, list)
    }
}

class FragmentNode extends ParentNode {
    readonly nodeType = FRAGMENT_NODE
}

export interface MiniDom {
    readonly document: {
        createElement(tagName: string): MiniElementNode
        createElementNS(namespaceURI: string, tagName: string): MiniElementNode
        createTextNode(data: string): MiniTextNode
        createDocumentFragment(): MiniParentNode
    }
    serialize(node: MiniChildNode | MiniParentNode): string
}

const HANDLED_ATTRIBUTES = new Set(["class", "href", "target", "rel", "type"])

function attributesOf(node: MiniElementNode): Array<[string, string]> {
    const result: Array<[string, string]> = []
    for (const [name, value] of node.attributes) {
        if (!HANDLED_ATTRIBUTES.has(name)) {
            result.push([name, value])
        }
    }
    if (node.className !== "") {
        result.push(["class", node.className])
    }
    if (node.href !== "") {
        result.push(["href", node.href])
    }
    if (node.target !== "") {
        result.push(["target", node.target])
    }
    if (node.rel !== "") {
        result.push(["rel", node.rel])
    }
    if (node.type !== "") {
        result.push(["type", node.type])
    }
    if (node.disabled) {
        result.push(["disabled", ""])
    }
    if (node.checked) {
        result.push(["checked", ""])
    }
    return result
}

export function createMiniDom(): MiniDom {
    const serialize = (node: MiniChildNode | MiniParentNode): string => {
        if (node.nodeType === TEXT_NODE) {
            return escapeText((node as MiniTextNode).data)
        }
        const parent = node as MiniParentNode
        if (node.nodeType === FRAGMENT_NODE) {
            return parent.childNodes.map(serialize).join("")
        }
        const element = node as MiniElementNode
        const attrs = attributesOf(element)
            .map(([name, value]) =>
                value === "" ? ` ${name}=""` : ` ${name}="${escapeText(value)}"`,
            )
            .join("")
        const children = parent.childNodes.map(serialize).join("")
        return `<${element.tagName}${attrs}>${children}</${element.tagName}>`
    }
    return {
        document: {
            createElement: (tagName: string) =>
                new ElementNode(tagName, "http://www.w3.org/1999/xhtml"),
            createElementNS: (namespaceURI: string, tagName: string) =>
                new ElementNode(tagName, namespaceURI),
            createTextNode: (data: string) => new TextNode(data),
            createDocumentFragment: () => new FragmentNode(),
        },
        serialize,
    }
}

type RenderFunction = (text: string) => MiniParentNode

/** 用最小 DOM 执行 markdown 片段，返回 text -> html 的渲染函数 */
export function createMarkdownRenderer(source: string): (text: string) => string {
    const dom = createMiniDom()
    const factory = new Function(
        "document",
        "copyText",
        `${source}\nreturn mdRender`,
    ) as unknown as (document: unknown, copyText: () => void) => RenderFunction
    const render = factory(dom.document, () => {})
    return (text: string) => dom.serialize(render(text))
}
