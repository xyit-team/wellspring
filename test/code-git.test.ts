import assert from "node:assert/strict"
import { test } from "node:test"

import { parseGitStatus, workspaceRelativePath } from "../plugins/wellspring-code/src/git.ts"

test("Git 状态解析：分支、ahead/behind 与分组状态", () => {
    const output = [
        "## main...origin/main [ahead 1, behind 2]",
        "M  src/a.ts",
        " M src/b.ts",
        "?? new file.txt",
        "R  src/renamed.ts",
        "src/old.ts",
        "",
    ].join("\u0000")
    const parsed = parseGitStatus(output, "/repo", "/repo")
    assert.equal(parsed.branch, "main")
    assert.equal(parsed.ahead, 1)
    assert.equal(parsed.behind, 2)
    assert.equal(parsed.truncated, false)
    assert.deepEqual(
        parsed.changes.map((change) => [
            change.path,
            change.letter,
            change.staged,
            change.untracked,
        ]),
        [
            ["src/a.ts", "M", true, false],
            ["src/b.ts", "M", false, false],
            ["new file.txt", "?", false, true],
            ["src/renamed.ts", "R", true, false],
        ],
    )
})

test("Git 状态解析：只保留工作区内的路径", () => {
    const output = ["## main", "M  project/src/a.ts", "M  other/src/b.ts", ""].join("\u0000")
    const parsed = parseGitStatus(output, "/repo", "/repo/project")
    assert.deepEqual(
        parsed.changes.map((change) => change.path),
        ["src/a.ts"],
    )
    assert.equal(workspaceRelativePath("/repo", "/repo/project", "project/src/a.ts"), "src/a.ts")
    assert.equal(workspaceRelativePath("/repo", "/repo/project", "other/src/b.ts"), null)
    assert.equal(workspaceRelativePath("/repo", "/repo/project", "project"), "")
    assert.equal(workspaceRelativePath("/repo", "/repo/project", "project/../secret"), null)
})

test("Git 状态解析：忽略被忽略文件与 detached HEAD", () => {
    const output = ["## HEAD (no branch)", "!! dist/", "", ""].join("\u0000")
    const parsed = parseGitStatus(output, "/repo", "/repo")
    assert.equal(parsed.branch, "HEAD")
    assert.deepEqual(parsed.changes, [])
})
