# Code Reviewer Client

基于 MCP 的桌面端代码审查客户端（Electron + React + TypeScript）。

## 目录

```
code-reviewer-client/
├── src/main/          # Electron 主进程（MCP、审查引擎、SQLite、IPC）
├── src/preload/       # ContextBridge
├── src/renderer/      # React UI
├── src/shared/        # 共用类型与 IPC 通道
├── scripts/           # 打包辅助（Win/Linux 预编译注入等）
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

## 打包

```bash
npm run pack              # 当前平台
npm run pack:mac
node scripts/pack-win-linux.mjs   # 交叉打 Win/Linux（注入预编译 better-sqlite3）
npm run verify:pack       # 若有该脚本
```

构建配置以 `package.json` 的 `build` 字段为准，并与 `electron-builder.yml` 保持对齐。

## 功能概览

- MCP 连接 / Git 直连克隆
- 静态规则 + 自定义 YAML/JSON
- 多模型 LLM、对话 Slash、Monaco Diff
- SQLite 历史、云端登录与配置中心同步
- 开发态可从工作区读取 `需求文档.md` 做联调（正式包装禁用）

示例规则：`resources/sample-rules.yaml`
