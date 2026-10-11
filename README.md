[English](README.en.md) | **中文**

# dsh-delete-session

**在侧栏菜单里真正删掉一个已归档的 DeepSeek Harness 会话** —— 连同磁盘上的对话记录、
缓存投影、工作区分组与 rewind 快照。

## 它加了什么

- **侧栏会话的 `...` 菜单里多一行「删除会话」**：只在会话处于已归档状态时出现，排在官方的
  「取消归档」之后，删除前要你明确确认一次；
- **设置 → 归档会话**：一个专门的页面，列出所有已归档会话、带搜索框；右端是不可逆操作
  （描边 + 主题的错误色，刻意不做成普通按钮）。

确认删除会把这些痕迹一起清掉 —— 清不掉的会如实列出来，而不是说「一些文件」：

| 痕迹 | 位置 |
|---|---|
| 归档集合 id | `workspace.json` → `global.archivedSessionIds` |
| 工作区分组 | `workspace.json` → `tables.workspaces[*].sessionIds` |
| 会话日志 | `sessions/<projectKey>/<id>/` |
| rewind 快照 | `<dshHome>/rewind-snapshots/<id>/` |
| 投影缓存 | `storages/session_projcache/sessions/<id>.json` |
| 运行中的注册表项 | 应用内存里的 live registry |

空掉的 `<projectKey>` 分组目录也会删，但只在它**确实空了**的时候 —— 同一工作区里的第二个
会话不会被牵连。

## 运行要求

| | |
|---|---|
| 系统 | macOS / Linux / Windows 都行（纯 Node，不碰平台 API） |
| Node | 22.6+（`package.json` 的 `engines` 写的就是它） |
| DeepSeek Harness | **0.2.0-rc.2 及以上（0.2.x）** —— 在 `peerDependencies` 里声明，不兼容的版本 DSH 会在加载前拦下 |
| 依赖 | 无运行时依赖；只有 `@deepseek-ai/cordis` 一个 peer |

## 安装

```bash
git clone https://github.com/OGHong/dsh-delete-session && cd dsh-delete-session
sh scripts/install.sh
```

脚本做两件事：`npm install && npm run build`（`lib/` 是构建产物，仓库里不带），
以及**接进 profile** —— 写 `link:` 依赖 + 补进 `dsh.profile.bundles` + 建 `node_modules`
符号链接（改前先备份 `package.json`；已装过就一个字节都不动）。

先看它要做什么：`sh scripts/install.sh --dry-run`；指定 profile：`--profile=web`。

**之后重启一次 DeepSeek Harness** —— 宿主启动时才扫描插件清单，热替换不重读。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: delete-session
  config:
    deleteLog: false     # 默认 true：连磁盘上的对话记录一起删
```

## 安全

- 这一行**只对已归档的会话出现**：归档是「我不想在侧栏看到它」，删除是另一回事，两步分开；
- 删除前要明确确认一次，不是点一下就没；
- 每一步都有守卫（只删 `<dshHome>` 里该删的那一个目录），并且**先释放运行中的会话再动磁盘**
  —— 顺序反了会把刚删掉的投影缓存又写回磁盘；
- 删完做一次收尾审计：还剩什么就列什么，不会把「有残留」说成「已干净」。

## 实现细节

为什么按这个顺序删、十四种「静默失败」各自怎么堵上、目录结构与开发校验方式，
都在 **[docs/DESIGN.md](docs/DESIGN.md)**。

```bash
npm run verify     # 类型检查 + 构建 + 292 条自测断言
```

## License

MIT
