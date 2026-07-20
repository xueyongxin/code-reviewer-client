import { create } from 'zustand'
import { message } from 'antd'
import type {
  AppConfig,
  ChatSession,
  McpConnectionStatus,
  PostPrCommentsPayload,
  ReviewReport,
  StartReviewPayload,
  UpdateCheckResult
} from '../../../shared/types'

export type ChatSessionSummary = Pick<
  ChatSession,
  'id' | 'title' | 'reportId' | 'createdAt' | 'updatedAt'
>

interface AppState {
  config: AppConfig | null
  mcpStatus: McpConnectionStatus[]
  currentReport: ReviewReport | null
  history: ReviewReport[]
  loading: boolean
  batchRunning: boolean
  chatSessions: ChatSessionSummary[]
  activeChatId: string | null
  /** 每次主动选择/新建会话时递增，强制对话页重新加载（含重复点击同一项） */
  chatSelectSeq: number
  bootstrap: () => Promise<void>
  saveConfig: (config: AppConfig) => Promise<void>
  refreshMcpStatus: () => Promise<void>
  connectMcp: (serverId: string) => Promise<void>
  disconnectMcp: (serverId: string) => Promise<void>
  startReview: (payload: StartReviewPayload) => Promise<void>
  startBatchReview: (payloads: StartReviewPayload[]) => Promise<ReviewReport[]>
  cancelReview: (reportId?: string) => Promise<void>
  postPrComments: (payload: PostPrCommentsPayload) => Promise<{
    posted: number
    failed: number
    details: string[]
  }>
  importCustomRules: () => Promise<number>
  checkForUpdates: () => Promise<UpdateCheckResult>
  runDocDemoReviews: () => Promise<{
    repos: Array<{ name: string; url: string }>
    model: string
    reports: ReviewReport[]
  }>
  loadReport: (reportId: string) => Promise<void>
  deleteReport: (reportId: string) => Promise<void>
  subscribeProgress: () => () => void
  refreshChatSessions: (preferId?: string | null) => Promise<void>
  setActiveChatId: (id: string | null) => void
  selectChatSession: (id: string | null) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  mcpStatus: [],
  currentReport: null,
  history: [],
  loading: false,
  batchRunning: false,
  chatSessions: [],
  activeChatId: null,
  chatSelectSeq: 0,

  bootstrap: async () => {
    const api = window.electronAPI
    if (!api) return

    let config = await api.getConfig()
    try {
      config = await api.cloudSyncEndpoints()
    } catch {
      // ignore
    }

    const [currentReport, history, mcpStatus] = await Promise.all([
      api.getLatestReport(),
      api.getReportHistory(),
      api.listMcpStatus()
    ])

    if (config.cloud?.accessToken) {
      try {
        config = await api.cloudRefreshProfile()
      } catch {
        // 离线或 token 失效时沿用本地缓存资料
      }
    }

    set({
      config,
      currentReport,
      history,
      mcpStatus,
      // 避免上次异常退出后 loading 一直为 true，导致列表运行按钮点不了
      loading: currentReport?.status === 'running',
      batchRunning: false
    })

    // 启动时主进程会后台自动重连 enabled MCP，短暂轮询以刷新 UI
    const enabledCount = (config.mcpServers || []).filter((s) => s.enabled).length
    if (enabledCount > 0) {
      void (async () => {
        for (const delay of [1200, 3000, 6000]) {
          await new Promise((r) => setTimeout(r, delay))
          const next = await api.listMcpStatus()
          set({ mcpStatus: next })
          if (next.filter((s) => s.connected).length >= enabledCount) break
        }
      })()
    }
  },

  saveConfig: async (config) => {
    const saved = await window.electronAPI.saveConfig(config)
    set({ config: saved })
  },

  refreshMcpStatus: async () => {
    const mcpStatus = await window.electronAPI.listMcpStatus()
    set({ mcpStatus })
  },

  connectMcp: async (serverId) => {
    await window.electronAPI.connectMcp(serverId)
    await get().refreshMcpStatus()
  },

  disconnectMcp: async (serverId) => {
    await window.electronAPI.disconnectMcp(serverId)
    await get().refreshMcpStatus()
  },

  startReview: async (payload) => {
    set({ loading: true })
    try {
      // 主进程在首帧进度时即返回（审查仍在后台继续）
      const report = await window.electronAPI.startReview(payload)
      const history = await window.electronAPI.getReportHistory()
      set({
        currentReport: report,
        history,
        loading: report.status === 'running'
      })
    } catch (error) {
      set({ loading: false })
      throw error
    }
  },

  startBatchReview: async (payloads) => {
    set({ batchRunning: true, loading: true })
    try {
      const reports = await window.electronAPI.startBatchReview(payloads)
      const history = await window.electronAPI.getReportHistory()
      set({
        currentReport: reports[reports.length - 1] ?? null,
        history,
        batchRunning: false,
        loading: false
      })
      return reports
    } catch (error) {
      set({ batchRunning: false, loading: false })
      throw error
    }
  },

  cancelReview: async (reportId) => {
    if (get().batchRunning) {
      await window.electronAPI.cancelReview('')
      return
    }
    const id = reportId || get().currentReport?.id
    if (!id) return
    await window.electronAPI.cancelReview(id)
  },

  postPrComments: async (payload) => {
    return window.electronAPI.postPrComments(payload)
  },

  importCustomRules: async () => {
    const result = await window.electronAPI.importCustomRules()
    set({ config: result.config })
    return result.count
  },

  checkForUpdates: async () => window.electronAPI.checkForUpdates(),

  runDocDemoReviews: async () => {
    set({ batchRunning: true, loading: true })
    try {
      const result = await window.electronAPI.runDocDemoReviews()
      const history = await window.electronAPI.getReportHistory()
      const config = await window.electronAPI.getConfig()
      set({
        config,
        currentReport: result.reports[result.reports.length - 1] ?? null,
        history,
        batchRunning: false,
        loading: false
      })
      return result
    } catch (error) {
      set({ batchRunning: false, loading: false })
      throw error
    }
  },

  loadReport: async (reportId) => {
    const report = await window.electronAPI.getReportById(reportId)
    if (!report) {
      throw new Error('报告不存在或已删除')
    }
    set({ currentReport: report })
  },

  deleteReport: async (reportId) => {
    await window.electronAPI.deleteReport(reportId)
    const history = await window.electronAPI.getReportHistory()
    const latest = await window.electronAPI.getLatestReport()
    const { currentReport } = get()
    set({
      history,
      currentReport:
        currentReport?.id === reportId ? latest : currentReport ?? latest
    })
  },

  subscribeProgress: () => {
    const api = window.electronAPI
    if (!api?.onReviewProgress) return () => undefined
    let lastStatus: ReviewReport['status'] | null = null
    return api.onReviewProgress((report) => {
      const prev = lastStatus
      lastStatus = report.status
      set((state) => {
        const next: Partial<AppState> = {
          currentReport: report,
          loading: report.status === 'running' || state.batchRunning
        }
        if (report.status !== 'running') {
          const others = state.history.filter((h) => h.id !== report.id)
          next.history = [report, ...others].slice(0, 50)
        }
        return next
      })
      if (prev === 'running' && report.status === 'completed') {
        message.success('审查已完成')
      } else if (prev === 'running' && report.status === 'failed') {
        message.error(report.error || '审查失败')
      }
    })
  },

  refreshChatSessions: async (preferId) => {
    const api = window.electronAPI
    if (!api?.listChatSessions) return
    const list = await api.listChatSessions()
    const summaries = list.map((s) => ({
      id: s.id,
      title: s.title,
      reportId: s.reportId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }))
    const current = get().activeChatId
    // 当前选中仍有效时绝不强切，避免发送完成把用户从其他会话拽回
    let nextId: string | null
    let bump = false
    if (current && summaries.some((s) => s.id === current)) {
      nextId = current
    } else if (
      preferId != null &&
      summaries.some((s) => s.id === preferId)
    ) {
      nextId = preferId
      bump = preferId !== current
    } else {
      nextId = summaries[0]?.id ?? null
      bump = nextId !== current
    }
    set((state) => ({
      chatSessions: summaries,
      activeChatId: nextId,
      chatSelectSeq: bump ? state.chatSelectSeq + 1 : state.chatSelectSeq
    }))
  },

  setActiveChatId: (id) => set({ activeChatId: id }),

  selectChatSession: (id) =>
    set((state) => ({
      activeChatId: id,
      chatSelectSeq: state.chatSelectSeq + 1
    }))
}))
