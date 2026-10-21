# hello-plugin

Wellspring 官方示例插件：演示顶层钩子、`setup()` 元信息、插件命令与生命周期钩子。

## 加载

```bash
# 直接链接仓库里的示例（开发用）
wellspring plugin link ./examples/hello-plugin

# 或者复制/安装
wellspring plugin install ./examples/hello-plugin
```

## 使用

```bash
wellspring plugin list
wellspring hello a b
wellspring start        # 触发 onInit；Ctrl+C 触发 onShutdown
```

## 说明

- 入口使用具名导出 `setup(): WellspringPlugin`
- 插件可以从 `wellspring/api/host/index.ts` 导入钩子与 `shutdown()`；这个路径只在通过 wellspring 加载时可用
- 插件里的 `console.*` 会被平台拦截，输出请用 `ctx.logger` / `ctx.output` / `api.logger`
