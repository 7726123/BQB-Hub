# 提交规范（Conventional Commits）

项目所有提交使用 Conventional Commits 格式，便于生成变更日志与版本判断：

```
<type>(<scope>): <subject>

<body（可选，说明为什么，而不是做了什么）>
```

## Type 一览

| Type | 含义 |
|---|---|
| `feat` | 新功能（如 v32~v41 各版本功能） |
| `fix` | 缺陷修复 |
| `refactor` | 重构，行为不变（如本工程化重构） |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建/工具/依赖等杂项 |
| `perf` | 性能优化 |

## Scope 建议

`server`（服务端：`server-java/` 为主、`server/` 只收安全修复）、`app`（`app/src` 源码与 `web/` 产物）、
`android`、`build`、`docs`、`scripts`、`brand`（图标 / 启动图 / 品牌外观）、`release`（发版收尾类提交）。

> 历史提交里 scope 曾写过 `frontend`（同一含义）；新提交统一用 `app`，与 `app/` 目录、`app/tests` 对得上。

## 示例

```
feat(app): 使用助手注入最近 20 轮对话

修复历史在重启后丢失的问题：init 延后到存储就绪之后，
sendMessage 注入 messages.slice(-41, -1)。
```

## 说明

- 同一逻辑改动不要拆多个提交；跨端改动（前后端同功能）可以一个提交带两个 scope。
- `refactor` 类提交承诺不改变对外行为——这是本仓库重构期间最重要的约定。