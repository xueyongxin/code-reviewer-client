# code-reviewer-client

Code Reviewer **桌面端**（Electron + React + TypeScript）：本机 IDE、审查流水线、对话助手与大模型记忆。

审查默认在本机执行；经「设置 → 代码仓库」鉴权后 **Git 克隆**到工作目录跑流水线（MCP 用于工具扩展，**不是**拉码主路径）。云端只同步账号、配置与审查记录摘要。大模型记忆默认存本机 SQLite，**账号云端记忆同步尚未开放**（可用 JSON 导入导出跨机）。

## 技术栈

| 类别 | 选型 |
| :--- | :--- |
| 壳 / 构建 | Electron 28、electron-vite、electron-builder、electron-updater |
| UI | React 18、Ant Design 5、React Router、Zustand、Monaco Editor |
| 本机数据 | better-sqlite3（审查历史 + `llm_memories`） |
| 配置落盘 | electron-store（密钥加密；渲染进程仅见脱敏掩码） |
| 协议 / 工具 | MCP SDK（`@modelcontextprotocol/sdk`）、js-yaml（规则） |
| 运行时 | **Node 20 LTS**（勿用 Node 26：`better-sqlite3` 缺预编译） |

相关仓库：`code-reviewer-server`（云端 API）、`code-reviewer-admin`（官网 / Web 控制台）。

## 目录

```
code-reviewer-client/
├── src/main/          # 主进程：审查引擎、记忆、MCP、SQLite、IPC、更新
├── src/preload/       # ContextBridge
├── src/renderer/      # React UI（流水线 / IDE / 报告 / 对话 / 设置）
├── src/shared/        # 共用类型与 IPC 通道
├── scripts/           # 打包辅助与回归脚本
└── resources/         # 图标、示例规则等
```

## 功能概览

| 模块 | 能力 |
| :--- | :--- |
| 主导航 | **代码审查**（流水线）、**审查记录**、**新对话**；顶栏可切 IDE / 审查 |
| IDE | 打开本地文件夹或流水线项目；多标签；`⌘S` 保存；`⌘P` 快速打开；md/html 预览\|编辑 |
| 流水线看板 | 四列：流水线源 → 审查 → 模型 → 报告；流程配置 / 最近运行 / 运行历史；批量运行 |
| 拉码 | 主路径：**Git 克隆**（平台 Token）；设置中可开关；缓存命中可跳过 |
| 审查执行 | 静态规则 + 自定义规则 + 多模型 LLM；合并后**仅保留 error**；可取消 |
| 报告 | 三栏：文件树（error 计数）/ Diff 或编辑器 / 流程时间线；导出 md / html / json |
| 报告落盘 | 优先 `{项目根}/分析报告/`，否则全局报告目录 |
| 对话助手 | 多模型、附件、关联「审查过的代码仓库」、`/remember`、沉淀本轮、临时排除记忆 |
| 大模型记忆 | 本机 SQLite；设置页管理；对话/审查注入；hybrid 检索；容量与去重；JSON 备份；可选 Memory MCP 导入 |
| 设置 | 账号、通用、代码仓库（云端目录）、MCP、模型、记忆、规则 |
| 其它 | 云端登录与配置同步；`electron-updater`；时间统一 `YYYY-MM-DD HH:mm:ss` |

示例规则：`resources/sample-rules.yaml`  
记忆能力清单（产品侧）：仓库外根目录 `记忆.md`（若存在）。

## 开发

```bash
cd code-reviewer-client
npm install   # postinstall 会按 Electron ABI rebuild better-sqlite3
npm run dev
npm run typecheck
```

| 项 | 说明 |
| :--- | :--- |
| SQLite | macOS：`~/Library/Application Support/code-reviewer-client/data/review-history.db` |
| 迁移 | 首次启动若存在旧版 `review-history.json` 会自动迁移 |
| 热更新 | **主进程改动后需重启** `npm run dev`（Vite HMR 不覆盖 main） |
| 开发端口 | 渲染进程默认 `127.0.0.1:5188`（见 `electron.vite.config.ts`） |

## 打包

```bash
npm run pack              # 当前平台目录包
npm run pack:mac
node scripts/pack-win-linux.mjs   # 交叉 Win/Linux（注入预编译 better-sqlite3）
npm run verify:pack
```

构建以 `package.json` 的 `build` 字段为准，并与 `electron-builder.yml` 对齐。协议 scheme：`codereviewer://`。

## 常用脚本

```bash
npm run dev
npm run typecheck
npm run build
npm run pack / pack:mac / pack:win-linux
node scripts/smoke-memory.mjs   # 记忆相关冒烟（如有）
```
