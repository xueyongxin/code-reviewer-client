import Store from 'electron-store'
import { app } from 'electron'
import type {
  AppConfig,
  ExternalAppConnection,
  ExternalAppsConfig,
  LlmProviderConfig,
  McpMarketplaceItem,
  McpPreset
} from '../../shared/types'
import {
  DEFAULT_BATCH_REVIEW_CONCURRENCY,
  clampBatchReviewConcurrency
} from '../../shared/batch-concurrency'
import { normalizeReviewPipelines } from '../../shared/review-pipelines'
import { DEFAULT_RULE_IDS } from '../review-engine/static-rules'
import { getAppConfigPayload, saveAppConfigPayload } from '../database/db'
import marketplaceSeed from './mcp-marketplace-seed.json'
import {
  ENC_AES_PREFIX,
  ENC_SS_PREFIX,
  decryptEnvMap,
  decryptSecret,
  encryptEnvMap,
  encryptSecret,
  looksLikeSecretEnvKey,
  maskEnvMap,
  maskSecret,
  mergeEnvMaps,
  mergeSecretField
} from './secrets'

/** 打包版首次启动回退值；运行时以配置中心 client-config 为准 */
const PROD_API_BASE = 'https://codereviewer.cn'
const PROD_AUTH_WEB_BASE = 'https://codereviewer.cn'
const DEV_API_BASE = 'http://localhost:3100'
const DEV_AUTH_WEB_BASE = 'http://localhost:3000'

const defaultCloudApiBase = (): string =>
  app.isPackaged ? PROD_API_BASE : DEV_API_BASE
const defaultCloudAuthWebBase = (): string =>
  app.isPackaged ? PROD_AUTH_WEB_BASE : DEV_AUTH_WEB_BASE

const isLocalHostUrl = (url: string): boolean =>
  /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url.trim())

const normalizeCloudBase = (
  stored: string | undefined,
  fallback: string
): string => {
  const base = (stored || fallback).replace(/\/$/, '')
  if (app.isPackaged && isLocalHostUrl(base)) return fallback
  return base
}

const isDiskEncrypted = (value?: string): boolean =>
  !!value &&
  (value.startsWith(ENC_SS_PREFIX) || value.startsWith(ENC_AES_PREFIX))

/** 检测库内是否仍有明文密钥（升级后一次性加密写回） */
const hasPlaintextSecretsOnDisk = (raw: AppConfig): boolean => {
  const check = (v?: string) => Boolean(v && !isDiskEncrypted(v))
  if (check(raw.githubToken) || check(raw.llmApiKey)) return true
  if (check(raw.cloud?.accessToken) || check(raw.cloud?.refreshToken)) return true
  for (const conn of Object.values(raw.externalApps?.providers ?? {})) {
    if (check(conn?.accessToken)) return true
  }
  if (check(raw.externalApps?.github?.accessToken)) return true
  if (check(raw.externalApps?.feishu?.accessToken)) return true
  for (const p of raw.llmProviders ?? []) {
    if (check(p.apiKey)) return true
  }
  for (const s of raw.mcpServers ?? []) {
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (looksLikeSecretEnvKey(k) && check(v)) return true
    }
  }
  return false
}

const MARKETPLACE_SEED = marketplaceSeed as McpMarketplaceItem[]

const toPreset = (item: McpMarketplaceItem): McpPreset => ({
  key: item.key,
  name: item.name,
  transport: item.transport,
  command: item.command,
  args: item.args,
  url: item.url,
  env: item.env
})

/**
 * 源码仅保留空壳结构默认值。
 * 模型 / Key / BaseURL / 仓库 / 预设一律存 SQLite app_config。
 * MCP 市场目录：库空时用 seed 文件补全并落库（避免保存配置时被空数组冲掉）。
 */
const defaults: AppConfig = {
  mcpServers: [],
  mcpPresets: [],
  mcpMarketplace: [],
  reviewPipelines: [],
  activePipelineId: '',
  recentIdeProjects: [],
  githubToken: '',
  llmApiKey: '',
  llmBaseUrl: '',
  llmModel: '',
  llmProviders: [],
  llmProviderPresets: [],
  llmFallbackModels: [],
  quickRepoUrls: [],
  activeLlmProviderId: '',
  reportOutputDir: '',
  enabledRuleIds: [...DEFAULT_RULE_IDS],
  customRules: [],
  customRulesPath: '',
  notifyOnComplete: true,
  enableLlm: true,
  updateFeedUrl: '',
  prCommentToolName: '',
  enableGitClone: true,
  enableMemory: true,
  enableMemoryAutoExtract: false,
  memoryMaxCount: 200,
  memoryRetrievalMode: 'hybrid',
  enableMemoryCloudSync: false,
  batchReviewConcurrency: DEFAULT_BATCH_REVIEW_CONCURRENCY,
  cloud: {
    apiBase: DEV_API_BASE,
    authWebBase: DEV_AUTH_WEB_BASE,
    autoUploadReports: false
  },
  externalApps: {
    providers: {}
  }
}

const mapProviderSecrets = (
  providers: Record<string, ExternalAppConnection> | undefined,
  mapToken: (v?: string) => string | undefined
): Record<string, ExternalAppConnection> => {
  const out: Record<string, ExternalAppConnection> = {}
  for (const [id, conn] of Object.entries(providers ?? {})) {
    if (!conn) continue
    out[id] = {
      ...conn,
      accessToken: mapToken(conn.accessToken)
    }
  }
  return out
}

/** 归一化 externalApps：旧 github/feishu → providers，丢弃飞书 */
const normalizeExternalApps = (
  raw: ExternalAppsConfig | undefined,
  githubToken?: string
): ExternalAppsConfig => {
  const providers: Record<string, ExternalAppConnection> = {
    ...(raw?.providers ?? {})
  }
  if (raw?.github && !providers.github) {
    providers.github = { ...raw.github }
  }
  if (githubToken?.trim() && !providers.github?.connected) {
    providers.github = {
      connected: true,
      accountLabel: providers.github?.accountLabel || 'GitHub Token',
      connectedAt: providers.github?.connectedAt,
      accessToken: providers.github?.accessToken || githubToken
    }
  }
  // 飞书已下线，不迁入 providers
  return { providers }
}

/** 兼容旧版 electron-store，仅作一次性迁移来源 */
const legacyStore = new Store<{ config: AppConfig }>({
  name: 'app-config',
  defaults: { config: defaults }
})

const withDecryptedSecrets = (config: AppConfig): AppConfig => ({
  ...config,
  githubToken: decryptSecret(config.githubToken),
  llmApiKey: decryptSecret(config.llmApiKey),
  llmProviders: (config.llmProviders ?? []).map((p) => ({
    ...p,
    apiKey: decryptSecret(p.apiKey)
  })),
  mcpServers: (config.mcpServers ?? []).map((s) => ({
    ...s,
    env: decryptEnvMap(s.env)
  })),
  cloud: config.cloud
    ? {
        ...config.cloud,
        accessToken: decryptSecret(config.cloud.accessToken),
        refreshToken: decryptSecret(config.cloud.refreshToken)
      }
    : config.cloud,
  externalApps: config.externalApps
    ? {
        providers: mapProviderSecrets(config.externalApps.providers, (v) =>
          decryptSecret(v)
        )
      }
    : config.externalApps
})

const withEncryptedSecrets = (config: AppConfig): AppConfig => ({
  ...config,
  githubToken: encryptSecret(config.githubToken),
  llmApiKey: encryptSecret(config.llmApiKey),
  llmProviders: (config.llmProviders ?? []).map((p) => ({
    ...p,
    apiKey: encryptSecret(p.apiKey)
  })),
  mcpServers: (config.mcpServers ?? []).map((s) => ({
    ...s,
    env: encryptEnvMap(s.env)
  })),
  cloud: config.cloud
    ? {
        ...config.cloud,
        accessToken: encryptSecret(config.cloud.accessToken),
        refreshToken: encryptSecret(config.cloud.refreshToken)
      }
    : config.cloud,
  externalApps: config.externalApps
    ? {
        providers: mapProviderSecrets(config.externalApps.providers, (v) =>
          encryptSecret(v)
        )
      }
    : config.externalApps
})

const migrateProviders = (config: AppConfig): LlmProviderConfig[] => {
  if (config.llmProviders?.length) return config.llmProviders
  if (!config.llmApiKey?.trim()) return []
  if (!config.llmBaseUrl?.trim() || !config.llmModel?.trim()) return []
  return [
    {
      id: 'legacy',
      name: 'Legacy',
      protocol: 'openai-compatible',
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      enabled: true,
      fallbackModels: config.llmFallbackModels
    }
  ]
}

const normalizeConfig = (raw: AppConfig): AppConfig => {
  const llmProviders = migrateProviders({ ...defaults, ...raw })
  const pipelinesNorm = normalizeReviewPipelines(raw.reviewPipelines, {
    previous: raw.reviewPipelines,
    activePipelineId: raw.activePipelineId
  })
  const merged = withDecryptedSecrets({
    ...defaults,
    ...raw,
    mcpServers: raw.mcpServers ?? [],
    mcpPresets: raw.mcpPresets ?? [],
    mcpMarketplace: raw.mcpMarketplace ?? [],
    reviewPipelines: pipelinesNorm.pipelines,
    activePipelineId: pipelinesNorm.activePipelineId,
    recentIdeProjects: Array.isArray(raw.recentIdeProjects)
      ? raw.recentIdeProjects
      : [],
    llmProviderPresets: raw.llmProviderPresets ?? [],
    llmFallbackModels: raw.llmFallbackModels ?? [],
    quickRepoUrls: raw.quickRepoUrls ?? [],
    enabledRuleIds: raw.enabledRuleIds?.length
      ? raw.enabledRuleIds
      : defaults.enabledRuleIds,
    customRules: raw.customRules ?? [],
    notifyOnComplete: raw.notifyOnComplete ?? true,
    enableLlm: raw.enableLlm ?? true,
    prCommentToolName: raw.prCommentToolName ?? '',
    enableGitClone: raw.enableGitClone ?? true,
    enableMemory: raw.enableMemory ?? true,
    enableMemoryAutoExtract: raw.enableMemoryAutoExtract ?? false,
    memoryMaxCount: Math.max(
      20,
      Math.min(1000, Number(raw.memoryMaxCount) || 200)
    ),
    memoryRetrievalMode:
      raw.memoryRetrievalMode === 'keyword' ? 'keyword' : 'hybrid',
    enableMemoryCloudSync: raw.enableMemoryCloudSync ?? false,
    batchReviewConcurrency: clampBatchReviewConcurrency(
      raw.batchReviewConcurrency ?? DEFAULT_BATCH_REVIEW_CONCURRENCY
    ),
    cloud: {
      apiBase: normalizeCloudBase(raw.cloud?.apiBase, defaultCloudApiBase()),
      authWebBase: normalizeCloudBase(
        raw.cloud?.authWebBase,
        defaultCloudAuthWebBase()
      ),
      accessToken: raw.cloud?.accessToken || '',
      refreshToken: raw.cloud?.refreshToken || '',
      user: raw.cloud?.user,
      orgId: raw.cloud?.orgId || '',
      orgName: raw.cloud?.orgName || '',
      lastConfigVersion: raw.cloud?.lastConfigVersion || 0,
      lastSyncAt: raw.cloud?.lastSyncAt,
      autoUploadReports: raw.cloud?.autoUploadReports ?? false
    },
    externalApps: normalizeExternalApps(raw.externalApps, raw.githubToken),
    llmProviders
  })

  if (!merged.activeLlmProviderId) {
    merged.activeLlmProviderId =
      merged.llmProviders.find((p) => p.enabled)?.id || merged.llmProviders[0]?.id || ''
  }

  const active =
    merged.llmProviders.find((p) => p.id === merged.activeLlmProviderId) ||
    merged.llmProviders[0]
  if (active) {
    merged.llmApiKey = active.apiKey
    merged.llmBaseUrl = active.baseUrl
    merged.llmModel = active.model
  }

  return merged
}

const loadRawConfig = (): AppConfig => {
  const fromDb = getAppConfigPayload()
  if (fromDb) return fromDb

  const fromLegacy = legacyStore.get('config')
  if (fromLegacy && Object.keys(fromLegacy).length > 0) {
    const encrypted = withEncryptedSecrets(normalizeConfig(fromLegacy))
    saveAppConfigPayload(encrypted)
    return encrypted
  }

  return defaults
}

/** 库内市场为空或缺 Gitee 时，用 seed 补全并写回 */
const ensureMarketplaceCatalog = (config: AppConfig): AppConfig => {
  const current = config.mcpMarketplace ?? []
  const hasGitee = current.some(
    (item) => item.key === 'gitee' || /gitee/i.test(item.name)
  )

  if (current.length > 0 && hasGitee) return config
  if (!MARKETPLACE_SEED.length) return config

  const byKey = new Map(current.map((item) => [item.key, item]))
  for (const item of MARKETPLACE_SEED) {
    if (!byKey.has(item.key)) byKey.set(item.key, item)
  }

  const nextMarket = Array.from(byKey.values())
  const next: AppConfig = {
    ...config,
    mcpMarketplace: nextMarket,
    mcpPresets: config.mcpPresets?.length
      ? config.mcpPresets
      : nextMarket.map(toPreset)
  }
  const encrypted = withEncryptedSecrets(next)
  saveAppConfigPayload(encrypted)
  try {
    legacyStore.set('config', encrypted)
  } catch {
    // ignore
  }
  return next
}

/** 主进程内部：解密后的完整配置（含密钥明文） */
export const getAppConfig = (): AppConfig => {
  const raw = loadRawConfig()
  const config = ensureMarketplaceCatalog(normalizeConfig(raw))
  const rawPipeSig = JSON.stringify(
    (raw.reviewPipelines ?? []).map((p) => p.id || '')
  )
  const nextPipeSig = JSON.stringify(config.reviewPipelines.map((p) => p.id))
  const pipelinesRepaired =
    rawPipeSig !== nextPipeSig ||
    (raw.activePipelineId || '') !== (config.activePipelineId || '')
  // 升级迁移：明文密钥加密落盘；流水线 ID 补齐/去重后立即写回，保证幂等
  if (hasPlaintextSecretsOnDisk(raw) || pipelinesRepaired) {
    const encrypted = withEncryptedSecrets(config)
    saveAppConfigPayload(encrypted)
    try {
      legacyStore.set('config', encrypted)
    } catch {
      // ignore
    }
  }
  return config
}

/**
 * 渲染进程可见配置：密钥类字段脱敏，避免 XSS / DevTools 直接读到明文
 */
export const redactConfigForRenderer = (config: AppConfig): AppConfig => ({
  ...config,
  githubToken: maskSecret(config.githubToken),
  llmApiKey: maskSecret(config.llmApiKey),
  llmProviders: (config.llmProviders ?? []).map((p) => ({
    ...p,
    apiKey: maskSecret(p.apiKey)
  })),
  mcpServers: (config.mcpServers ?? []).map((s) => ({
    ...s,
    env: maskEnvMap(s.env)
  })),
  cloud: config.cloud
    ? {
        ...config.cloud,
        accessToken: maskSecret(config.cloud.accessToken),
        refreshToken: maskSecret(config.cloud.refreshToken)
      }
    : config.cloud,
  externalApps: config.externalApps
    ? {
        providers: mapProviderSecrets(config.externalApps.providers, (v) =>
          maskSecret(v)
        )
      }
    : config.externalApps
})

/**
 * 渲染进程回写时合并密钥：掩码 / 未改字段保留原值
 */
export const mergeSecretsFromExisting = (
  incoming: AppConfig,
  existing: AppConfig
): AppConfig => {
  const existingById = new Map((existing.mcpServers || []).map((s) => [s.id, s]))
  const providerById = new Map((existing.llmProviders || []).map((p) => [p.id, p]))

  return {
    ...incoming,
    githubToken: mergeSecretField(incoming.githubToken, existing.githubToken),
    llmApiKey: mergeSecretField(incoming.llmApiKey, existing.llmApiKey),
    llmProviders: (incoming.llmProviders ?? []).map((p) => ({
      ...p,
      apiKey: mergeSecretField(p.apiKey, providerById.get(p.id)?.apiKey)
    })),
    mcpServers: (incoming.mcpServers ?? []).map((s) => ({
      ...s,
      env: mergeEnvMaps(s.env, existingById.get(s.id)?.env)
    })),
    cloud: incoming.cloud
      ? {
          ...incoming.cloud,
          accessToken: mergeSecretField(
            incoming.cloud.accessToken,
            existing.cloud?.accessToken
          ),
          refreshToken: mergeSecretField(
            incoming.cloud.refreshToken,
            existing.cloud?.refreshToken
          )
        }
      : incoming.cloud,
    externalApps: (() => {
      // 显式提交 externalApps 时，以入站 providers 为准（删除的平台不再从旧配置恢复）
      if (incoming.externalApps == null) return existing.externalApps
      const incomingProviders = incoming.externalApps.providers ?? {}
      const existingProviders = existing.externalApps?.providers ?? {}
      const providers: Record<string, ExternalAppConnection> = {}
      for (const id of Object.keys(incomingProviders)) {
        const next = incomingProviders[id]
        const prev = existingProviders[id]
        providers[id] = {
          ...next,
          accessToken: mergeSecretField(next.accessToken, prev?.accessToken)
        }
      }
      return { providers }
    })()
  }
}

export const saveAppConfig = (config: AppConfig): AppConfig => {
  const existing = getAppConfigPayload()
  const incomingPipelines =
    config.reviewPipelines != null
      ? config.reviewPipelines
      : (existing?.reviewPipelines ?? [])
  const pipelinesNorm = normalizeReviewPipelines(incomingPipelines, {
    previous: existing?.reviewPipelines ?? incomingPipelines,
    activePipelineId:
      config.activePipelineId ?? existing?.activePipelineId ?? ''
  })
  // 目录类配置（市场/预设）若本次未带上，保留库内已有，避免被空数组覆盖
  const merged: AppConfig = {
    ...config,
    batchReviewConcurrency: clampBatchReviewConcurrency(
      config.batchReviewConcurrency ??
        existing?.batchReviewConcurrency ??
        DEFAULT_BATCH_REVIEW_CONCURRENCY
    ),
    mcpMarketplace:
      config.mcpMarketplace?.length > 0
        ? config.mcpMarketplace
        : (existing?.mcpMarketplace ?? config.mcpMarketplace ?? []),
    mcpPresets:
      config.mcpPresets?.length > 0
        ? config.mcpPresets
        : (existing?.mcpPresets ?? config.mcpPresets ?? []),
    // 服务端目录同步可能返回空数组，需允许覆盖本地缓存
    llmProviderPresets: Array.isArray(config.llmProviderPresets)
      ? config.llmProviderPresets
      : (existing?.llmProviderPresets ?? []),
    reviewPipelines: pipelinesNorm.pipelines,
    activePipelineId: pipelinesNorm.activePipelineId,
    recentIdeProjects:
      config.recentIdeProjects != null
        ? config.recentIdeProjects
        : (existing?.recentIdeProjects ?? [])
  }
  const encrypted = withEncryptedSecrets(merged)
  saveAppConfigPayload(encrypted)
  try {
    legacyStore.set('config', encrypted)
  } catch {
    // ignore
  }
  return getAppConfig()
}

export const getConfigDefaults = (): AppConfig => ({ ...defaults })
