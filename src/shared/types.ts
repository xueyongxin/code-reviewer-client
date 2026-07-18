export type LlmProtocol = 'openai-compatible' | 'anthropic' | 'ollama'

export interface LlmProviderConfig {
  id: string
  /** 服务商显示名，如「硅基流动」 */
  name: string
  /** 协议：OpenAI 兼容 / Anthropic Messages / Ollama */
  protocol: LlmProtocol
  baseUrl: string
  apiKey: string
  /** 当前选用的具体模型 id */
  model: string
  enabled: boolean
  /** 该提供商主模型失败时的备用模型（动态配置，非源码写死） */
  fallbackModels?: string[]
  /** 列表展示用模型名，默认等于 model */
  displayName?: string
}

/** 服务商预设（存库；「添加模型」弹窗从此读取） */
export interface LlmProviderPreset {
  /** 唯一键 */
  key: string
  /** 服务商名 */
  name: string
  protocol: LlmProtocol
  baseUrl: string
  /** 默认模型 */
  model: string
  /** 可选模型列表（编辑弹窗下拉） */
  models?: string[]
  fallbackModels?: string[]
  /** 「获取 API 密钥」外链 */
  apiKeyUrl?: string
}

export interface McpServerConfig {
  id: string
  name: string
  /** stdio: 启动命令；sse: 服务 URL */
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
}

export interface McpPreset {
  key: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

/** MCP 市场条目（存库，支持搜索添加） */
export interface McpMarketplaceItem extends McpPreset {
  description?: string
  tags?: string[]
  /** 官方/认证标记 */
  verified?: boolean
  /** 展示用首字母或短标 */
  badge?: string
}

export interface CustomRuleDefinition {
  id: string
  name: string
  description?: string
  severity: IssueSeverity
  pattern: string
  flags?: string
  message: string
  extensions?: string[]
}

export interface AppConfig {
  mcpServers: McpServerConfig[]
  githubToken?: string
  /** @deprecated 兼容旧字段，优先用 llmProviders */
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  /** 多模型提供商列表 */
  llmProviders: LlmProviderConfig[]
  /** 当前选用的 provider id */
  activeLlmProviderId?: string
  reportOutputDir?: string
  enabledRuleIds: string[]
  customRules: CustomRuleDefinition[]
  customRulesPath?: string
  notifyOnComplete: boolean
  enableLlm: boolean
  updateFeedUrl?: string
  /** 优先使用的 PR 评论 MCP 工具名 */
  prCommentToolName?: string
  /** 允许 Git 直连克隆拉取（不依赖 MCP） */
  enableGitClone: boolean
  /** Review 页快捷仓库列表（每行一个 URL） */
  quickRepoUrls: string[]
  /** 全局备用模型列表（主模型失败时尝试） */
  llmFallbackModels: string[]
  /** Settings「从预设添加」的模板，存库可改 */
  llmProviderPresets: LlmProviderPreset[]
  /** MCP「手动/快捷」模板，存库可改 */
  mcpPresets: McpPreset[]
  /** MCP 市场目录（搜索添加），存库可改 */
  mcpMarketplace: McpMarketplaceItem[]
  /** 多项目审查流水线（配置好后再点启动） */
  reviewPipelines: ReviewPipeline[]
  /** 当前编辑/选中的流水线 id */
  activePipelineId?: string
  /** 云端 SaaS 账号与同步（Token 本地加密） */
  cloud?: CloudAccountConfig
}

/** 桌面端连接 code-reviewer-server */
export interface CloudAccountConfig {
  apiBase: string
  /** 网页授权登录地址（如 admin http://localhost:3000） */
  authWebBase?: string
  accessToken?: string
  refreshToken?: string
  user?: {
    id: string
    email?: string | null
    phone?: string | null
    displayName: string
    avatarUrl?: string | null
    isPlatformAdmin?: boolean
  }
  orgId?: string
  orgName?: string
  lastConfigVersion?: number
  lastSyncAt?: string
  /** 审查结束后是否自动上传（默认 false，手动） */
  autoUploadReports?: boolean
}
/** 报告输出格式 */
export type ReportOutputFormat = 'md' | 'html' | 'json'

/** 单个项目的审查流水线配置 */
export interface ReviewPipeline {
  id: string
  name: string
  /** 代码源仓库 URL（可来自 MCP / 快捷仓库） */
  repoUrl: string
  branch?: string
  prNumber?: string
  commitSha?: string
  /** 关联的 MCP Server id（可选，用于拉码） */
  mcpServerId?: string
  /** 勾选的审查方式 id（见 review-methods 目录） */
  methodIds: string[]
  /** 本流水线选用的 LLM provider id */
  llmProviderId?: string
  /** 报告输出格式 */
  reportFormats: ReportOutputFormat[]
  updatedAt: string
}

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface ReviewIssue {
  id: string
  filePath: string
  line: number
  severity: IssueSeverity
  ruleId: string
  message: string
  source: 'static' | 'llm' | 'custom'
}

export interface ReviewFileResult {
  filePath: string
  content: string
  originalContent?: string
  language?: string
  issues: ReviewIssue[]
}

export type FlowNodeStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed'

/** 审查流程单个节点（扭转状态 + 耗时） */
export interface ReviewFlowNode {
  id: string
  name: string
  status: FlowNodeStatus
  startedAt?: string
  endedAt?: string
  /** 节点耗时（毫秒） */
  durationMs?: number
  detail?: string
}

export interface ReviewReport {
  id: string
  repoUrl: string
  prNumber?: string
  commitSha?: string
  fromCache?: boolean
  createdAt: string
  /** 审查结束时间 */
  finishedAt?: string
  /** 全流程总耗时（毫秒） */
  totalDurationMs?: number
  /** 代码拉取来源 */
  pullSource?: 'mcp' | 'git' | 'demo' | 'cache'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  progressLabel: string
  /** 完整流程节点时间线 */
  flowTimeline?: ReviewFlowNode[]
  files: ReviewFileResult[]
  issues: ReviewIssue[]
  summaryMarkdown: string
  error?: string
}

export interface StartReviewPayload {
  repoUrl: string
  prNumber?: string
  commitSha?: string
  forceRefresh?: boolean
  /** 使用已配置的流水线启动 */
  pipelineId?: string
  /** 覆盖：审查方式 */
  methodIds?: string[]
  /** 覆盖：模型 provider */
  llmProviderId?: string
  /** 覆盖：报告格式 */
  reportFormats?: ReportOutputFormat[]
}

export interface PostPrCommentsPayload {
  reportId: string
  issueIds: string[]
  owner?: string
  repo?: string
}

export interface PostPrCommentsResult {
  posted: number
  failed: number
  details: string[]
}

export interface UpdateCheckResult {
  updateAvailable: boolean
  currentVersion: string
  latestVersion?: string
  message: string
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  sessionId: string
  role: ChatRole
  content: string
  createdAt: string
}

export interface ChatSession {
  id: string
  title: string
  reportId?: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

export interface SendChatPayload {
  sessionId?: string
  content: string
  /** 关联审查报告，便于带上下文对话 */
  reportId?: string
}

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpConnectionStatus {
  serverId: string
  name: string
  connected: boolean
  tools: McpToolInfo[]
  error?: string
}

export interface ImportRulesResult {
  count: number
  config: AppConfig
}

export interface McpRepoOption {
  url: string
  name: string
  fullName?: string
  provider: string
  serverId: string
  serverName: string
  defaultBranch?: string
}

export interface McpRepoSourceOption {
  serverId: string
  serverName: string
  provider: string
  connected: boolean
}

export interface ElectronAPI {
  getConfig: () => Promise<AppConfig>
  saveConfig: (config: AppConfig) => Promise<AppConfig>
  listMcpStatus: () => Promise<McpConnectionStatus[]>
  connectMcp: (serverId: string) => Promise<McpConnectionStatus>
  disconnectMcp: (serverId: string) => Promise<void>
  listMcpRepos: (payload?:
    | string
    | { serverId?: string; forceRefresh?: boolean }) => Promise<{
    repos: McpRepoOption[]
    errors: string[]
    sources: McpRepoSourceOption[]
    fromCache?: boolean
  }>
  listMcpBranches: (payload: {
    serverId: string
    repoUrl: string
    forceRefresh?: boolean
  }) => Promise<{ branches: string[]; error?: string; fromCache?: boolean }>
  startReview: (payload: StartReviewPayload) => Promise<ReviewReport>
  startBatchReview: (payloads: StartReviewPayload[]) => Promise<ReviewReport[]>
  cancelReview: (reportId: string) => Promise<void>
  getLatestReport: () => Promise<ReviewReport | null>
  getReportHistory: () => Promise<ReviewReport[]>
  getReportById: (reportId: string) => Promise<ReviewReport | null>
  postPrComments: (payload: PostPrCommentsPayload) => Promise<PostPrCommentsResult>
  importCustomRules: () => Promise<ImportRulesResult>
  checkForUpdates: () => Promise<UpdateCheckResult>
  runDocDemoReviews: () => Promise<{
    repos: Array<{ name: string; url: string }>
    model: string
    reports: ReviewReport[]
  }>
  listChatSessions: () => Promise<ChatSession[]>
  getChatSession: (sessionId: string) => Promise<ChatSession | null>
  createChatSession: (reportId?: string) => Promise<ChatSession>
  deleteChatSession: (sessionId: string) => Promise<void>
  sendChatMessage: (payload: SendChatPayload) => Promise<ChatSession>
  cloudLogin: (payload: {
    email: string
    password: string
    apiBase?: string
  }) => Promise<AppConfig>
  cloudLoginPhone: (payload: {
    phone: string
    password: string
    apiBase?: string
  }) => Promise<AppConfig>
  cloudLoginSms: (payload: {
    phone: string
    code: string
    apiBase?: string
  }) => Promise<AppConfig>
  cloudSendSms: (payload: {
    phone: string
    apiBase?: string
  }) => Promise<{
    ok: boolean
    message: string
    phone: string
    code: string
    expiresIn: number
  }>
  cloudRegister: (payload: {
    email: string
    password: string
    displayName: string
    orgName?: string
    apiBase?: string
  }) => Promise<AppConfig>
  cloudRegisterPhone: (payload: {
    phone: string
    code: string
    password: string
    displayName: string
    orgName?: string
    apiBase?: string
  }) => Promise<AppConfig>
  cloudStartBrowserLogin: () => Promise<{
    opened: boolean
    authorizeUrl: string
    state: string
  }>
  cloudOpenAccountManage: () => Promise<{
    opened: boolean
    url: string
  }>
  onCloudAuthComplete: (
    callback: (payload: { ok: boolean; config?: AppConfig; error?: string }) => void
  ) => () => void
  cloudRefreshProfile: () => Promise<AppConfig>
  cloudSyncEndpoints: () => Promise<AppConfig>
  cloudLogout: () => Promise<AppConfig>
  cloudListOrgs: () => Promise<
    Array<{ role: string; org: { id: string; name: string; slug: string } }>
  >
  cloudSetOrg: (payload: { orgId: string; orgName: string }) => Promise<AppConfig>
  cloudPullConfig: () => Promise<{
    config: AppConfig
    changed: boolean
    version?: number
  }>
  cloudUploadReport: () => Promise<{ id: string }>
  cloudMcpCatalog: (q?: string) => Promise<
    Array<{
      id: string
      key: string
      name: string
      description?: string
      transport: string
      command?: string
      args?: string[]
      url?: string
      envKeys?: string[]
      tags?: string[]
      verified?: boolean
      badge?: string
    }>
  >
  cloudAddMcp: (itemKey: string) => Promise<AppConfig>
  cloudReviewMethods: (q?: string) => Promise<
    Array<{
      id: string
      name: string
      group: string
      description: string
      staticRuleIds?: string[]
    }>
  >
  cloudLlmCatalog: (q?: string) => Promise<LlmProviderPreset[]>
  cloudChatCommands: (q?: string) => Promise<
    Array<{
      id: string
      key: string
      slash: string
      name: string
      description: string
      promptTemplate: string
      sortOrder?: number
    }>
  >
  onReviewProgress: (callback: (report: ReviewReport) => void) => () => void
}
