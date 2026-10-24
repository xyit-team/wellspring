export const HOME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wellspring</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #f5f3ee; color: #1f2328; }
@media (prefers-color-scheme: dark) { body { background: #14161a; color: #e6e8eb; } }
.shell { width: min(900px, 100%); margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
.card { width: min(420px, calc(100% - 32px)); margin: 10vh auto 0; padding: 28px; border-radius: 16px; background: #fff; border: 1px solid #ddd8cd; box-shadow: 0 20px 50px rgba(0,0,0,.08); }
@media (prefers-color-scheme: dark) { .card { background: #1c1f24; border-color: #2c3138; box-shadow: none; } }
h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: -.02em; }
.sub { margin: 0 0 22px; color: #777; font-size: 14px; line-height: 1.6; }
label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
input, textarea, button { font: inherit; }
input, textarea { width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid #ccc6b9; background: #fff; color: inherit; }
@media (prefers-color-scheme: dark) { input, textarea { background: #15181c; border-color: #333942; } }
button { padding: 10px 16px; border-radius: 9px; border: 0; background: #1f6feb; color: #fff; cursor: pointer; font-weight: 600; }
button:disabled { opacity: .55; cursor: wait; }
.error { min-height: 20px; margin-top: 12px; color: #c43b3b; font-size: 13px; }
.hidden { display: none !important; }
.chat { flex: 1; display: flex; flex-direction: column; }
header.bar { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid #ddd8cd; }
@media (prefers-color-scheme: dark) { header.bar { border-color: #2c3138; } }
header.bar .brand { font-weight: 700; letter-spacing: -.02em; }
header.bar button { background: transparent; color: inherit; border: 1px solid #ccc6b9; padding: 6px 10px; font-weight: 500; }
.messages { flex: 1; overflow-y: auto; padding: 24px 20px 140px; display: flex; flex-direction: column; gap: 16px; }
.msg { max-width: 78%; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px 13px; border-radius: 13px; }
.msg.user { align-self: flex-end; background: #1f6feb; color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant { align-self: flex-start; background: #fff; border: 1px solid #ddd8cd; border-bottom-left-radius: 4px; }
@media (prefers-color-scheme: dark) { .msg.assistant { background: #1c1f24; border-color: #2c3138; } }
.composer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px max(16px, calc((100vw - 900px) / 2)); background: linear-gradient(transparent, #f5f3ee 28%); }
@media (prefers-color-scheme: dark) { .composer { background: linear-gradient(transparent, #14161a 28%); } }
.composer .inner { display: flex; gap: 10px; align-items: flex-end; padding: 8px; border-radius: 14px; background: #fff; border: 1px solid #ccc6b9; }
@media (prefers-color-scheme: dark) { .composer .inner { background: #1c1f24; border-color: #333942; } }
.composer textarea { border: 0; resize: none; min-height: 42px; max-height: 150px; padding: 9px 10px; background: transparent; outline: none; }
.composer button { margin: 3px; flex: 0 0 auto; }
</style>
</head>
<body>
<div class="shell">
  <div id="setup" class="card hidden">
    <h1>设置访问密码</h1>
    <p class="sub">第一次使用，请为这个页面设置密码。</p>
    <form id="setup-form">
      <label for="setup-password">密码</label>
      <input id="setup-password" type="password" minlength="6" autocomplete="new-password" required>
      <label for="setup-confirm">确认密码</label>
      <input id="setup-confirm" type="password" minlength="6" autocomplete="new-password" required>
      <div class="error" id="setup-error"></div>
      <button type="submit">保存并进入</button>
    </form>
  </div>

  <div id="login" class="card hidden">
    <h1>Wellspring</h1>
    <p class="sub">输入密码继续。</p>
    <form id="login-form">
      <label for="login-password">密码</label>
      <input id="login-password" type="password" autocomplete="current-password" required>
      <div class="error" id="login-error"></div>
      <button type="submit">进入</button>
    </form>
  </div>

  <div id="chat" class="chat hidden">
    <header class="bar">
      <div class="brand">Wellspring</div>
      <button id="logout" type="button">退出</button>
    </header>
    <div id="messages" class="messages"></div>
    <div class="composer">
      <div class="inner">
        <textarea id="message" rows="1" placeholder="输入消息…"></textarea>
        <button id="send" type="button">发送</button>
      </div>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let sessionId = null;
let busy = false;

function show(id) {
  for (const name of ["setup", "login", "chat"]) {
    $(name).classList.toggle("hidden", name !== id);
  }
}

async function call(path, options) {
  const response = await fetch(path, {
    ...(options || {}),
    headers: { "content-type": "application/json", ...((options && options.headers) || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || ("HTTP " + response.status));
  }
  return data;
}

async function refresh() {
  try {
    const state = await call("/api/state");
    if (!state.configured) {
      show("setup");
    } else if (!state.authenticated) {
      show("login");
    } else {
      show("chat");
      $("message").focus();
    }
  } catch (error) {
    $("login-error").textContent = error.message;
    show("login");
  }
}

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("setup-password").value;
  if (password !== $("setup-confirm").value) {
    $("setup-error").textContent = "两次密码不一致";
    return;
  }
  try {
    await call("/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) });
    show("chat");
    $("message").focus();
  } catch (error) {
    $("setup-error").textContent = error.message;
  }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: $("login-password").value }),
    });
    show("chat");
    $("message").focus();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});

$("logout").addEventListener("click", async () => {
  await call("/api/auth/logout", { method: "POST" }).catch(() => {});
  sessionId = null;
  $("messages").replaceChildren();
  show("login");
});

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = "msg " + role;
  node.textContent = text;
  $("messages").append(node);
  node.scrollIntoView({ block: "end" });
}

async function send() {
  if (busy) return;
  const input = $("message");
  const text = input.value.trim();
  if (text === "") return;
  input.value = "";
  addMessage("user", text);
  const answer = addMessage("assistant", "");
  busy = true;
  $("send").disabled = true;
  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, sessionId }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || ("HTTP " + response.status));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const raw of events) {
        if (!raw.startsWith("data:")) continue;
        const data = JSON.parse(raw.slice(5).trim());
        if (data.type === "delta") {
          answer.textContent += data.text;
          answer.scrollIntoView({ block: "end" });
        } else if (data.type === "done") {
          sessionId = data.sessionId;
          if (!answer.textContent) answer.textContent = data.reply || "（空回复）";
        } else if (data.type === "error") {
          throw new Error(data.error || "Agent 执行失败");
        }
      }
    }
  } catch (error) {
    if (String(error.message).includes("401")) {
      show("login");
    } else {
      answer.textContent += (answer.textContent ? "\n" : "") + "出错了：" + error.message;
    }
  } finally {
    busy = false;
    $("send").disabled = false;
    input.focus();
  }
}

$("send").addEventListener("click", send);
$("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

refresh();
</script>
</body>
</html>`
