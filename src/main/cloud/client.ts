import { app, shell } from 'electron'
import { randomUUID } from 'crypto'
import type { AppConfig, CloudAccountConfig, ReviewReport } from '../../shared/types'
import { getAppConfig, saveAppConfig } from '../config/store'
import { configureAutoUpdater } from '../updater'
import { getLatestReviewReport } from '../database/db'
import { startLoopbackAuthServer, getActiveLoopbackPort } from './loopback-auth'

type ApiEnvelope<T> = {
  code: number
  message: string
  data: T
}

/** 打包版首次联系云端的启动地址；权威来源为配置中心 client-config */
const PROD_API_BASE = 'https://codereviewer.cn'
const PROD_AUTH_WEB_BASE = 'https://codereviewer.cn'
const DEV_API_BASE = 'http://localhost:3100'
const DEV_AUTH_WEB_BASE = 'http://localhost:3000'

const isLocalHostUrl = (url: string): boolean =>
  /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url.trim())

const defaultApiBase = (): string => {
  const fromEnv = process.env.CR_API_BASE?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return (app.isPackaged ? PROD_API_BASE : DEV_API_BASE).replace(/\/$/, '')
}

const defaultAuthWebBase = (): string => {
  const fromEnv = process.env.CR_AUTH_WEB_BASE?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return (app.isPackaged ? PROD_AUTH_WEB_BASE : DEV_AUTH_WEB_BASE).replace(/\/$/, '')
}

/** 打包版若配置仍是 localhost，强制改用正式环境，避免授权跳本机 */
const resolveApiBase = (stored?: string): string => {
  const base = (stored || defaultApiBase()).replace(/\/$/, '')
  if (app.isPackaged && isLocalHostUrl(base)) return defaultApiBase()
  return base
}

const resolveAuthWebBase = (stored?: string): string => {
  const base = (stored || defaultAuthWebBase()).replace(/\/$/, '')
  if (app.isPackaged && isLocalHostUrl(base)) return defaultAuthWebBase()
  return base
}

/** 当前等待网页回调的 state */
let pendingBrowserAuthState: string | null = null
let pendingAuthorizeUrl: string | null = null
let pendingLoopbackPort: number | undefined

const cloudOf = (config?: AppConfig): CloudAccountConfig =>
  config?.cloud ?? {
    apiBase: defaultApiBase(),
    authWebBase: defaultAuthWebBase(),
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
  const base = (options.apiBase || defaultApiBase()).replace(/\/$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`

  const res = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  let json: ApiEnvelope<T>
  try {
    json = (await res.json()) as ApiEnvelope<T>
  } catch {
    throw new Error(`请求失败 ${res.status}（响应非 JSON）`)
  }
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
  const apiBase = resolveApiBase(input.apiBase)
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

/** 从 /me 取当前工作区（含个人 free），/orgs 仅企业组织不可靠 */
const resolveOrgFromMe = async (
  apiBase: string,
  accessToken: string
): Promise<{ id: string; name: string } | null> => {
  try {
    const me = await apiRequest<{
      memberships?: Array<{ org?: { id: string; name: string } | null }>
    }>('/api/v1/me', { apiBase, token: accessToken })
    const org = me.memberships?.[0]?.org
    if (org?.id) return { id: org.id, name: org.name }
  } catch {
    // ignore
  }
  return null
}

const persistAfterAuth = async (
  apiBase: string,
  data: {
    accessToken: string
    refreshToken: string
    user: CloudUser
    org?: { id: string; name: string } | null
  }
): Promise<AppConfig> => {
  let orgId = data.org?.id
  let orgName = data.org?.name

  if (!orgId) {
    const fromMe = await resolveOrgFromMe(apiBase, data.accessToken)
    if (fromMe) {
      orgId = fromMe.id
      orgName = fromMe.name
    }
  }

  // /orgs 只返回企业组织；失败或空列表不阻断登录
  if (!orgId) {
    try {
      const orgs = await apiRequest<
        Array<{ role: string; org: { id: string; name: string } }>
      >('/api/v1/orgs', {
        apiBase,
        token: data.accessToken
      })
      orgId = orgs[0]?.org?.id
      orgName = orgs[0]?.org?.name
    } catch {
      // ignore
    }
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
  const apiBase = resolveApiBase(cloud.apiBase)
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
  const bootstrapBase = resolveApiBase(cloudOf(config).apiBase)
  try {
    const data = await apiRequest<{
      apiBase?: string
      authWebBase?: string
      updateFeedUrl?: string
    }>('/api/v1/public/client-config', { apiBase: bootstrapBase })
    const nextCloud = await persistCloud({
      apiBase: resolveApiBase(data.apiBase || bootstrapBase),
      authWebBase: resolveAuthWebBase(data.authWebBase || defaultAuthWebBase())
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
    // 离线时沿用地址；打包版不会回落到 localhost
    return persistCloud({
      apiBase: bootstrapBase,
      authWebBase: resolveAuthWebBase(cloudOf(config).authWebBase)
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

/** 防止 loopback / 协议双通道或浏览器重复请求导致二次 exchange 报错 */
let desktopExchangeInFlight: {
  state: string
  promise: Promise<AppConfig>
} | null = null
let lastDesktopExchangeOk: { state: string; config: AppConfig } | null = null

/** 防止快速连点登录：序列化 cloudStartBrowserLogin 的异步初始化 */
let browserLoginInFlight: Promise<BrowserLoginResult> | null = null

/** 用一次性授权码换取会话并落盘 */
export const cloudExchangeDesktopCode = async (
  code: string,
  state: string
): Promise<AppConfig> => {
  if (!code || !state) throw new Error('授权回调缺少 code 或 state')

  // 同一 state 已成功：重复回调直接返回（浏览器常会打两次 /callback）
  if (lastDesktopExchangeOk?.state === state) {
    return lastDesktopExchangeOk.config
  }
  if (desktopExchangeInFlight?.state === state) {
    return desktopExchangeInFlight.promise
  }

  if (!pendingBrowserAuthState || state !== pendingBrowserAuthState) {
    throw new Error('授权状态不匹配，请从桌面端重新点击登录')
  }

  const promise = (async () => {
    const config = getAppConfig()
    const apiBase = resolveApiBase(cloudOf(config).apiBase)
    const data = await apiRequest<{
      accessToken: string
      refreshToken: string
      user: CloudUser
      org?: { id: string; name: string } | null
    }>('/api/v1/auth/desktop/exchange', {
      method: 'POST',
      apiBase,
      body: { code, state }
    })

    pendingBrowserAuthState = null
    const next = await persistAfterAuth(apiBase, data)
    lastDesktopExchangeOk = { state, config: next }
    return next
  })()

  desktopExchangeInFlight = { state, promise }

  try {
    return await promise
  } finally {
    if (desktopExchangeInFlight?.promise === promise) {
      desktopExchangeInFlight = null
    }
  }
}

/** Trae 式：打开浏览器登录页；优先本机 loopback 回调，辅以自定义协议 */
export const cloudStartBrowserLogin = async (): Promise<BrowserLoginResult> => {
  // 已有进行中的初始化（快速连点）：直接复用，避免第二次 stopLoopback 掐断第一次的端口
  if (browserLoginInFlight) return browserLoginInFlight

  // 已有进行中的授权：勿重启 loopback（会掐断旧 port），只重新打开同一登录页
  if (
    pendingBrowserAuthState &&
    pendingAuthorizeUrl &&
    (!pendingLoopbackPort || getActiveLoopbackPort() === pendingLoopbackPort)
  ) {
    await shell.openExternal(pendingAuthorizeUrl)
    return {
      opened: true,
      authorizeUrl: pendingAuthorizeUrl,
      state: pendingBrowserAuthState,
      loopbackPort: pendingLoopbackPort
    }
  }

  const run = (async (): Promise<BrowserLoginResult> => {
    await cloudSyncEndpoints()
    const config = getAppConfig()
    const apiBase = resolveApiBase(cloudOf(config).apiBase)
    const authWebBase = resolveAuthWebBase(cloudOf(config).authWebBase)

    const state = randomUUID()
    pendingBrowserAuthState = state
    lastDesktopExchangeOk = null

    await persistCloud({
      apiBase,
      authWebBase
    })

    let loopbackPort: number | undefined
    let authNotified = false
    const notifyOnce = (payload: {
      ok: boolean
      config?: AppConfig
      error?: string
    }): void => {
      if (authNotified) return
      // 已成功后再来的失败（重复回调）直接忽略
      if (!payload.ok && lastDesktopExchangeOk?.state === state) return
      authNotified = true
      if (payload.ok) {
        pendingAuthorizeUrl = null
        pendingLoopbackPort = undefined
      }
      notifyBrowserAuthComplete(payload)
    }

    try {
      const loop = await startLoopbackAuthServer({
        expectedState: state,
        onCode: async (code, cbState) => {
          const next = await cloudExchangeDesktopCode(code, cbState)
          notifyOnce({ ok: true, config: next })
        },
        onError: (error) => {
          notifyOnce({ ok: false, error })
        }
      })
      loopbackPort = loop.port
    } catch (e) {
      console.warn('[auth] loopback server failed, fallback to protocol only', e)
    }

    const qs = new URLSearchParams({ state })
    if (loopbackPort) qs.set('desktop_port', String(loopbackPort))
    const authorizeUrl = `${authWebBase}/login?${qs.toString()}`
    pendingAuthorizeUrl = authorizeUrl
    pendingLoopbackPort = loopbackPort
    await shell.openExternal(authorizeUrl)
    return { opened: true, authorizeUrl, state, loopbackPort }
  })()

  browserLoginInFlight = run
  try {
    return await run
  } finally {
    if (browserLoginInFlight === run) browserLoginInFlight = null
  }
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
  const apiBase = resolveApiBase(cloud.apiBase)
  const authWebBase = resolveAuthWebBase(cloud.authWebBase)
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
  const apiBase = resolveApiBase(input.apiBase)
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
  const apiBase = resolveApiBase(input.apiBase)
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
  const apiBase = resolveApiBase(input.apiBase)
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
  const apiBase = resolveApiBase(input.apiBase)
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
  const apiBase = resolveApiBase(input.apiBase)
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
    apiBase: resolveApiBase(cloud.apiBase),
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

/** 刷新当前工作区：企业组织优先，否则个人工作区（/me） */
export const cloudRefreshWorkspace = async (): Promise<AppConfig> => {
  const cloud = cloudOf(getAppConfig())
  if (!cloud.accessToken) throw new Error('未登录云端账号')
  const apiBase = resolveApiBase(cloud.apiBase)

  let networkFailed = false

  try {
    const orgs = await apiRequest<
      Array<{ role: string; org: { id: string; name: string } }>
    >('/api/v1/orgs', {
      apiBase,
      token: cloud.accessToken
    })
    if (orgs[0]?.org?.id) {
      return persistCloud({
        orgId: orgs[0].org.id,
        orgName: orgs[0].org.name,
        lastSyncAt: new Date().toISOString()
      })
    }
  } catch {
    networkFailed = true
  }

  try {
    const fromMe = await resolveOrgFromMe(apiBase, cloud.accessToken)
    if (fromMe) {
      return persistCloud({
        orgId: fromMe.id,
        orgName: fromMe.name,
        lastSyncAt: new Date().toISOString()
      })
    }
  } catch {
    networkFailed = true
  }

  if (networkFailed) {
    throw new Error('网络异常，无法获取工作区信息，请稍后重试')
  }
  throw new Error('未找到工作区，请重新登录')
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
  let config = getAppConfig()
  let cloud = cloudOf(config)
  if (!cloud.accessToken) throw new Error('请先登录云端账号')
  if (!cloud.orgId) {
    try {
      config = await cloudRefreshWorkspace()
      cloud = cloudOf(config)
    } catch {
      // 工作区暂时不可达（网络抖动等），不阻断配置拉取
      return { config, changed: false }
    }
  }
  if (!cloud.orgId) return { config, changed: false }

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

/** 客户端 'completed' → 服务端枚举 'success' */
const toServerReportStatus = (
  s: string
): 'pending' | 'running' | 'success' | 'failed' | 'cancelled' =>
  s === 'completed' ? 'success' : (s as 'pending' | 'running' | 'success' | 'failed' | 'cancelled')

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
      status: toServerReportStatus(report.status),
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
    apiBase: resolveApiBase(cloud.apiBase),
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
    apiBase: resolveApiBase(cloud.apiBase)
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
    apiBase: resolveApiBase(cloud.apiBase)
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
    apiBase: resolveApiBase(cloud.apiBase)
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
    apiBase: resolveApiBase(cloud.apiBase)
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
        status: toServerReportStatus(report.status),
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
