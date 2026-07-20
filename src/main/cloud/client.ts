import { shell } from 'electron'
import { randomUUID } from 'crypto'
import type { AppConfig, CloudAccountConfig, ReviewReport } from '../../shared/types'
import { getAppConfig, saveAppConfig } from '../config/store'
import { configureAutoUpdater } from '../updater'
import { getLatestReviewReport } from '../database/db'
import { startLoopbackAuthServer } from './loopback-auth'

type ApiEnvelope<T> = {
  code: number
  message: string
  data: T
}

const DEFAULT_API_BASE = 'http://localhost:3100'
const DEFAULT_AUTH_WEB_BASE = 'http://localhost:3000'

/** 当前等待网页回调的 state */
let pendingBrowserAuthState: string | null = null

const cloudOf = (config?: AppConfig): CloudAccountConfig =>
  config?.cloud ?? {
    apiBase: DEFAULT_API_BASE,
    authWebBase: DEFAULT_AUTH_WEB_BASE,
    autoUploadReports: false
  }

async function apiRequest<T>(
  path: string,
  options: {
    method?: string
    body?: unknown
    token?: string
    apiBase?: string
  } = {}
): Promise<T> {
  const base = (options.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`

  const res = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const json = (await res.json()) as ApiEnvelope<T>
  if (!res.ok || json.code !== 0) {
    throw new Error(json.message || `请求失败 ${res.status}`)
  }
  return json.data
}

const persistCloud = async (patch: Partial<CloudAccountConfig>): Promise<AppConfig> => {
  const config = getAppConfig()
  const cloud = { ...cloudOf(config), ...patch }
  return saveAppConfig({ ...config, cloud })
}

export const cloudLogin = async (input: {
  email: string
  password: string
  apiBase?: string
}): Promise<AppConfig> => {
  const apiBase = (input.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const data = await apiRequest<{
    accessToken: string
    refreshToken: string
    user: CloudUser
  }>('/api/v1/auth/login', {
    method: 'POST',
    apiBase,
    body: { email: input.email, password: input.password }
  })
  return persistAfterAuth(apiBase, data)
}

type CloudUser = {
  id: string
  email?: string | null
  phone?: string | null
  displayName: string
  avatarUrl?: string | null
  isPlatformAdmin?: boolean
}

const fetchCloudProfile = async (
  apiBase: string,
  accessToken: string
): Promise<CloudUser | null> => {
  try {
    const me = await apiRequest<{
      id: string
      email?: string | null
      phone?: string | null
      displayName: string
      avatarUrl?: string | null
      isPlatformAdmin?: boolean
    }>('/api/v1/me', { apiBase, token: accessToken })
    return {
      id: me.id,
      email: me.email,
      phone: me.phone,
      displayName: me.displayName,
      avatarUrl: me.avatarUrl ?? null,
      isPlatformAdmin: me.isPlatformAdmin
    }
  } catch {
    return null
  }
}

const persistAfterAuth = async (
  apiBase: string,
  data: {
    accessToken: string
    refreshToken: string
    user: CloudUser
    org?: { id: string; name: string }
  }
): Promise<AppConfig> => {
  let orgId = data.org?.id
  let orgName = data.org?.name
  if (!orgId) {
    const orgs = await apiRequest<
      Array<{ role: string; org: { id: string; name: string } }>
    >('/api/v1/orgs', {
      apiBase,
      token: data.accessToken
    })
    orgId = orgs[0]?.org?.id
    orgName = orgs[0]?.org?.name
  }

  const profile =
    (await fetchCloudProfile(apiBase, data.accessToken)) || data.user

  return persistCloud({
    apiBase,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: profile,
    orgId,
    orgName,
    lastSyncAt: new Date().toISOString()
  })
}

/** 从服务端刷新当前登录用户资料（头像、昵称等） */
export const cloudRefreshProfile = async (): Promise<AppConfig> => {
  const config = getAppConfig()
  const cloud = cloudOf(config)
  if (!cloud.accessToken) {
    throw new Error('未登录云端账号')
  }
  const apiBase = (cloud.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const profile = await fetchCloudProfile(apiBase, cloud.accessToken)
  if (!profile) {
    throw new Error('获取用户资料失败')
  }
  return persistCloud({
    user: profile,
    lastSyncAt: new Date().toISOString()
  })
}

/** 从服务端拉取桌面端入口地址（公开接口） */
export const cloudSyncEndpoints = async (): Promise<AppConfig> => {
  const config = getAppConfig()
  const bootstrapBase = (cloudOf(config).apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  try {
    const data = await apiRequest<{
      apiBase?: string
      authWebBase?: string
      updateFeedUrl?: string
    }>('/api/v1/public/client-config', { apiBase: bootstrapBase })
    const nextCloud = await persistCloud({
      apiBase: (data.apiBase || bootstrapBase).replace(/\/$/, ''),
      authWebBase: (data.authWebBase || DEFAULT_AUTH_WEB_BASE).replace(/\/$/, '')
    })
    // 更新源写入应用配置（配置中心权威）
    if (typeof data.updateFeedUrl === 'string') {
      const feed = data.updateFeedUrl.trim()
      if (feed) configureAutoUpdater(feed)
      return saveAppConfig({
        ...nextCloud,
        updateFeedUrl: feed
      })
    }
    return nextCloud
  } catch {
    // 离线时沿用本地/默认地址
    return persistCloud({
      apiBase: bootstrapBase,
      authWebBase: (cloudOf(config).authWebBase || DEFAULT_AUTH_WEB_BASE).replace(
        /\/$/,
        ''
      )
    })
  }
}

type BrowserLoginResult = {
  opened: boolean
  authorizeUrl: string
  state: string
  loopbackPort?: number
}

let browserAuthCompleteHandler:
  | ((payload: { ok: boolean; config?: AppConfig; error?: string }) => void)
  | null = null

/** 由主进程注册：loopback / deep link 完成后通知渲染进程 */
export const setBrowserAuthCompleteHandler = (
  handler: (payload: { ok: boolean; config?: AppConfig; error?: string }) => void
): void => {
  browserAuthCompleteHandler = handler
}

const notifyBrowserAuthComplete = (payload: {
  ok: boolean
  config?: AppConfig
  error?: string
}): void => {
  browserAuthCompleteHandler?.(payload)
}

/** 用一次性授权码换取会话并落盘 */
export const cloudExchangeDesktopCode = async (
  code: string,
  state: string
): Promise<AppConfig> => {
  if (!code || !state) throw new Error('授权回调缺少 code 或 state')
  if (!pendingBrowserAuthState || state !== pendingBrowserAuthState) {
    throw new Error('授权状态不匹配，请从桌面端重新点击登录')
  }

  const config = getAppConfig()
  const apiBase = (cloudOf(config).apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const data = await apiRequest<{
    accessToken: string
    refreshToken: string
    user: CloudUser
  }>('/api/v1/auth/desktop/exchange', {
    method: 'POST',
    apiBase,
    body: { code, state }
  })

  pendingBrowserAuthState = null
  return persistAfterAuth(apiBase, data)
}

/** Trae 式：打开浏览器登录页；优先本机 loopback 回调，辅以自定义协议 */
export const cloudStartBrowserLogin = async (): Promise<BrowserLoginResult> => {
  await cloudSyncEndpoints()
  const config = getAppConfig()
  const apiBase = (cloudOf(config).apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const authWebBase = (
    cloudOf(config).authWebBase || DEFAULT_AUTH_WEB_BASE
  ).replace(/\/$/, '')

  const state = randomUUID()
  pendingBrowserAuthState = state

  await persistCloud({
    apiBase,
    authWebBase
  })

  let loopbackPort: number | undefined
  try {
    const loop = await startLoopbackAuthServer({
      expectedState: state,
      onCode: async (code, cbState) => {
        const next = await cloudExchangeDesktopCode(code, cbState)
        notifyBrowserAuthComplete({ ok: true, config: next })
      },
      onError: (error) => {
        notifyBrowserAuthComplete({ ok: false, error })
      }
    })
    loopbackPort = loop.port
  } catch (e) {
    console.warn('[auth] loopback server failed, fallback to protocol only', e)
  }

  const qs = new URLSearchParams({ state })
  if (loopbackPort) qs.set('desktop_port', String(loopbackPort))
  const authorizeUrl = `${authWebBase}/login?${qs.toString()}`
  await shell.openExternal(authorizeUrl)
  return { opened: true, authorizeUrl, state, loopbackPort }
}

const ACCOUNT_CONSOLE_PATH = '/account'

/**
 * 打开服务后台控制台路径（handoff 免登）：
 * - 桌面已登录：签发网页交接码，浏览器免登进入
 * - 否则：打开登录页，登录后跳转目标页
 */
export const cloudOpenConsolePath = async (
  nextPath = ACCOUNT_CONSOLE_PATH
): Promise<{
  opened: boolean
  url: string
}> => {
  await cloudSyncEndpoints()
  const config = getAppConfig()
  const cloud = cloudOf(config)
  const apiBase = (cloud.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const authWebBase = (cloud.authWebBase || DEFAULT_AUTH_WEB_BASE).replace(
    /\/$/,
    ''
  )
  const next = nextPath.startsWith('/') ? nextPath : `/${nextPath}`

  if (cloud.accessToken) {
    try {
      const { code } = await apiRequest<{ code: string; expiresIn: number }>(
        '/api/v1/auth/web/handoff',
        {
          method: 'POST',
          apiBase,
          token: cloud.accessToken,
          body: {}
        }
      )
      const url = `${authWebBase}/auth/handoff?code=${encodeURIComponent(
        code
      )}&next=${encodeURIComponent(next)}`
      await shell.openExternal(url)
      return { opened: true, url }
    } catch (e) {
      console.warn('[auth] web handoff failed, fallback to login', e)
    }
  }

  const url = `${authWebBase}/login?next=${encodeURIComponent(next)}`
  await shell.openExternal(url)
  return { opened: true, url }
}

/** 打开服务后台「个人账号设置」 */
export const cloudOpenAccountManage = async (): Promise<{
  opened: boolean
  url: string
}> => cloudOpenConsolePath(ACCOUNT_CONSOLE_PATH)

/** 处理 codereviewer://auth/callback?code=&state= */
export const cloudHandleAuthCallback = async (rawUrl: string): Promise<AppConfig> => {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('无效的授权回调地址')
  }

  const code = parsed.searchParams.get('code')
  const state = parsed.searchParams.get('state')
  if (!code || !state) throw new Error('授权回调缺少 code 或 state')
  return cloudExchangeDesktopCode(code, state)
}

export const cloudSendSms = async (input: {
  phone: string
  apiBase?: string
}): Promise<{
  ok: boolean
  message: string
  phone: string
  code: string
  expiresIn: number
}> => {
  const apiBase = (input.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  return apiRequest('/api/v1/auth/sms/send', {
    method: 'POST',
    apiBase,
    body: { phone: input.phone }
  })
}

export const cloudLoginPhone = async (input: {
  phone: string
  password: string
  apiBase?: string
}): Promise<AppConfig> => {
  const apiBase = (input.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const data = await apiRequest<{
    accessToken: string
    refreshToken: string
    user: CloudUser
  }>('/api/v1/auth/login/phone', {
    method: 'POST',
    apiBase,
    body: { phone: input.phone, password: input.password }
  })
  return persistAfterAuth(apiBase, data)
}

export const cloudLoginSms = async (input: {
  phone: string
  code: string
  apiBase?: string
}): Promise<AppConfig> => {
  const apiBase = (input.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const data = await apiRequest<{
    accessToken: string
    refreshToken: string
    user: CloudUser
  }>('/api/v1/auth/login/sms', {
    method: 'POST',
    apiBase,
    body: { phone: input.phone, code: input.code }
  })
  return persistAfterAuth(apiBase, data)
}

export const cloudRegister = async (input: {
  email: string
  password: string
  displayName: string
  orgName?: string
  apiBase?: string
}): Promise<AppConfig> => {
  const apiBase = (input.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const data = await apiRequest<{
    accessToken: string
    refreshToken: string
    user: CloudUser
    org: { id: string; name: string }
  }>('/api/v1/auth/register', {
    method: 'POST',
    apiBase,
    body: {
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      orgName: input.orgName
    }
  })

  return persistAfterAuth(apiBase, data)
}

export const cloudRegisterPhone = async (input: {
  phone: string
  code: string
  password: string
  displayName: string
  orgName?: string
  apiBase?: string
}): Promise<AppConfig> => {
  const apiBase = (input.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const data = await apiRequest<{
    accessToken: string
    refreshToken: string
    user: CloudUser
    org: { id: string; name: string }
  }>('/api/v1/auth/register/phone', {
    method: 'POST',
    apiBase,
    body: {
      phone: input.phone,
      code: input.code,
      password: input.password,
      displayName: input.displayName,
      orgName: input.orgName
    }
  })

  return persistAfterAuth(apiBase, data)
}

export const cloudLogout = async (): Promise<AppConfig> => {
  const config = getAppConfig()
  const cloud = cloudOf(config)
  if (cloud.refreshToken) {
    try {
      await apiRequest('/api/v1/auth/logout', {
        method: 'POST',
        apiBase: cloud.apiBase,
        body: { refreshToken: cloud.refreshToken }
      })
    } catch {
      // ignore
    }
  }
  return persistCloud({
    apiBase: cloud.apiBase || DEFAULT_API_BASE,
    accessToken: '',
    refreshToken: '',
    user: undefined,
    orgId: '',
    orgName: '',
    lastConfigVersion: 0,
    lastSyncAt: undefined
  })
}

export const cloudListOrgs = async (): Promise<
  Array<{ role: string; org: { id: string; name: string; slug: string } }>
> => {
  const cloud = cloudOf(getAppConfig())
  if (!cloud.accessToken) throw new Error('未登录云端账号')
  return apiRequest('/api/v1/orgs', {
    apiBase: cloud.apiBase,
    token: cloud.accessToken
  })
}

export const cloudSetOrg = async (orgId: string, orgName: string): Promise<AppConfig> => {
  return persistCloud({ orgId, orgName })
}

/** 拉取组织配置（不含密钥），合并规则/流水线模板等到本地 */
export const cloudPullConfig = async (): Promise<{
  config: AppConfig
  changed: boolean
  version?: number
}> => {
  const config = getAppConfig()
  const cloud = cloudOf(config)
  if (!cloud.accessToken || !cloud.orgId) throw new Error('请先登录并选择组织')

  const remote = await apiRequest<{
    changed: boolean
    version: number
    payload?: {
      rulePack?: { enabledRuleIds?: string[]; customRules?: unknown[] }
      pipelineTemplates?: unknown[]
      reportFormats?: string[]
      notifyOnComplete?: boolean
      methodIds?: string[]
      mcpTemplates?: Array<{
        name?: string
        transport?: 'stdio' | 'sse'
        command?: string
        args?: string[]
        url?: string
        env?: Record<string, string>
      }>
    }
  }>(
    `/api/v1/sync/config?orgId=${encodeURIComponent(cloud.orgId)}&since=${cloud.lastConfigVersion ?? 0}`,
    { apiBase: cloud.apiBase, token: cloud.accessToken }
  )

  if (!remote.changed || !remote.payload) {
    const saved = await persistCloud({ lastSyncAt: new Date().toISOString() })
    return { config: saved, changed: false, version: remote.version }
  }

  const payload = remote.payload
  const next: AppConfig = { ...config }
  if (payload.rulePack?.enabledRuleIds?.length) {
    next.enabledRuleIds = payload.rulePack.enabledRuleIds
  }
  if (Array.isArray(payload.rulePack?.customRules)) {
    next.customRules = payload.rulePack.customRules as AppConfig['customRules']
  }
  if (typeof payload.notifyOnComplete === 'boolean') {
    next.notifyOnComplete = payload.notifyOnComplete
  }

  next.cloud = {
    ...cloud,
    lastConfigVersion: remote.version,
    lastSyncAt: new Date().toISOString()
  }
  const saved = await saveAppConfig(next)
  return { config: saved, changed: true, version: remote.version }
}

export const cloudUploadLatestReport = async (): Promise<{ id: string }> => {
  const config = getAppConfig()
  const cloud = cloudOf(config)
  if (!cloud.accessToken || !cloud.orgId) throw new Error('请先登录并选择组织')

  const report = getLatestReviewReport()
  if (!report) throw new Error('本地暂无审查报告可上传')

  return apiRequest('/api/v1/sync/reports', {
    method: 'POST',
    apiBase: cloud.apiBase,
    token: cloud.accessToken,
    body: {
      orgId: cloud.orgId,
      clientReportId: report.id,
      repoUrl: report.repoUrl,
      branch: undefined,
      prNumber: report.prNumber,
      commitSha: report.commitSha,
      status: report.status,
      visibility: 'private',
      issueCount: report.issues?.length ?? 0,
      totalDurationMs: report.totalDurationMs,
      summary: report.summaryMarkdown?.slice(0, 500),
      payload: report as unknown as Record<string, unknown>
    }
  })
}

export const cloudFetchMcpCatalog = async (q?: string): Promise<
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
> => {
  const cloud = cloudOf(getAppConfig())
  const qs = q ? `?q=${encodeURIComponent(q)}` : ''
  return apiRequest(`/api/v1/mcp-catalog${qs}`, {
    apiBase: cloud.apiBase || DEFAULT_API_BASE,
    token: cloud.accessToken
  })
}

/** 从服务端拉取审查规则目录（公开接口，失败由调用方回退本地） */
export const cloudFetchReviewMethods = async (
  q?: string
): Promise<
  Array<{
    id: string
    key?: string
    name: string
    group: string
    description: string
    staticRuleIds?: string[]
  }>
> => {
  const cloud = cloudOf(getAppConfig())
  const qs = q ? `?q=${encodeURIComponent(q)}` : ''
  return apiRequest(`/api/v1/review-methods${qs}`, {
    apiBase: cloud.apiBase || DEFAULT_API_BASE
  })
}

/** 从服务端拉取代码仓库平台目录（公开接口，仅 published） */
export const cloudFetchCodeRepoCatalog = async (
  q?: string
): Promise<
  Array<{
    key: string
    name: string
    description?: string
    tokenUrl?: string
    logoUrl?: string
    needsBaseUrl?: boolean
    baseUrlPlaceholder?: string
    sortOrder?: number
  }>
> => {
  const cloud = cloudOf(getAppConfig())
  const qs = q ? `?q=${encodeURIComponent(q)}` : ''
  return apiRequest(`/api/v1/code-repo-catalog${qs}`, {
    apiBase: cloud.apiBase || DEFAULT_API_BASE
  })
}

/** 从服务端拉取内置 LLM 服务商/模型目录（公开接口） */
export const cloudFetchLlmCatalog = async (
  q?: string
): Promise<
  Array<{
    key: string
    name: string
    protocol: string
    baseUrl: string
    model: string
    models?: string[]
    fallbackModels?: string[]
    apiKeyUrl?: string
    description?: string
    sortOrder?: number
  }>
> => {
  const cloud = cloudOf(getAppConfig())
  const qs = q ? `?q=${encodeURIComponent(q)}` : ''
  return apiRequest(`/api/v1/llm-catalog${qs}`, {
    apiBase: cloud.apiBase || DEFAULT_API_BASE
  })
}

/** 从服务端拉取对话 Slash 命令目录（公开接口） */
export const cloudFetchChatCommands = async (
  q?: string
): Promise<
  Array<{
    id: string
    key: string
    slash: string
    name: string
    description: string
    promptTemplate: string
    sortOrder?: number
  }>
> => {
  const cloud = cloudOf(getAppConfig())
  const qs = q ? `?q=${encodeURIComponent(q)}` : ''
  return apiRequest(`/api/v1/chat-commands${qs}`, {
    apiBase: cloud.apiBase || DEFAULT_API_BASE
  })
}

/** 将云端目录项添加到本地 mcpServers（密钥需用户本地填写） */
export const cloudAddMcpFromCatalog = async (itemKey: string): Promise<AppConfig> => {
  const list = await cloudFetchMcpCatalog()
  const hit = list.find((i) => i.key === itemKey)
  if (!hit) throw new Error('目录中未找到该 MCP')

  const config = getAppConfig()
  const env: Record<string, string> = {}
  for (const k of hit.envKeys || []) env[k] = ''

  const id = randomUUID()
  const nextServer = {
    id,
    name: hit.name,
    transport: (hit.transport as 'stdio' | 'sse') || 'stdio',
    command: hit.command,
    args: hit.args || [],
    url: hit.url,
    env,
    enabled: false
  }
  return saveAppConfig({
    ...config,
    mcpServers: [...(config.mcpServers || []), nextServer]
  })
}

export const maybeAutoUploadReport = async (report: ReviewReport): Promise<void> => {
  const cloud = cloudOf(getAppConfig())
  if (!cloud.autoUploadReports || !cloud.accessToken || !cloud.orgId) return
  if (report.status !== 'completed' && report.status !== 'failed') return
  try {
    await apiRequest('/api/v1/sync/reports', {
      method: 'POST',
      apiBase: cloud.apiBase,
      token: cloud.accessToken,
      body: {
        orgId: cloud.orgId,
        clientReportId: report.id,
        repoUrl: report.repoUrl,
        prNumber: report.prNumber,
        commitSha: report.commitSha,
        status: report.status,
        visibility: 'private',
        issueCount: report.issues?.length ?? 0,
        totalDurationMs: report.totalDurationMs,
        summary: report.summaryMarkdown?.slice(0, 500),
        payload: report as unknown as Record<string, unknown>
      }
    })
  } catch (error) {
    console.warn('[cloud] auto upload failed', error)
  }
}
