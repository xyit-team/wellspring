// TTY Markdown 渲染

import { highlight, supportsLanguage } from "cli-highlight"
import { createMarkdownStreamer, render } from "markdansi"

export interface MarkdownStream {
    push(text: string): string
    finish(): string
}

// 终端宽度
function terminalWidth(): number {
    return Math.max(40, (process.stdout.columns ?? 80) - 2)
}

// 语言别名
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
    "c++": "cpp",
    asm: "x86asm",
    proto: "protobuf",
    shell: "bash",
    sh: "bash",
    vimscript: "vim",
}

// 代码块高亮
function highlightCode(code: string, language?: string): string {
    if (!markdownColor() || language === undefined) {
        return code
    }
    const resolved = LANGUAGE_ALIASES[language.toLowerCase()] ?? language
    if (!supportsLanguage(resolved)) {
        return code
    }
    try {
        return highlight(code, { language: resolved, ignoreIllegals: true })
    } catch {
        return code
    }
}

// 单行代码块补一行占位，markdansi 据此画框
function ensureCodeBox(block: string): string {
    const match = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1$/.exec(block)
    if (match === null) {
        return block
    }
    const [, fence, info, content] = match
    if (content === undefined || content.includes("\n")) {
        return block
    }
    return `${fence}${info ?? ""}\n${content}\n\u200B\n${fence}`
}

// 去掉单行代码框的占位行
function stripCodePad(output: string): string {
    return output.replace(/^.*\u200B.*\n/m, "")
}

// 代码块外的 Markdown 预处理
function prepareMarkdown(markdown: string): string {
    const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    return parts
        .map((part, index) => {
            if (index % 2 === 1) {
                return ensureCodeBox(part)
            }
            return part
                .replace(
                    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
                    (_match, alt: string, url: string) =>
                        alt === "" ? `图片（${url}）` : `图片：${alt}（${url}）`,
                )
                .replace(/<summary>([\s\S]*?)<\/summary>/gi, "▶ $1")
                .replace(/<\/?details[^>]*>/gi, "")
                .replace(/^(\s*[-*+]\s+)\[x\]\s*/gim, "$1☑ ")
                .replace(/^(\s*[-*+]\s+)\[ \]\s*/gim, "$1☐ ")
        })
        .join("")
}

// 是否启用颜色
export function markdownColor(): boolean {
    return (
        process.stdout.isTTY === true &&
        process.env["NO_COLOR"] === undefined &&
        process.env["TERM"] !== "dumb"
    )
}

// 渲染完整 Markdown
export function renderMarkdown(markdown: string): string {
    try {
        return stripCodePad(
            render(prepareMarkdown(markdown), {
                width: terminalWidth(),
                color: markdownColor(),
                hyperlinks: markdownColor(),
                highlighter: highlightCode,
            }),
        )
    } catch {
        return markdown
    }
}

// 流式渲染 Markdown
export function createMarkdownStream(): MarkdownStream {
    const streamer = createMarkdownStreamer({
        render: (markdown) =>
            stripCodePad(
                render(prepareMarkdown(markdown), {
                    width: terminalWidth(),
                    color: markdownColor(),
                    hyperlinks: markdownColor(),
                    highlighter: highlightCode,
                }),
            ),
        spacing: "single",
    })
    return {
        push(text) {
            try {
                return streamer.push(text)
            } catch {
                return text
            }
        },
        finish() {
            try {
                return streamer.finish()
            } catch {
                return ""
            }
        },
    }
}
