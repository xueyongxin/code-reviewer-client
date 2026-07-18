import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type {
  AppConfig,
  PostPrCommentsPayload,
  SendChatPayload,
  StartReviewPayload
} from '../../shared/types'
import { getAppConfig, saveAppConfig } from '../config/store'
import { getLatestReviewReport, listReviewReports, getReviewReportById } from '../database/db'
import { mcpRegistry } from '../mcp-manager/registry'
import { reviewOrchestrator } from '../review-engine/orchestrator'
import { parseCustomRulesFile } from '../review-engine/custom-rules'
import { postSelectedIssuesAsPrComments } from '../review-engine/pr-comments'
import { checkAppUpdates } from '../updater'
import { applyDocLlmConfig, buildDocDemoPayloads, loadDocDemoConfig } from '../review-engine/doc-demo'
import { chatService } from '../review-engine/chat-service'
import { listBranchesFromMcp, listReposFromMcp, warmMcpRepoCache } from '../review-engine/mcp-repos'
import { clearMcpRepoCache } from '../review-engine/mcp-cache'
import {
  cloudAddMcpFromCatalog,
  cloudFetchMcpCatalog,
  cloudFetchChatCommands,
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
  cloudRefreshProfile,
  cloudSyncEndpoints,
  cloudUploadLatestReport
} from '../cloud/client'

export const registerIpcHandlers = (getWindow: () => BrowserWindow | null): void => {
  ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => getAppConfig())

  ipcMain.handle(IPC_CHANNELS.SAVE_CONFIG, (_event, config: AppConfig) => {
    return saveAppConfig(config)
  })

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

  ipcMain.handle(IPC_CHANNELS.REVIEW_START, async (_event, payload: StartReviewPayload) => {
    return reviewOrchestrator.start(payload, () => undefined, getWindow)
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

    return { count: rules.length, config: next }
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    return checkAppUpdates(getAppConfig())
  })

  ipcMain.handle(IPC_CHANNELS.REVIEW_RUN_DOC_DEMO, async () => {
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

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_LOGIN,
    async (_event, payload: { email: string; password: string; apiBase?: string }) => {
      return cloudLogin(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_LOGIN_PHONE,
    async (_event, payload: { phone: string; password: string; apiBase?: string }) => {
      return cloudLoginPhone(payload)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_LOGIN_SMS,
    async (_event, payload: { phone: string; code: string; apiBase?: string }) => {
      return cloudLoginSms(payload)
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
      return cloudRegister(payload)
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
      return cloudRegisterPhone(payload)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_START_BROWSER_LOGIN, async () => {
    return cloudStartBrowserLogin()
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_OPEN_ACCOUNT_MANAGE, async () => {
    return cloudOpenAccountManage()
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_REFRESH_PROFILE, async () => cloudRefreshProfile())

  ipcMain.handle(IPC_CHANNELS.CLOUD_SYNC_ENDPOINTS, async () => cloudSyncEndpoints())

  ipcMain.handle(IPC_CHANNELS.CLOUD_LOGOUT, async () => cloudLogout())

  ipcMain.handle(IPC_CHANNELS.CLOUD_LIST_ORGS, async () => cloudListOrgs())

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_SET_ORG,
    async (_event, payload: { orgId: string; orgName: string }) => {
      return cloudSetOrg(payload.orgId, payload.orgName)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CLOUD_PULL_CONFIG, async () => cloudPullConfig())

  ipcMain.handle(IPC_CHANNELS.CLOUD_UPLOAD_REPORT, async () => cloudUploadLatestReport())

  ipcMain.handle(IPC_CHANNELS.CLOUD_MCP_CATALOG, async (_event, q?: string) => {
    return cloudFetchMcpCatalog(q)
  })

  ipcMain.handle(IPC_CHANNELS.CLOUD_ADD_MCP, async (_event, itemKey: string) => {
    return cloudAddMcpFromCatalog(itemKey)
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
