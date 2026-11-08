import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { gzipSync } from "node:zlib"

import {
    DEFAULT_GITHUB_API,
    DEFAULT_NPM_REGISTRY,
    downloadPluginPackage,
    parsePluginSpec,
    describeNetworkError,
    isGithubRateLimitError,
    resolveGithubRelease,
    resolveGithubTarball,
    resolveNpmRelease,
    tagToVersion,
} from "../src/plugin/sources.ts"

let root = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-plugin-sources-"))
})

after(async () => {
    await rm(root, { recursive: true, force: true })
})

interface FetchCall {
    url: string
}

function fakeFetch(
    handler: (url: string) => { status?: number; json?: unknown; bytes?: Buffer },
    calls: FetchCall[] = [],
): typeof fetch {
    return (async (input: unknown) => {
        const url = String(input)
        calls.push({ url })
        const result = handler(url)
        if (result.bytes !== undefined) {
            return new Response(result.bytes, { status: result.status ?? 200 })
        }
        return new Response(JSON.stringify(result.json ?? {}), {
            status: result.status ?? 200,
            headers: { "content-type": "application/json" },
        })
    }) as unknown as typeof fetch
}

test("parsePluginSpec：npm / github / 路径三种写法", () => {
    assert.deepEqual(parsePluginSpec("npm:@xyit/test"), {
        type: "npm",
        name: "@xyit/test",
        version: null,
    })
    assert.deepEqual(parsePluginSpec("npm:demo@1.2.3"), {
        type: "npm",
        name: "demo",
        version: "1.2.3",
    })
    assert.deepEqual(parsePluginSpec("npm:@xyit/test@1.2.3"), {
        type: "npm",
        name: "@xyit/test",
        version: "1.2.3",
    })
    assert.deepEqual(parsePluginSpec("github:EtherosGroup/wellspring-core"), {
        type: "github",
        repo: "EtherosGroup/wellspring-core",
        ref: null,
    })
    assert.deepEqual(parsePluginSpec("github:EtherosGroup/wellspring-core@v1.4.1"), {
        type: "github",
        repo: "EtherosGroup/wellspring-core",
        ref: "v1.4.1",
    })
    assert.deepEqual(parsePluginSpec("./local/demo"), { type: "file", path: "./local/demo" })
    assert.throws(() => parsePluginSpec("npm:"), /包名不合法/)
    assert.throws(() => parsePluginSpec("github:noowner"), /owner\/repo/)
})

test("resolveNpmRelease：scoped 包名编码，latest / 指定版本分别取", async () => {
    const calls: FetchCall[] = []
    const latest = await resolveNpmRelease("@xyit/test", null, {
        fetchImpl: fakeFetch(
            () => ({ json: { version: "1.4.2", dist: { tarball: "https://x/t.tgz" } } }),
            calls,
        ),
    })
    assert.equal(latest.version, "1.4.2")
    assert.equal(latest.url, "https://x/t.tgz")
    assert.equal(latest.channel, "npm")
    assert.equal(calls[0]?.url, `${DEFAULT_NPM_REGISTRY}/@xyit%2ftest/latest`)

    calls.length = 0
    const pinned = await resolveNpmRelease("demo", "1.2.3", {
        registry: "https://mirror.example/npm",
        fetchImpl: fakeFetch(
            () => ({ json: { version: "1.2.3", dist: { tarball: "https://x/p.tgz" } } }),
            calls,
        ),
    })
    assert.equal(pinned.version, "1.2.3")
    assert.equal(calls[0]?.url, "https://mirror.example/npm/demo/1.2.3")
})

test("resolveNpmRelease：registry 报错带上状态码", async () => {
    await assert.rejects(
        () => resolveNpmRelease("demo", null, { fetchImpl: fakeFetch(() => ({ status: 404 })) }),
        /404/,
    )
})

test("resolveGithubRelease：优先 Release 的 zip 资产", async () => {
    const calls: FetchCall[] = []
    const release = await resolveGithubRelease("EtherosGroup/wellspring-core", null, {
        fetchImpl: fakeFetch(
            () => ({
                json: {
                    tag_name: "v1.4.2",
                    assets: [
                        { name: "notes.txt", browser_download_url: "https://x/notes.txt" },
                        {
                            name: "wellspring-core-1.4.2.zip",
                            browser_download_url: "https://x/w.zip",
                        },
                    ],
                },
            }),
            calls,
        ),
    })
    assert.equal(release.version, "1.4.2")
    assert.equal(release.url, "https://x/w.zip")
    assert.equal(
        calls[0]?.url,
        `${DEFAULT_GITHUB_API}/repos/EtherosGroup/wellspring-core/releases/latest`,
    )
})

test("resolveGithubRelease：没有 zip 资产时回落源码 tarball", async () => {
    const release = await resolveGithubRelease("a/b", null, {
        fetchImpl: fakeFetch(() => ({ json: { tag_name: "v2.0.0", assets: [] } })),
    })
    assert.equal(release.version, "2.0.0")
    assert.equal(release.url, "https://codeload.github.com/a/b/tar.gz/refs/tags/v2.0.0")
})

test("resolveGithubRelease：指定 tag 但 Release 不存在时直接走 codeload", async () => {
    const release = await resolveGithubRelease("a/b", "v0.9.0", {
        fetchImpl: fakeFetch(() => ({ status: 404 })),
    })
    assert.equal(release.version, "0.9.0")
    assert.match(release.url, /codeload\.github\.com\/a\/b\/tar\.gz\/refs\/tags\/v0\.9\.0$/)
})

test("tagToVersion：去掉 v 前缀", () => {
    assert.equal(tagToVersion("v1.2.3"), "1.2.3")
    assert.equal(tagToVersion("1.2.3"), "1.2.3")
})

test("GitHub 限流兜底：codeload tarball 不走 REST API", () => {
    const fallback = resolveGithubTarball("xyit-team/wellspring-core")
    assert.equal(fallback.version, null, "源码 tarball 拿不到版本号")
    assert.equal(fallback.url, "https://codeload.github.com/xyit-team/wellspring-core/tar.gz/HEAD")
    assert.equal(fallback.channel, "github")
})

test("isGithubRateLimitError：只认 GitHub API 的 403/429", () => {
    assert.equal(isGithubRateLimitError(new Error("https://api.github.com/x 返回 403")), true)
    assert.equal(isGithubRateLimitError(new Error("https://api.github.com/x 返回 429")), true)
    assert.equal(isGithubRateLimitError(new Error("https://api.github.com/x 返回 404")), false)
    assert.equal(isGithubRateLimitError(new Error("https://registry.npmjs.org/x 返回 403")), false)
})
test("downloadPluginPackage：下载到临时目录，内容原样落盘", async () => {
    const payload = gzipSync(Buffer.from("not-a-real-tar"))
    const file = await downloadPluginPackage("https://x/p.tgz", join(root, "dl"), {
        fetchImpl: fakeFetch(() => ({ bytes: payload })),
    })
    const written = await readFile(file)
    assert.deepEqual(written, payload)
})

test("downloadPluginPackage：非 2xx 报错", async () => {
    await assert.rejects(
        () =>
            downloadPluginPackage("https://x/p.tgz", join(root, "dl2"), {
                fetchImpl: fakeFetch(() => ({ status: 500 })),
            }),
        /500/,
    )
})

test("网络错误：原因链一起展示", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:7897")
    const error = new Error("fetch failed", { cause })
    assert.equal(describeNetworkError(error), "fetch failed；connect ECONNREFUSED 127.0.0.1:7897")
    assert.equal(describeNetworkError(new Error("boom")), "boom")
    assert.equal(describeNetworkError(null), "未知网络错误")
})
