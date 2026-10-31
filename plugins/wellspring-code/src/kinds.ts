/*
 * 文件类型表：语言名、文件图标徽标、语法高亮器与 MIME 都由这里决定。
 * 只依赖文件名，不读取磁盘。
 */

export type FileMedia = "text" | "image" | "binary"

export interface FileKind {
    /** 编辑器语言 id，与客户端 highlighter 的分派一致 */
    readonly language: string
    /** 状态栏显示的语言名 */
    readonly label: string
    /** 资源管理器里的文件徽标，最多 3 个字符 */
    readonly badge: string
    /** 徽标配色键，对应样式表里的 .tone-* */
    readonly tone: string
    readonly media: FileMedia
    readonly mime: string
}

interface KindSeed {
    readonly language: string
    readonly label: string
    readonly badge: string
    readonly tone: string
}

const TEXT = (seed: KindSeed, mime = "text/plain; charset=utf-8"): FileKind => ({
    ...seed,
    media: "text",
    mime,
})

const BINARY = (seed: KindSeed, mime: string): FileKind => ({
    ...seed,
    media: "binary",
    mime,
})

const PLAIN: FileKind = TEXT({
    language: "plaintext",
    label: "纯文本",
    badge: "TXT",
    tone: "plain",
})

const IMAGE_KIND = (language: string, badge: string, mime: string): FileKind => ({
    language,
    label: "图片",
    badge,
    tone: "image",
    media: "image",
    mime,
})

const BY_EXTENSION: Readonly<Record<string, FileKind>> = {
    ts: TEXT(
        { language: "typescript", label: "TypeScript", badge: "TS", tone: "ts" },
        "text/typescript",
    ),
    tsx: TEXT(
        { language: "typescript", label: "TypeScript React", badge: "TS", tone: "ts" },
        "text/typescript",
    ),
    mts: TEXT(
        { language: "typescript", label: "TypeScript", badge: "TS", tone: "ts" },
        "text/typescript",
    ),
    cts: TEXT(
        { language: "typescript", label: "TypeScript", badge: "TS", tone: "ts" },
        "text/typescript",
    ),
    js: TEXT(
        { language: "javascript", label: "JavaScript", badge: "JS", tone: "js" },
        "text/javascript",
    ),
    jsx: TEXT(
        { language: "javascript", label: "JavaScript React", badge: "JS", tone: "js" },
        "text/javascript",
    ),
    mjs: TEXT(
        { language: "javascript", label: "JavaScript", badge: "JS", tone: "js" },
        "text/javascript",
    ),
    cjs: TEXT(
        { language: "javascript", label: "JavaScript", badge: "JS", tone: "js" },
        "text/javascript",
    ),
    json: TEXT({ language: "json", label: "JSON", badge: "{}", tone: "json" }, "application/json"),
    jsonc: TEXT(
        { language: "json", label: "JSON with Comments", badge: "{}", tone: "json" },
        "application/json",
    ),
    json5: TEXT(
        { language: "json", label: "JSON5", badge: "{}", tone: "json" },
        "application/json",
    ),
    md: TEXT({ language: "markdown", label: "Markdown", badge: "MD", tone: "md" }, "text/markdown"),
    markdown: TEXT(
        { language: "markdown", label: "Markdown", badge: "MD", tone: "md" },
        "text/markdown",
    ),
    mdx: TEXT({ language: "markdown", label: "MDX", badge: "MD", tone: "md" }, "text/markdown"),
    css: TEXT({ language: "css", label: "CSS", badge: "CSS", tone: "css" }, "text/css"),
    scss: TEXT({ language: "css", label: "SCSS", badge: "SC", tone: "css" }, "text/x-scss"),
    sass: TEXT({ language: "css", label: "Sass", badge: "SA", tone: "css" }, "text/x-sass"),
    less: TEXT({ language: "css", label: "Less", badge: "LE", tone: "css" }, "text/x-less"),
    html: TEXT({ language: "html", label: "HTML", badge: "<>", tone: "html" }, "text/html"),
    htm: TEXT({ language: "html", label: "HTML", badge: "<>", tone: "html" }, "text/html"),
    xhtml: TEXT(
        { language: "html", label: "XHTML", badge: "<>", tone: "html" },
        "application/xhtml+xml",
    ),
    vue: TEXT({ language: "html", label: "Vue", badge: "V", tone: "vue" }, "text/plain"),
    svelte: TEXT({ language: "html", label: "Svelte", badge: "SV", tone: "vue" }, "text/plain"),
    xml: TEXT({ language: "html", label: "XML", badge: "<>", tone: "html" }, "application/xml"),
    svg: TEXT({ language: "html", label: "SVG", badge: "SVG", tone: "vue" }, "image/svg+xml"),
    yaml: TEXT({ language: "yaml", label: "YAML", badge: "YM", tone: "yaml" }, "text/yaml"),
    yml: TEXT({ language: "yaml", label: "YAML", badge: "YM", tone: "yaml" }, "text/yaml"),
    toml: TEXT({ language: "toml", label: "TOML", badge: "TM", tone: "yaml" }, "text/plain"),
    ini: TEXT({ language: "ini", label: "INI", badge: "INI", tone: "yaml" }, "text/plain"),
    cfg: TEXT({ language: "ini", label: "配置", badge: "CFG", tone: "yaml" }, "text/plain"),
    conf: TEXT({ language: "ini", label: "配置", badge: "CFG", tone: "yaml" }, "text/plain"),
    properties: TEXT(
        { language: "ini", label: "Properties", badge: "CFG", tone: "yaml" },
        "text/plain",
    ),
    env: TEXT({ language: "ini", label: "环境变量", badge: "ENV", tone: "yaml" }, "text/plain"),
    py: TEXT({ language: "python", label: "Python", badge: "PY", tone: "python" }, "text/x-python"),
    pyi: TEXT(
        { language: "python", label: "Python", badge: "PY", tone: "python" },
        "text/x-python",
    ),
    sh: TEXT({ language: "shell", label: "Shell", badge: "SH", tone: "shell" }, "text/x-sh"),
    bash: TEXT({ language: "shell", label: "Bash", badge: "SH", tone: "shell" }, "text/x-sh"),
    zsh: TEXT({ language: "shell", label: "Zsh", badge: "SH", tone: "shell" }, "text/x-sh"),
    fish: TEXT({ language: "shell", label: "Fish", badge: "SH", tone: "shell" }, "text/x-sh"),
    ps1: TEXT(
        { language: "powershell", label: "PowerShell", badge: "PS", tone: "shell" },
        "text/plain",
    ),
    bat: TEXT({ language: "shell", label: "批处理", badge: "BAT", tone: "shell" }, "text/plain"),
    cmd: TEXT({ language: "shell", label: "批处理", badge: "BAT", tone: "shell" }, "text/plain"),
    go: TEXT({ language: "go", label: "Go", badge: "GO", tone: "go" }, "text/x-go"),
    rs: TEXT({ language: "rust", label: "Rust", badge: "RS", tone: "rust" }, "text/x-rust"),
    java: TEXT({ language: "java", label: "Java", badge: "JV", tone: "java" }, "text/x-java"),
    kt: TEXT({ language: "java", label: "Kotlin", badge: "KT", tone: "java" }, "text/plain"),
    kts: TEXT(
        { language: "java", label: "Kotlin Script", badge: "KT", tone: "java" },
        "text/plain",
    ),
    swift: TEXT({ language: "java", label: "Swift", badge: "SW", tone: "java" }, "text/plain"),
    scala: TEXT({ language: "java", label: "Scala", badge: "SC", tone: "java" }, "text/plain"),
    c: TEXT({ language: "c", label: "C", badge: "C", tone: "c" }, "text/x-c"),
    h: TEXT({ language: "c", label: "C Header", badge: "H", tone: "c" }, "text/x-c"),
    cc: TEXT({ language: "cpp", label: "C++", badge: "C+", tone: "c" }, "text/x-c++"),
    cpp: TEXT({ language: "cpp", label: "C++", badge: "C+", tone: "c" }, "text/x-c++"),
    cxx: TEXT({ language: "cpp", label: "C++", badge: "C+", tone: "c" }, "text/x-c++"),
    hpp: TEXT({ language: "cpp", label: "C++ Header", badge: "H+", tone: "c" }, "text/x-c++"),
    hxx: TEXT({ language: "cpp", label: "C++ Header", badge: "H+", tone: "c" }, "text/x-c++"),
    cs: TEXT({ language: "csharp", label: "C#", badge: "C#", tone: "c" }, "text/plain"),
    php: TEXT({ language: "php", label: "PHP", badge: "PHP", tone: "php" }, "text/plain"),
    rb: TEXT({ language: "ruby", label: "Ruby", badge: "RB", tone: "ruby" }, "text/plain"),
    lua: TEXT({ language: "lua", label: "Lua", badge: "LUA", tone: "ruby" }, "text/plain"),
    sql: TEXT({ language: "sql", label: "SQL", badge: "SQL", tone: "sql" }, "text/plain"),
    graphql: TEXT(
        { language: "graphql", label: "GraphQL", badge: "GQL", tone: "graphql" },
        "text/plain",
    ),
    gql: TEXT(
        { language: "graphql", label: "GraphQL", badge: "GQL", tone: "graphql" },
        "text/plain",
    ),
    proto: TEXT(
        { language: "plaintext", label: "Protocol Buffers", badge: "PB", tone: "plain" },
        "text/plain",
    ),
    prisma: TEXT(
        { language: "plaintext", label: "Prisma", badge: "PR", tone: "plain" },
        "text/plain",
    ),
    tex: TEXT({ language: "plaintext", label: "LaTeX", badge: "TEX", tone: "plain" }, "text/plain"),
    txt: PLAIN,
    text: PLAIN,
    log: TEXT({ language: "plaintext", label: "日志", badge: "LOG", tone: "plain" }, "text/plain"),
    csv: TEXT({ language: "plaintext", label: "CSV", badge: "CSV", tone: "plain" }, "text/csv"),
    tsv: TEXT(
        { language: "plaintext", label: "TSV", badge: "TSV", tone: "plain" },
        "text/tab-separated-values",
    ),
    diff: TEXT({ language: "diff", label: "Diff", badge: "±", tone: "diff" }, "text/x-diff"),
    patch: TEXT({ language: "diff", label: "Patch", badge: "±", tone: "diff" }, "text/x-diff"),
    png: IMAGE_KIND("image", "PNG", "image/png"),
    jpg: IMAGE_KIND("image", "JPG", "image/jpeg"),
    jpeg: IMAGE_KIND("image", "JPG", "image/jpeg"),
    gif: IMAGE_KIND("image", "GIF", "image/gif"),
    webp: IMAGE_KIND("image", "WEBP", "image/webp"),
    avif: IMAGE_KIND("image", "AVIF", "image/avif"),
    bmp: IMAGE_KIND("image", "BMP", "image/bmp"),
    ico: IMAGE_KIND("image", "ICO", "image/x-icon"),
    pdf: BINARY(
        { language: "pdf", label: "PDF", badge: "PDF", tone: "archive" },
        "application/pdf",
    ),
    zip: BINARY(
        { language: "archive", label: "压缩包", badge: "ZIP", tone: "archive" },
        "application/zip",
    ),
    gz: BINARY(
        { language: "archive", label: "压缩包", badge: "GZ", tone: "archive" },
        "application/gzip",
    ),
    tgz: BINARY(
        { language: "archive", label: "压缩包", badge: "TGZ", tone: "archive" },
        "application/gzip",
    ),
    tar: BINARY(
        { language: "archive", label: "压缩包", badge: "TAR", tone: "archive" },
        "application/x-tar",
    ),
    rar: BINARY(
        { language: "archive", label: "压缩包", badge: "RAR", tone: "archive" },
        "application/vnd.rar",
    ),
    "7z": BINARY(
        { language: "archive", label: "压缩包", badge: "7Z", tone: "archive" },
        "application/x-7z-compressed",
    ),
    wasm: BINARY(
        { language: "binary", label: "WebAssembly", badge: "WA", tone: "archive" },
        "application/wasm",
    ),
    woff: BINARY({ language: "font", label: "字体", badge: "WO", tone: "archive" }, "font/woff"),
    woff2: BINARY({ language: "font", label: "字体", badge: "WO2", tone: "archive" }, "font/woff2"),
    ttf: BINARY({ language: "font", label: "字体", badge: "TTF", tone: "archive" }, "font/ttf"),
    otf: BINARY({ language: "font", label: "字体", badge: "OTF", tone: "archive" }, "font/otf"),
    mp3: BINARY({ language: "audio", label: "音频", badge: "MP3", tone: "archive" }, "audio/mpeg"),
    wav: BINARY({ language: "audio", label: "音频", badge: "WAV", tone: "archive" }, "audio/wav"),
    ogg: BINARY({ language: "audio", label: "音频", badge: "OGG", tone: "archive" }, "audio/ogg"),
    flac: BINARY(
        { language: "audio", label: "音频", badge: "FLAC", tone: "archive" },
        "audio/flac",
    ),
    mp4: BINARY({ language: "video", label: "视频", badge: "MP4", tone: "archive" }, "video/mp4"),
    webm: BINARY(
        { language: "video", label: "视频", badge: "WEBM", tone: "archive" },
        "video/webm",
    ),
    mov: BINARY(
        { language: "video", label: "视频", badge: "MOV", tone: "archive" },
        "video/quicktime",
    ),
    mkv: BINARY(
        { language: "video", label: "视频", badge: "MKV", tone: "archive" },
        "video/x-matroska",
    ),
    exe: BINARY(
        { language: "binary", label: "可执行文件", badge: "EXE", tone: "archive" },
        "application/octet-stream",
    ),
    dll: BINARY(
        { language: "binary", label: "动态库", badge: "DLL", tone: "archive" },
        "application/octet-stream",
    ),
    so: BINARY(
        { language: "binary", label: "动态库", badge: "SO", tone: "archive" },
        "application/octet-stream",
    ),
    dylib: BINARY(
        { language: "binary", label: "动态库", badge: "DYL", tone: "archive" },
        "application/octet-stream",
    ),
    class: BINARY(
        { language: "binary", label: "字节码", badge: "CLS", tone: "archive" },
        "application/java-vm",
    ),
    jar: BINARY(
        { language: "archive", label: "JAR", badge: "JAR", tone: "archive" },
        "application/java-archive",
    ),
    sqlite: BINARY(
        { language: "binary", label: "SQLite", badge: "DB", tone: "archive" },
        "application/vnd.sqlite3",
    ),
    db: BINARY(
        { language: "binary", label: "数据库", badge: "DB", tone: "archive" },
        "application/octet-stream",
    ),
}

const BY_NAME: Readonly<Record<string, FileKind>> = {
    dockerfile: TEXT({ language: "dockerfile", label: "Dockerfile", badge: "DKR", tone: "docker" }),
    containerfile: TEXT({
        language: "dockerfile",
        label: "Containerfile",
        badge: "DKR",
        tone: "docker",
    }),
    makefile: TEXT({ language: "makefile", label: "Makefile", badge: "MK", tone: "shell" }),
    cmakelists: TEXT({ language: "makefile", label: "CMake", badge: "MK", tone: "shell" }),
    ".gitignore": TEXT({ language: "ini", label: "Git Ignore", badge: "GIT", tone: "yaml" }),
    ".gitattributes": TEXT({
        language: "ini",
        label: "Git Attributes",
        badge: "GIT",
        tone: "yaml",
    }),
    ".editorconfig": TEXT({ language: "ini", label: "EditorConfig", badge: "CFG", tone: "yaml" }),
    ".npmrc": TEXT({ language: "ini", label: "npmrc", badge: "NPM", tone: "yaml" }),
    ".prettierrc": TEXT({ language: "json", label: "Prettier", badge: "PRT", tone: "json" }),
    ".babelrc": TEXT({ language: "json", label: "Babel", badge: "BAB", tone: "json" }),
    caddyfile: TEXT({ language: "ini", label: "Caddyfile", badge: "CAD", tone: "yaml" }),
    license: PLAIN,
    readme: TEXT({ language: "markdown", label: "README", badge: "MD", tone: "md" }),
}

/** 取文件名的扩展名（小写，不含点） */
export function extensionOf(name: string): string {
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"))
    const base = slash === -1 ? name : name.slice(slash + 1)
    const dot = base.lastIndexOf(".")
    if (dot <= 0 || dot === base.length - 1) {
        return ""
    }
    return base.slice(dot + 1).toLowerCase()
}

function baseNameOf(path: string): string {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    return slash === -1 ? path : path.slice(slash + 1)
}

/** 按文件名判断类型；未知扩展名按纯文本处理，可正常编辑 */
export function kindOf(path: string): FileKind {
    const base = baseNameOf(path).toLowerCase()
    const named = BY_NAME[base]
    if (named !== undefined) {
        return named
    }
    if (base.endsWith(".min.js") || base.endsWith(".min.css")) {
        return TEXT(
            { language: "plaintext", label: "压缩文件", badge: "MIN", tone: "plain" },
            "text/plain; charset=utf-8",
        )
    }
    const extension = extensionOf(base)
    const byExtension = BY_EXTENSION[extension]
    if (byExtension !== undefined) {
        return byExtension
    }
    if (extension === "") {
        return PLAIN
    }
    return TEXT({
        language: "plaintext",
        label: "纯文本",
        badge: extension.slice(0, 3).toUpperCase(),
        tone: "plain",
    })
}
