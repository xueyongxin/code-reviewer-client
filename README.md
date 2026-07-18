# Code Reviewer Client

基于 MCP 的桌面端代码审查客户端（Electron + React + TypeScript）。

## 目录

```
code-reviewer-client/
├── src/main/          # Electron 主进程（MCP、审查引擎、SQLite、IPC）
├── src/preload/       # ContextBridge
├── src/renderer/      # React UI
└── src/shared/        # 共用类型与 IPC 通道
```

## 开发

需要 **Node 20 LTS**（勿用 Node 26：`better-sqlite3` 无预编译且本机 Python 3.14 缺 distutils）。

```bash
# 若已解压仓库旁 .tools/node-v20.* ：
export PATH="/Volumes/data/workspace/cursor/code/.tools/node-v20.19.3-darwin-arm64/bin:$PATH"

cd code-reviewer-client
npm install   # postinstall 会按 Electron ABI rebuild sqlite
npm run dev
```

## 本地数据库（SQLite）

按需求使用 `better-sqlite3`：

`~/Library/Application Support/code-reviewer-client/data/review-history.db`

首次启动若发现旧版 `review-history.json`，会自动迁移。也可手动：

```bash
npm run migrate:sqlite
```

## 当前进度（P0 + P1 + P2）

- Electron + Vite + TS / IPC
- MCP 连接管理器
- Git 直连克隆（Gitee / GitHub）
- 静态规则 + 自定义 YAML/JSON
- 多模型 / 多协议 LLM
- Monaco Diff、流程时间线与耗时
- **SQLite 审查历史 + Commit 缓存**
- Token 本地加密、进度条/取消、多仓并行、PR 回写、系统通知

## 双仓联调

```bash
npm run test:repos
npm run seed:history
npm run migrate:sqlite
```

客户端内可点 **「跑需求文档双仓联调」**，Inbox 从 SQLite 读取记录。

示例规则：`resources/sample-rules.yaml`
