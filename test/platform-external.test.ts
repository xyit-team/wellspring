import assert from "node:assert/strict"
import { test } from "node:test"

import { buildClipboardCommands } from "../src/platform/clipboard.ts"
import {
    CommandFailedError,
    CommandNotFoundError,
    powershellArgs,
    runCommand,
} from "../src/platform/exec.ts"
import { buildNotifyCommands, notify } from "../src/platform/notification.ts"
import { buildOpenCommands, openExternal } from "../src/platform/open-external.ts"

function decodePowershell(args: readonly string[]): string {
    const index = args.indexOf("-EncodedCommand")
    const encoded = index === -1 ? undefined : args[index + 1]
    assert.ok(encoded !== undefined, "缺少 -EncodedCommand 参数")
    return Buffer.from(encoded, "base64").toString("utf16le")
}

test("buildOpenCommands 各平台候选", () => {
    assert.deepEqual(buildOpenCommands("https://example.com", "windows"), [
        { command: "cmd", args: ["/c", "start", "", "https://example.com/"] },
    ])
    assert.deepEqual(buildOpenCommands("https://example.com", "macos"), [
        { command: "open", args: ["https://example.com/"] },
    ])
    assert.deepEqual(buildOpenCommands("https://example.com", "linux", false), [
        { command: "xdg-open", args: ["https://example.com/"] },
        { command: "gio", args: ["open", "https://example.com/"] },
    ])
})

test("buildOpenCommands WSL 优先 wslview 与 explorer.exe", () => {
    const commands = buildOpenCommands("https://example.com", "linux", true)
    assert.deepEqual(
        commands.map((item) => item.command),
        ["wslview", "explorer.exe", "xdg-open", "gio"],
    )
})

test("buildOpenCommands Android 与 Termux", () => {
    const termux = buildOpenCommands("https://example.com", "android", false, true)
    assert.deepEqual(
        termux.map((item) => item.command),
        ["termux-open", "xdg-open", "am"],
    )

    const sandbox = buildOpenCommands("https://example.com", "android", false, false)
    assert.deepEqual(
        sandbox.map((item) => item.command),
        ["xdg-open", "am"],
    )

    // 本地路径无法转换为 content:// URI，不生成 am 候选
    const local = buildOpenCommands("/tmp/file.txt", "android", false, true)
    assert.deepEqual(
        local.map((item) => item.command),
        ["termux-open", "xdg-open"],
    )
})

test("buildOpenCommands 校验目标", () => {
    assert.throws(() => buildOpenCommands("", "linux"), /打开目标为空值/)
    assert.throws(() => buildOpenCommands("-rf", "linux"), /不能以 "-" 开头/)
    assert.throws(() => buildOpenCommands("a\u0000b", "linux"), /控制字符/)
    assert.throws(() => buildOpenCommands("javascript:alert(1)", "linux"), /不允许的协议/)
    assert.throws(() => buildOpenCommands("not-a-path", "linux"), /既非绝对路径也非合法 URL/)
})

test("openExternal 拒绝非法目标", async () => {
    await assert.rejects(openExternal(""), /打开目标为空值/)
})

test("buildClipboardCommands windows 走 PowerShell 编码命令", () => {
    const commands = buildClipboardCommands("windows", false)
    assert.equal(commands.write[0]?.command, "powershell")
    assert.equal(commands.read[0]?.command, "powershell")
    assert.ok(commands.write[0]?.args.includes("-EncodedCommand"))
    assert.match(decodePowershell(commands.write[0]?.args ?? []), /Set-Clipboard/)
    assert.match(decodePowershell(commands.read[0]?.args ?? []), /Get-Clipboard/)
})

test("buildClipboardCommands macos", () => {
    const commands = buildClipboardCommands("macos", false)
    assert.deepEqual(commands.write, [{ command: "pbcopy", args: [] }])
    assert.deepEqual(commands.read, [{ command: "pbpaste", args: [] }])
})

test("buildClipboardCommands linux 候选顺序", () => {
    const commands = buildClipboardCommands("linux", false)
    assert.deepEqual(
        commands.write.map((item) => item.command),
        ["wl-copy", "xclip", "xsel"],
    )
    assert.deepEqual(
        commands.read.map((item) => item.command),
        ["wl-paste", "xclip", "xsel"],
    )
})

test("buildClipboardCommands Android", () => {
    const termux = buildClipboardCommands("android", true)
    assert.deepEqual(termux.write, [{ command: "termux-clipboard-set", args: [] }])
    assert.deepEqual(termux.read, [{ command: "termux-clipboard-get", args: [] }])

    const sandbox = buildClipboardCommands("android", false)
    assert.deepEqual(sandbox, { write: [], read: [] })
})

test("buildNotifyCommands windows 编码脚本包含标题与正文", () => {
    const commands = buildNotifyCommands({ title: "标题", body: "正文" }, "windows")
    const args = commands[0]?.args ?? []
    const script = decodePowershell(args)
    assert.equal(commands[0]?.command, "powershell")
    assert.match(script, /'标题'/)
    assert.match(script, /'正文'/)
    assert.match(script, /ToastText02/)
})

test("buildNotifyCommands PowerShell 单引号转义", () => {
    const commands = buildNotifyCommands({ title: "it's", body: "" }, "windows")
    const script = decodePowershell(commands[0]?.args ?? [])
    assert.match(script, /'it''s'/)
})

test("buildNotifyCommands macos 用环境变量传参", () => {
    const commands = buildNotifyCommands({ title: "标题", body: "正文" }, "macos")
    assert.equal(commands[0]?.command, "osascript")
    assert.deepEqual(commands[0]?.env, {
        WELLSPRING_NOTIFY_TITLE: "标题",
        WELLSPRING_NOTIFY_BODY: "正文",
    })
})

test("buildNotifyCommands linux 与空正文", () => {
    const commands = buildNotifyCommands({ title: "标题" }, "linux", false)
    assert.deepEqual(commands, [
        { command: "notify-send", args: ["-a", "wellspring", "--", "标题"] },
    ])
})

test("buildNotifyCommands WSL 优先 Windows toast", () => {
    const commands = buildNotifyCommands({ title: "标题" }, "linux", true)
    assert.deepEqual(
        commands.map((item) => item.command),
        ["powershell.exe", "notify-send"],
    )
})

test("buildNotifyCommands Android 使用 termux-notification", () => {
    const commands = buildNotifyCommands({ title: "标题", body: "正文" }, "android")
    assert.deepEqual(commands, [
        { command: "termux-notification", args: ["--title", "标题", "--content", "正文"] },
    ])
})

test("buildNotifyCommands 拒绝空标题", () => {
    assert.throws(() => buildNotifyCommands({ title: " " }, "linux"), /通知标题为空/)
})

test("notify 在发送前校验标题", async () => {
    await assert.rejects(notify({ title: "" }), /通知标题为空/)
})

test("runCommand 收集 stdout", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"])
    assert.equal(result.stdout, "ok")
})

test("runCommand 写入 stdin", async () => {
    const result = await runCommand(
        process.execPath,
        ["-e", "process.stdin.pipe(process.stdout)"],
        {
            input: "hello",
        },
    )
    assert.equal(result.stdout, "hello")
})

test("runCommand 命令缺失", async () => {
    await assert.rejects(
        runCommand("wellspring-missing-command-xyz"),
        (error) => error instanceof CommandNotFoundError,
    )
})

test("runCommand 非零退出", async () => {
    await assert.rejects(
        runCommand(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"]),
        (error) =>
            error instanceof CommandFailedError && error.exitCode === 3 && error.stderr === "bad",
    )
})

test("runCommand 超时", async () => {
    await assert.rejects(
        runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 }),
        /命令执行超时/,
    )
})

test("powershellArgs 生成 UTF-16LE Base64", () => {
    const script = "Write-Output 'hi'"
    const args = powershellArgs(script)
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"])
    assert.equal(decodePowershell(args), script)
})
