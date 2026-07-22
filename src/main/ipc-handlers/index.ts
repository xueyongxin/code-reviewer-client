import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type {
  AppConfig,
  MemoryListQuery,
  PostPrCommentsPayload,
  SendChatPayload,
  StartReviewPayload,
  UpsertMemoryInput
} from '../../shared/types'
import {
  getAppConfig,
  mergeSecretsFromExisting,
  redactConfigForRenderer,
  saveAppConfig
} from '../config/store'
import {
  deleteReviewReport,
  deleteLlmMemory,
  deleteOldestLlmMemories,
  getLatestReviewReport,
  getLlmMemoryById,
  listLlmMemories,
  listReviewReports,
  getReviewReportById,
  setLlmMemoryEnabled,
  upsertLlmMemory
} from '../database/db'
import { mcpRegistry } from '../mcp-manager/registry'
import { reviewOrchestrator } from '../review-engine/orchestrator'
import { parseCustomRulesFile } from '../review-engine/custom-rules'
import { postSelectedIssuesAsPrComments } from '../review-engine/pr-comments'
import { checkAppUpdates } from '../updater'
import { applyDocLlmConfig, buildDocDemoPayloads, loadDocDemoConfig } from '../review-engine/doc-demo'
import { chatService } from '../review-engine/chat-service'
import {
  distillMemoriesFromChat,
  exportMemoriesPayload,
  importFromMemoryMcp,
  importMemoriesPayload,
  memoryStats,
  upsertMemoryWithDedup
} from '../review-engine/memory-service'
import { listBranchesFromMcp, listReposFromMcp, warmMcpRepoCache } from '../review-engine/mcp-repos'
import {
  createRepoDir,
  listRepoFiles,
  readRepoFile,
  writeRepoFile
} from '../review-engine/repo-browser'
import {
  createLocalDir,
  deleteLocalEntry,
  listLocalFolder,
  openLocalFolderDialog,
  pickLocalDirectory,
  readLocalFile,
  renameLocalEntry,
  saveLocalFileDialog,
  writeLocalFile
} from '../review-engine/local-files'
import { clearMcpRepoCache } from '../review-engine/mcp-cache'
import {
  cloudAddMcpFromCatalog,
  cloudFetchMcpCatalog,
  cloudFetchChatCommands,
  cloudFetchCodeRepoCatalog,
  cloudFetchLlmCatalog,
  cloudFetchReviewMethods,
  cloudListOrgs,
  cloudLogin,
  cloudLoginPhone,
  cloudLoginSms,
  cloudLogout,
  cloudPullConfig,
  cloudRegister,
  cloudRegisterPhone,
  cloudSendSms,
  cloudSetOrg,
  cloudStartBrowserLogin,
  cloudOpenAccountManage,
  cloudOpenConsolePath,
  cloudRefreshProfile,
  cloudSyncEndpoints,
  cloudUploadLatestReport
} from '../cloud/client'

const toRendererConfig = (config: AppConfig): AppConfig =>
  redactConfigForRenderer(config)

export const registerIpcHandlers = (getWindow: () => BrowserWindow | null): void => {
  ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => toRendererConfig(getAppConfig()))

  ipcMain.handle(IPC_CHANNELS.SAVE_CONFIG, (_event, config: AppConfig) => {
    const merged = mergeSecretsFromExisting(config, getAppConfig())
    return toRendererConfig(saveAppConfig(merged))
  })

  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_APP_VERIFY,
    async (
      _event,
      payload: { providerId: string; accessToken?: string; baseUrl?: string }
    ) => {
      const { verifyExternalAppAuth } = await import('../review-engine/git-auth')
      return verifyExternalAppAuth({
        providerId: payload.providerId as import('../../shared/code-repo-providers').CodeRepoProviderId,
        accessToken: payload.accessToken,
        baseUrl: payload.baseUrl
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_APP_GET_SECRET,
    (_event, providerId: string) => {
      const config = getAppConfig()
      const conn = config.externalApps?.providers?.[providerId]
      const accessToken =
        conn?.accessToken?.trim() ||
        (providerId === 'github' ? config.githubToken?.trim() : '') ||
        ''
      return {
        accessToken,
        baseUrl: conn?.baseUrl?.trim() || ''
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_APP_LIST_REPOS,
    async (
      _event,
      payload?: { providerId?: string; forceRefresh?: boolean }
    ) => {
      const { listReposFromExternalApps } = await import(
        '../review-engine/external-app-repos'
      )
      return listReposFromExternalApps(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_APP_LIST_BRANCHES,
    async (
      _event,
      payload: { providerId: string; repoUrl: string }
    ) => {
      const { listBranchesFromExternalApp } = await import(
        '../review-engine/external-app-repos'
      )
      return listBranchesFromExternalApp(payload)
    }
  )

  ipcMain.handle(IPC_CHANNELS.MCP_LIST_STATUS, async () => {
    const config = getAppConfig()
    return mcpRegistry.getStatusFast(config.mcpServers)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_CONNECT, async (_event, serverId: string) => {
    const config = getAppConfig()
    const server = config.mcpServers.find((item) => item.id === serverId)
    if (!server) {
      throw new Error(`未找到 MCP Server: ${serverId}`)
    }

    // 鉴权只使用该 MCP 自身 env（在 Settings → MCP 中配置），不再注入全局凭证
    const status = await mcpRegistry.connect({
      ...server,
      env: { ...(server.env ?? {}) }
    })
    if (status.connected) {
      // 连接成功后后台预热仓库缓存，流水线打开时秒开
      void warmMcpRepoCache(serverId).catch(() => undefined)
    }
    return status
  })

  ipcMain.handle(IPC_CHANNELS.MCP_DISCONNECT, async (_event, serverId: string) => {
    await mcpRegistry.disconnect(serverId)
    clearMcpRepoCache(serverId)
  })

  ipcMain.handle(
    IPC_CHANNELS.MCP_LIST_REPOS,
    async (_event, payload?: string | { serverId?: string; forceRefresh?: boolean }) => {
      if (typeof payload === 'string' || payload == null) {
        return listReposFromMcp(payload || undefined, { forceRefresh: false })
      }
      return listReposFromMcp(payload.serverId, {
        forceRefresh: Boolean(payload.forceRefresh)
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MCP_LIST_BRANCHES,
    async (
      _event,
      payload: { serverId: string; repoUrl: string; forceRefresh?: boolean }
    ) => {
      return listBranchesFromMcp(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.REPO_LIST_FILES,
    async (
      _event,
      payload: {
        repoUrl: string
        branch?: string
        mcpServerId?: string
        forceRefresh?: boolean
      }
    ) => {
      return listRepoFiles(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.REPO_READ_FILE,
    async (
      _event,
      payload: {
        repoUrl: string
        branch?: string
        mcpServerId?: string
        filePath: string
      }
    ) => {
      return readRepoFile(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.REPO_WRITE_FILE,
    async (
      _event,
      payload: {
        repoUrl: string
        branch?: string
        mcpServerId?: string
        filePath: string
        content: string
      }
    ) => {
      return writeRepoFile(payload)
    }
  )

  ipcMain.handle(IPC_CHANNELS.LOCAL_OPEN_FOLDER, async () => {
    return openLocalFolderDialog()
  })

  ipcMain.handle(IPC_CHANNELS.LOCAL_PICK_DIRECTORY, async () => {
    return pickLocalDirectory('选择工作目录')
  })

  ipcMain.handle(IPC_CHANNELS.LOCAL_LIST_FOLDER, async (_event, rootPath: string) => {
    return listLocalFolder(rootPath)
  })

  ipcMain.handle(
    IPC_CHANNELS.LOCAL_READ_FILE,
    async (_event, payload: { rootPath: string; filePath: string }) => {
      return readLocalFile(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.LOCAL_WRITE_FILE,
    async (
      _event,
      payload: { rootPath?: string; filePath: string; content: string }
    ) => {
      return writeLocalFile(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.LOCAL_SAVE_DIALOG,
    async (
      _event,
      payload: { content: string; defaultPath?: string; rootPath?: string }
    ) => {
      return saveLocalFileDialog(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.LOCAL_CREATE_DIR,
    async (_event, payload: { rootPath: string; dirPath: string }) => {
      return createLocalDir(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.LOCAL_DELETE,
    async (_event, payload: { rootPath: string; filePath: string }) => {
      return deleteLocalEntry(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.LOCAL_RENAME,
    async (
      _event,
      payload: { rootPath: string; filePath: string; newName: string }
    ) => {
      return renameLocalEntry(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.REPO_CREATE_DIR,
    async (
      _event,
      payload: {
        repoUrl: string
        branch?: string
        mcpServerId?: string
        dirPath: string
      }
    ) => {
      return createRepoDir(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SHELL_REVEAL_IN_FOLDER,
    async (_event, targetPath: string) => {
      const p = String(targetPath || '').trim()
      if (!p || !existsSync(p)) throw new Error('路径不存在')
      shell.showItemInFolder(p)
      return { ok: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_IN_TERMINAL,
    async (_event, targetPath: string) => {
      const p = String(targetPath || '').trim()
      if (!p || !existsSync(p)) throw new Error('路径不存在')
      const dir = statSync(p).isDirectory() ? p : dirname(p)
      if (process.platform === 'darwin') {
        await new Promise<void>((resolve, reject) => {
          execFile('open', ['-a', 'Terminal', dir], (err) =>
            err ? reject(err) : resolve()
          )
        })
      } else if (process.platform === 'win32') {
        // 用 cwd 进入目录，避免把路径拼进 /k 命令导致注入
        await new Promise<void>((resolve, reject) => {
          execFile(
            process.env.ComSpec || 'cmd.exe',
            ['/c', 'start', '', 'cmd.exe', '/k'],
            { cwd: dir, windowsHide: false },
            (err) => (err ? reject(err) : resolve())
          )
        })
      } else {
        await shell.openPath(dir)
      }
      return { ok: true }
    }
  )

  /**
   * 启动审查：首帧进度一出来就返回报告（status=running），
   * 完整流程在后台继续，后续靠 REVIEW_PROGRESS 推送。
   */
  ipcMain.handle(IPC_CHANNELS.REVIEW_START, async (_event, payload: StartReviewPayload) => {
    return new Promise((resolve, reject) => {
      let settled = false
      void reviewOrchestrator
        .start(
          payload,
          (report) => {
            if (!settled) {
              settled = true
              resolve({ ...report })
            }
          },
          getWindow
        )
        .then((final) => {
          if (!settled) {
            settled = true
            resolve(final)
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true
            reject(err)
          }
        })
    })
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_BATCH, async (_event, payloads: StartReviewPayload[]) => {
    return reviewOrchestrator.startBatch(payloads, () => undefined, getWindow)
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_CANCEL, async (_event, reportId: string) => {
    if (!reportId) {
      reviewOrchestrator.cancelAll()
      return
    }
    reviewOrchestrator.cancel(reportId)
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_LATEST, () => {
    return reviewOrchestrator.getLatest() ?? getLatestReviewReport()
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_HISTORY, () => {
    return listReviewReports()
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_GET, (_event, reportId: string) => {
    return (
      reviewOrchestrator.getReportById(reportId) ||
      getReviewReportById(reportId) ||
      null
    )
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_DELETE, (_event, reportId: string) => {
    if (!reportId) {
      throw new Error('缺少报告 ID')
    }
    // 进行中的任务先取消，再删库
    reviewOrchestrator.cancel(reportId)
    const ok = deleteReviewReport(reportId)
    if (!ok) {
      throw new Error('报告不存在或已删除')
    }
    return { ok: true }
  })

  ipcMain.handle(
    IPC_CHANNELS.REVIEW_POST_COMMENTS,
    async (_event, payload: PostPrCommentsPayload) => {
      const latest = reviewOrchestrator.getLatest()
      const report =
        (latest?.id === payload.reportId ? latest : null) ||
        listReviewReports(100).find((item) => item.id === payload.reportId) ||
        null

      if (!report) {
        throw new Error('未找到对应审查报告')
      }

      return postSelectedIssuesAsPrComments(report, payload)
    }
  )

  ipcMain.handle(IPC_CHANNELS.RULES_IMPORT, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入自定义规则',
      filters: [
        { name: 'Rules', extensions: ['yaml', 'yml', 'json'] },
        { name: 'All', extensions: ['*'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || !result.filePaths[0]) {
      throw new Error('已取消导入')
    }

    const filePath = result.filePaths[0]
    const rules = parseCustomRulesFile(filePath)
    const config = getAppConfig()
    const next = saveAppConfig({
      ...config,
      customRules: rules,
      customRulesPath: filePath,
      enabledRuleIds: Array.from(
        new Set([...config.enabledRuleIds, ...rules.map((rule) => rule.id)])
      )
    })

    return { count: rules.length, config: toRendererConfig(next) }
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    return checkAppUpdates(getAppConfig())
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_RUN_DOC_DEMO, async () => {
    if (app.isPackaged) {
      throw new Error('正式安装包已禁用「需求文档联调」入口')
    }
    const demo = loadDocDemoConfig()
    applyDocLlmConfig()
    const payloads = buildDocDemoPayloads()
    const reports = await reviewOrchestrator.startBatch(payloads, () => undefined, getWindow)
    return {
      repos: demo.repos,
      model: demo.model,
      reports
    }
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_LIST, () => chatService.listSessions())

  ipcMain.handle(IPC_CHANNELS.CHAT_GET, (_event, sessionId: string) => {
    return chatService.getSession(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_CREATE, (_event, reportId?: string) => {
    return chatService.createSession(reportId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_DELETE, (_event, sessionId: string) => {
    chatService.deleteSession(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, payload: SendChatPayload) => {
    return chatService.sendMessage(payload)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, () => {
    chatService.cancelGeneration()
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, (_event, query?: MemoryListQuery) => {
    return listLlmMemories(query || {})
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET, (_event, id: string) => {
    return getLlmMemoryById(id)
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_UPSERT, (_event, input: UpsertMemoryInput) => {
    // 新建走去重；带 id 的编辑保持精确更新，避免误合并到其它条目
    if (input.id?.trim()) return upsertLlmMemory(input)
    return upsertMemoryWithDedup(input).memory
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, (_event, id: string) => {
    deleteLlmMemory(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SET_ENABLED,
    (_event, id: string, enabled: boolean) => {
      return setLlmMemoryEnabled(id, enabled)
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_STATS, () => {
    return memoryStats()
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_DISTILL_CHAT,
    (_event, payload: { sessionId: string }) => {
      const session = chatService.getSession(payload.sessionId)
      if (!session) throw new Error('会话不存在')
      const report = session.reportId
        ? getReviewReportById(session.reportId)
        : null
      return distillMemoriesFromChat({
        messages: session.messages,
        repoUrl: report?.repoUrl,
        force: true
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_CLEAR_OLDEST, (_event, count?: number) => {
    const deleted = deleteOldestLlmMemories(
      typeof count === 'number' && count > 0 ? count : 20
    )
    return { deleted, stats: memoryStats() }
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_EXPORT, async () => {
    const payload = exportMemoriesPayload()
    const result = await dialog.showSaveDialog({
      title: '导出记忆备份',
      defaultPath: `code-reviewer-memories-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) {
      return { ok: false as const, canceled: true as const }
    }
    writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf-8')
    return {
      ok: true as const,
      path: result.filePath,
      count: payload.items.length
    }
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_IMPORT, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入记忆备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths?.[0]) {
      return { ok: false as const, canceled: true as const }
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(result.filePaths[0], 'utf-8')) as unknown
    } catch {
      throw new Error('无法解析备份文件，请选择有效的 JSON')
    }
    const stats = importMemoriesPayload(raw)
    return {
      ok: true as const,
      ...stats,
      memoryStats: memoryStats()
    }
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_IMPORT_MCP, async () => {
    const stats = await importFromMemoryMcp()
    return { ...stats, memoryStats: memoryStats() }
  })

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_LOGIN,
    async (_event, payload: { email: string; password: string; apiBase?: string }) => {
      return toRendererConfig(await cloudLogin(payload))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_LOGIN_PHONE,
    async (_event, payload: { phone: string; password: string; apiBase?: string }) => {
      return toRendererConfig(await cloudLoginPhone(payload))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_LOGIN_SMS,
    async (_event, payload: { phone: string; code: string; apiBase?: string }) => {
      return toRendererConfig(await cloudLoginSms(payload))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_SEND_SMS,
    async (_event, payload: { phone: string; apiBase?: string }) => {
      return cloudSendSms(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_REGISTER,
    async (
      _event,
      payload: {
        email: string
        password: string
        displayName: string
        orgName?: string
        apiBase?: string
      }
    ) => {
      return toRendererConfig(await cloudRegister(payload))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_REGISTER_PHONE,
    async (
      _event,
      payload: {
        phone: string
        code: string
        password: string
        displayName: string
        orgName?: string
        apiBase?: string
      }
    ) => {
      return toRendererConfig(await cloudRegisterPhone(payload))
    }
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_START_BROWSER_LOGIN, async () => {
    return cloudStartBrowserLogin()
  })

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_OPEN_ACCOUNT_MANAGE,
    async (_event, nextPath?: string) => {
      if (typeof nextPath === 'string' && nextPath.trim()) {
        return cloudOpenConsolePath(nextPath.trim())
      }
      return cloudOpenAccountManage()
    }
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_REFRESH_PROFILE, async () =>
    toRendererConfig(await cloudRefreshProfile())
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_SYNC_ENDPOINTS, async () =>
    toRendererConfig(await cloudSyncEndpoints())
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_LOGOUT, async () =>
    toRendererConfig(await cloudLogout())
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_LIST_ORGS, async () => cloudListOrgs())

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_SET_ORG,
    async (_event, payload: { orgId: string; orgName: string }) => {
      return toRendererConfig(await cloudSetOrg(payload.orgId, payload.orgName))
    }
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_PULL_CONFIG, async () => {
    const result = await cloudPullConfig()
    return { ...result, config: toRendererConfig(result.config) }
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_UPLOAD_REPORT, async () => cloudUploadLatestReport())

  ipcMain.handle(IPC_CHANNELS.CLOUD_MCP_CATALOG, async (_event, q?: string) => {
    return cloudFetchMcpCatalog(q)
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_ADD_MCP, async (_event, itemKey: string) => {
    return toRendererConfig(await cloudAddMcpFromCatalog(itemKey))
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_REVIEW_METHODS, async (_event, q?: string) => {
    const { setReviewMethodCatalog, getReviewMethodCatalog } = await import(
      '../../shared/review-methods'
    )
    try {
      const list = await cloudFetchReviewMethods(q)
      setReviewMethodCatalog(
        list.map((m) => ({
          id: m.id,
          name: m.name,
          group: m.group,
          description: m.description || '',
          staticRuleIds: m.staticRuleIds ?? []
        }))
      )
      return getReviewMethodCatalog()
    } catch {
      return getReviewMethodCatalog()
    }
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_CODE_REPO_CATALOG, async (_event, q?: string) => {
    try {
      return await cloudFetchCodeRepoCatalog(q)
    } catch (err) {
      console.warn('[cloud:code-repo-catalog] fetch failed', err)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_LLM_CATALOG, async (_event, q?: string) => {
    try {
      const list = await cloudFetchLlmCatalog(q)
      const presets = list.map((m) => ({
        key: m.key,
        name: m.name,
        protocol: (m.protocol || 'openai-compatible') as
          | 'openai-compatible'
          | 'anthropic'
          | 'ollama',
        baseUrl: m.baseUrl,
        model: m.model,
        models: m.models?.length ? m.models : [m.model].filter(Boolean),
        fallbackModels: m.fallbackModels ?? [],
        apiKeyUrl: m.apiKeyUrl
      }))
      // 以服务端为准整表覆盖本地缓存（允许空数组）
      const config = getAppConfig()
      const saved = saveAppConfig({ ...config, llmProviderPresets: presets })
      return saved.llmProviderPresets ?? presets
    } catch (err) {
      console.warn('[cloud:llm-catalog] fetch failed, fallback to local cache', err)
      return getAppConfig().llmProviderPresets ?? []
    }
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_CHAT_COMMANDS, async (_event, q?: string) => {
    try {
      return await cloudFetchChatCommands(q)
    } catch (err) {
      console.warn('[cloud:chat-commands] fetch failed', err)
      return []
    }
  })
}
