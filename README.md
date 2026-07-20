# Code Reviewer Client

基于 MCP 的桌面端代码审查客户端（Electron + React + TypeScript）。

近期能力变更见仓库根目录 [`更新日志.md`](../更新日志.md)。

## 目录

```
code-reviewer-client/
├── src/main/          # Electron 主进程（MCP、审查引擎、SQLite、IPC）
├── src/preload/       # ContextBridge
├── src/renderer/      # React UI
├── src/shared/        # 共用类型与 IPC 通道
├── scripts/           # 打包辅助与回归脚本
└── resources/         # 构建资源（图标、示例规则）
```

## 开发

需要 **Node 20 LTS**（勿用 Node 26：`better-sqlite3` 无预编译且本机 Python 3.14 缺 distutils）。

```bash
export PATH="/Volumes/data/workspace/cursor/code/.tools/node-v20.19.3-darwin-arm64/bin:$PATH"
cd code-reviewer-client
npm install   # postinstall 会按 Electron ABI rebuild sqlite
npm run dev
npm run typecheck
```

本地 SQLite：`~/Library/Application Support/code-reviewer-client/data/review-history.db`  
首次启动若发现旧版 `review-history.json` 会自动迁移。

密钥（LLM / MCP Token / 云端 Token）落盘加密；渲染进程仅见脱敏掩码。

**主进程改动后需重启** `npm run dev`（Vite HMR 不覆盖 main）。

## 打包

```bash
npm run pack              # 当前平台
npm run pack:mac
node scripts/pack-win-linux.mjs   # 交叉打 Win/Linux（注入预编译 better-sqlite3）
```

构建配置以 `package.json` 的 `build` 字段为准，并与 `electron-builder.yml` 保持对齐。

## 功能概览（与当前代码一致）

| 模块 | 能力 |
| :--- | :--- |
| 顶栏模式 | **IDE**（`/review/editor`）与 **审查**（流水线首页）切换 |
| IDE | 打开本地文件夹 / 流水线项目；多标签；`WorkspaceEditor`；`⌘S` 保存；`⌘P` 快速打开；资源管理器右键 |
| 共用编辑器 | md/html（`.md` `.markdown` `.html` `.htm`）支持 **预览 \| 编辑**；默认预览；其它文件 Monaco |
| 流水线 | 四列画布（源→审查→模型→报告）；只读/编辑；运行历史；「查看项目」进 IDE |
| 审查执行 | MCP / Git 直连；静态规则 + 自定义规则 + 多模型 LLM；结果**只保留 error** |
| 报告页 | 左工作区 / 中 Diff 或编辑器 / 右流程节点；富文档始终编辑器；有 error 的源码才 Diff |
| 报告落盘 | 优先 `{项目根}/分析报告/`；格式按流水线配置（默认 md+html，可选 json） |
| 代码仓库设置 | 拉取云端平台目录 `GET /api/v1/code-repo-catalog`；失败用本地兜底列表；Token 连接与校验 |
| Git | 平台 Token 鉴权；浏览仓软更新在脏工作区时跳过，避免覆盖本地编辑 |
| 其它 | SQLite 历史；云端登录与配置同步；对话；`electron-updater`；时间统一 `YYYY-MM-DD HH:mm:ss` |
| 文件树 | 隐藏 `.DS_Store` / `Thumbs.db` / `Desktop.ini` |

示例规则：`resources/sample-rules.yaml`
