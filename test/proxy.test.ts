import assert from "node:assert/strict"
import { test } from "node:test"

import { createProxyFetch, shouldBypassProxy } from "../src/network/proxy.ts"

test("noProxy 精确匹配与子域后缀", () => {
    const url = new URL("https://api.example.com/v1")
    assert.equal(shouldBypassProxy(url, []), false)
    assert.equal(shouldBypassProxy(url, ["example.com"]), true)
    assert.equal(shouldBypassProxy(url, ["*.example.com"]), true)
    assert.equal(shouldBypassProxy(url, [".example.com"]), true)
    assert.equal(shouldBypassProxy(url, ["other.com"]), false)
    assert.equal(shouldBypassProxy(new URL("http://localhost:8080"), ["localhost"]), true)
    assert.equal(shouldBypassProxy(url, ["*"]), true)
})

test("未配置代理时不返回自定义 fetch", () => {
    assert.equal(createProxyFetch(null), undefined)
})
