import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { AppConfig, LlmProviderConfig, McpMarketplaceItem, McpPreset } from '../../shared/types'
import { DEFAULT_RULE_IDS } from '../review-engine/static-rules'
import { getAppConfigPayload, saveAppConfigPayload } from '../database/db'
import marketplaceSeed from './mcp-marketplace-seed.json'

const ENC_PREFIX = 'enc::'

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
  cloud: {
    apiBase: 'http://localhost:3100',
    authWebBase: 'http://localhost:3000',
    autoUploadReports: false
  }
}

/** 兼容旧版 electron-store，仅作一次性迁移来源 */
const legacyStore = new Store<{ config: AppConfig }>({
  name: 'app-config',
  defaults: { config: defaults }
})

const encryptSecret = (value?: string): string => {
  if (!value) return ''
  if (value.startsWith(ENC_PREFIX)) return value
  if (!safeStorage.isEncryptionAvailable()) return value
  const encrypted = safeStorage.encryptString(value)
  return `${ENC_PREFIX}${encrypted.toString('base64')}`
}

const decryptSecret = (value?: string): string => {
  if (!value) return ''
  if (!value.startsWith(ENC_PREFIX)) return value
  if (!safeStorage.isEncryptionAvailable()) return value.slice(ENC_PREFIX.length)
  try {
    const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    return ''
  }
}

const withDecryptedSecrets = (config: AppConfig): AppConfig => ({
  ...config,
  githubToken: decryptSecret(config.githubToken),
  llmApiKey: decryptSecret(config.llmApiKey),
  llmProviders: (config.llmProviders ?? []).map((p) => ({
    ...p,
    apiKey: decryptSecret(p.apiKey)
  })),
  cloud: config.cloud
    ? {
        ...config.cloud,
        accessToken: decryptSecret(config.cloud.accessToken),
        refreshToken: decryptSecret(config.cloud.refreshToken)
      }
    : config.cloud
})

const withEncryptedSecrets = (config: AppConfig): AppConfig => ({
  ...config,
  githubToken: encryptSecret(config.githubToken),
  llmApiKey: encryptSecret(config.llmApiKey),
  llmProviders: (config.llmProviders ?? []).map((p) => ({
    ...p,
    apiKey: encryptSecret(p.apiKey)
  })),
  cloud: config.cloud
    ? {
        ...config.cloud,
        accessToken: encryptSecret(config.cloud.accessToken),
        refreshToken: encryptSecret(config.cloud.refreshToken)
      }
    : config.cloud
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
  const merged = withDecryptedSecrets({
    ...defaults,
    ...raw,
    mcpServers: raw.mcpServers ?? [],
    mcpPresets: raw.mcpPresets ?? [],
    mcpMarketplace: raw.mcpMarketplace ?? [],
    reviewPipelines: raw.reviewPipelines ?? [],
    activePipelineId: raw.activePipelineId ?? '',
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
    cloud: {
      apiBase: raw.cloud?.apiBase || 'http://localhost:3100',
      authWebBase: raw.cloud?.authWebBase || 'http://localhost:3000',
      accessToken: raw.cloud?.accessToken || '',
      refreshToken: raw.cloud?.refreshToken || '',
      user: raw.cloud?.user,
      orgId: raw.cloud?.orgId || '',
      orgName: raw.cloud?.orgName || '',
      lastConfigVersion: raw.cloud?.lastConfigVersion || 0,
      lastSyncAt: raw.cloud?.lastSyncAt,
      autoUploadReports: raw.cloud?.autoUploadReports ?? false
    },
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

export const getAppConfig = (): AppConfig => {
  return ensureMarketplaceCatalog(normalizeConfig(loadRawConfig()))
}

export const saveAppConfig = (config: AppConfig): AppConfig => {
  const existing = getAppConfigPayload()
  // 目录类配置（市场/预设）若本次未带上，保留库内已有，避免被空数组覆盖
  const merged: AppConfig = {
    ...config,
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
    reviewPipelines:
      config.reviewPipelines != null
        ? config.reviewPipelines
        : (existing?.reviewPipelines ?? [])
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
