# sandbox-escape-test

用于验证插件 sandbox 是否会拒绝下列操作：

- `import node:fs` / `node:child_process`
- `process.getBuiltinModule()` 绕过 import 读写文件/执行命令
- 宿主文件 API 路径穿越
- 未声明权限的 workspace 写入
- 直接网络访问

## 使用

```bash
wellspring plugin link ./plugins/sandbox-escape-test
wellspring plugin list
wellspring escape-test
```

期望输出里除 `ctx.fs 写插件 data` 外全部是 `DENIED`，退出码 0。

如果插件加载失败，先看 `plugin list` 的错误；如果输出出现 `ALLOWED`，说明隔离有漏洞。
