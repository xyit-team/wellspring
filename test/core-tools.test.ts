import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"

import pino from "pino"

import { DEFAULT_SETTINGS } from "../src/config/defaults.ts"
import type { ResolvedPaths } from "../src/platform/path.ts"
import { DirectBackend } from "../src/sandbox/backends/direct.ts"
import { AgentToolRegistry } from "../src/plugin/agent-tools.ts"
import { loadPlugins } from "../src/plugin/loader.ts"
import { PluginRegistry } from "../src/plugin/registry.ts"
import { shutdownAllSandboxPlugins } from "../src/sandbox/plugin-client.ts"

let root = ""
let dataDir = ""

before(async () => {
    root = await mkdtemp(join(tmpdir(), "wellspring-skill-quoting-"))
    dataDir = join(root, "data")
})

after(async () => {
    await shutdownAllSandboxPlugins()
    await rm(root, { recursive: true, force: true })
})

function paths(): ResolvedPaths {
    return {
        configDir: join(root, "config"),
        dataDir,
        cacheDir: join(root, "cache"),
        logDir: join(root, "logs"),
        sources: {
            configDir: "override",
            dataDir: "override",
            cacheDir: "override",
            logDir: "override",
        },
    }
}

let cachedTools: AgentToolRegistry | null = null

/** 插件加载较慢，两个用例共用同一套已注册工具 */
async function coreTools(): Promise<AgentToolRegistry> {
    cachedTools ??= await loadCoreTools()
    return cachedTools
}

async function loadCoreTools(): Promise<AgentToolRegistry> {
    const destination = join(dataDir, "plugins", "wellspring-core")
    await cp(resolve(import.meta.dirname, "../plugins/wellspring-core"), destination, {
        recursive: true,
    })
    const agentTools = new AgentToolRegistry()
    const plugins = await loadPlugins({
        paths: paths(),
        config: {
            ...DEFAULT_SETTINGS,
            sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        },
        logger: pino({ level: "silent" }),
        registry: new PluginRegistry(),
        agentTools,
        sandbox: { ...DEFAULT_SETTINGS.sandbox, mode: "best-effort" },
        sandboxBackend: new DirectBackend(),
    })
    assert.equal(plugins.find((plugin) => plugin.id === "wellspring-core")?.status, "ok")
    return agentTools
}

test("skill_modify 容忍 description / whenToUse 多包一层引号", { timeout: 20_000 }, async () => {
    const agentTools = await coreTools()
    const install = agentTools.get("skill_install")
    const modify = agentTools.get("skill_modify")
    const read = agentTools.get("skill_read")
    const list = agentTools.get("skill_list")
    assert.ok(install)
    assert.ok(modify)
    assert.ok(read)
    assert.ok(list)

    const content = [
        "---",
        "name: quoted-skill",
        "description: 原始说明",
        "whenToUse: 原始时机",
        "---",
        "# 正文",
        "",
    ].join("\n")
    assert.equal((await install.tool.call({ content })).success, true)

    // 第一次按 YAML 习惯传了带引号的字符串：落盘不能再套一层
    const modified = await modify.tool.call({
        name: "quoted-skill",
        description: '"工具自检用临时技能"',
        whenToUse: "'需要自检时'",
    })
    assert.equal(modified.success, true)

    const reread = await read.tool.call({ name: "quoted-skill" })
    assert.equal(reread.success, true)
    const skill = reread.data["skill"] as { description: string; whenToUse?: string }
    assert.equal(skill.description, "工具自检用临时技能")
    assert.equal(skill.whenToUse, "需要自检时")

    const listed = await list.tool.call({})
    const item = (listed.data as { skills: Array<Record<string, unknown>> }).skills.find(
        (entry) => entry["name"] === "quoted-skill",
    )
    assert.equal(item?.["description"], "工具自检用临时技能")
    assert.equal(item?.["whenToUse"], "需要自检时")

    const raw = await readFile(
        join(dataDir, "plugin-data", "wellspring-core", "skills", "quoted-skill", "SKILL.md"),
        "utf8",
    )
    assert.ok(!raw.includes('\\"'), `frontmatter 不应出现嵌套引号：\n${raw}`)
    // 中文会被 YAML 序列化成一层引号，这是正常的；关键是不能再嵌套
    assert.match(raw, /description: "工具自检用临时技能"/)
    assert.match(raw, /whenToUse: "需要自检时"/)

    // 裸文本行为不变
    const plain = await modify.tool.call({ name: "quoted-skill", description: "普通说明" })
    assert.equal(plain.success, true)
    const again = await read.tool.call({ name: "quoted-skill" })
    assert.equal((again.data["skill"] as { description: string }).description, "普通说明")
})

test(
    "web_search / web_fetch 缺 Key 时返回明确错误，不再静默空结果",
    { timeout: 20_000 },
    async () => {
        const agentTools = await coreTools()
        const search = agentTools.get("web_search")
        const fetchTool = agentTools.get("web_fetch")
        assert.ok(search)
        assert.ok(fetchTool)
        const saved = process.env["OPENAI_API_KEY"]
        delete process.env["OPENAI_API_KEY"]
        try {
            const searched = await search.tool.call({ query: "DeepSeek" })
            assert.equal(searched.success, false, "缺 Key 时 web_search 必须失败")
            assert.match(String(searched.data["error"]), /web\.missing-api-key/)
            const fetched = await fetchTool.tool.call({ url: "https://example.com" })
            assert.equal(fetched.success, false, "缺 Key 时 web_fetch 必须失败")
            assert.match(String(fetched.data["error"]), /web\.missing-api-key/)
        } finally {
            if (saved !== undefined) {
                process.env["OPENAI_API_KEY"] = saved
            }
        }
    },
)
