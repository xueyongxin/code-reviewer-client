import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import type { AppConfig, LlmProtocol, StartReviewPayload } from '../../shared/types'
import { getAppConfig, saveAppConfig } from '../config/store'

export interface DocDemoConfig {
  providerName: string
  protocol: LlmProtocol
  baseUrl: string
  model: string
  apiKey: string
  fallbackModels: string[]
  repos: Array<{ name: string; url: string }>
}

const candidateDocPaths = (): string[] => {
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  return [
    join(cwd, '需求文档.md'),
    join(cwd, '..', '需求文档.md'),
    join(appPath, '..', '需求文档.md'),
    join(appPath, '..', '..', '需求文档.md'),
    join(appPath, '../../../需求文档.md'),
    '/Volumes/data/workspace/cursor/code/需求文档.md'
  ]
}

const pickKv = (doc: string, keys: string[]): string => {
  for (const key of keys) {
    const re = new RegExp(`${key}\\s*[:：]\\s*(\\S+)`, 'i')
    const m = doc.match(re)
    if (m?.[1]) return m[1].trim()
  }
  return ''
}

const pickProviderName = (doc: string): string => {
  const named = pickKv(doc, ['provider', '厂商', '提供商', 'name'])
  if (named) return named
  // 取「模型」行之前最近的非空短标题行（跳过 url / key=value）
  const modelIdx = doc.search(/模型\s*[:：]/)
  const head = modelIdx > 0 ? doc.slice(0, modelIdx) : doc
  const lines = head
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !l.startsWith('#') &&
        !l.startsWith('|') &&
        !l.startsWith('*') &&
        !/^[a-zA-Z_][\w]*\s*[:：]/.test(l) &&
        !/^https?:\/\//i.test(l)
    )
  return lines[lines.length - 1] || 'LLM Provider'
}

const pickProtocol = (raw: string): LlmProtocol => {
  const v = raw.toLowerCase()
  if (v.includes('anthropic')) return 'anthropic'
  if (v.includes('ollama')) return 'ollama'
  return 'openai-compatible'
}

const pickRepos = (doc: string): Array<{ name: string; url: string }> => {
  const repos: Array<{ name: string; url: string }> = []
  const gitee = pickKv(doc, ['gitee'])
  const github = pickKv(doc, ['GitHub', 'github'])
  if (gitee) repos.push({ name: 'Gitee', url: gitee })
  if (github) repos.push({ name: 'GitHub', url: github })

  // 兼容 repo: / repos: 多行 URL
  const urlRe = /(?:^|\n)\s*(?:repo|repos|仓库)\s*[:：]\s*(\S+)/gi
  let urlMatch: RegExpExecArray | null
  while ((urlMatch = urlRe.exec(doc)) !== null) {
    const url = urlMatch[1]
    if (!repos.some((r) => r.url === url)) {
      repos.push({ name: `Repo-${repos.length + 1}`, url })
    }
  }
  return repos
}

export const loadDocDemoConfig = (): DocDemoConfig => {
  const path = candidateDocPaths().find((p) => existsSync(p))
  if (!path) {
    throw new Error('未找到需求文档.md，请确认工作区根目录存在该文件')
  }
  const doc = readFileSync(path, 'utf-8')
  const model = pickKv(doc, ['模型', 'model'])
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.SILICONFLOW_API_KEY ||
    process.env.ZHIPU_API_KEY ||
    pickKv(doc, ['key', 'apiKey', 'api_key', '密钥'])
  const baseUrl = pickKv(doc, ['baseUrl', 'base_url', 'endpoint', '接口', '地址'])
  const protocol = pickProtocol(pickKv(doc, ['protocol', '协议']))
  const providerName = pickProviderName(doc)
  const fallbackRaw = pickKv(doc, ['fallbackModels', 'fallback', '备用模型'])
  const fallbackModels = fallbackRaw
    ? fallbackRaw.split(/[,，|]/).map((s) => s.trim()).filter(Boolean)
    : []
  const repos = pickRepos(doc)

  if (!model) throw new Error('需求文档缺少「模型」配置')
  if (!apiKey) throw new Error('需求文档缺少 API Key（key:）')
  if (!baseUrl) throw new Error('需求文档缺少 baseUrl（例：baseUrl: https://...）')
  if (!repos.length) throw new Error('需求文档缺少仓库地址（gitee: / GitHub:）')

  return {
    providerName,
    protocol,
    baseUrl,
    model,
    apiKey,
    fallbackModels,
    repos
  }
}

/** 把文档中的 LLM 配置写入 SQLite（app_config） */
export const applyDocLlmConfig = (): AppConfig => {
  const demo = loadDocDemoConfig()
  const config = getAppConfig()
  const providers = [...(config.llmProviders || [])]
  let provider = providers.find(
    (p) =>
      p.baseUrl.replace(/\/$/, '') === demo.baseUrl.replace(/\/$/, '') ||
      p.name === demo.providerName
  )

  if (!provider) {
    provider = {
      id: randomUUID(),
      name: demo.providerName,
      protocol: demo.protocol,
      baseUrl: demo.baseUrl,
      apiKey: demo.apiKey,
      model: demo.model,
      enabled: true,
      fallbackModels: demo.fallbackModels
    }
    providers.unshift(provider)
  } else {
    provider = {
      ...provider,
      name: demo.providerName,
      protocol: demo.protocol,
      apiKey: demo.apiKey,
      model: demo.model,
      enabled: true,
      baseUrl: demo.baseUrl,
      fallbackModels: demo.fallbackModels.length
        ? demo.fallbackModels
        : provider.fallbackModels
    }
    const idx = providers.findIndex((p) => p.id === provider!.id)
    providers[idx] = provider
  }

  const normalized = providers.map((p) =>
    p.id === provider!.id ? provider! : { ...p, enabled: false }
  )

  return saveAppConfig({
    ...config,
    llmProviders: normalized,
    activeLlmProviderId: provider.id,
    llmApiKey: demo.apiKey,
    llmBaseUrl: demo.baseUrl,
    llmModel: demo.model,
    llmFallbackModels: demo.fallbackModels.length
      ? demo.fallbackModels
      : config.llmFallbackModels,
    quickRepoUrls: demo.repos.map((r) => r.url),
    enableLlm: true,
    enableGitClone: true,
    notifyOnComplete: false
  })
}

export const buildDocDemoPayloads = (): StartReviewPayload[] => {
  const demo = loadDocDemoConfig()
  return demo.repos.map((repo) => ({
    repoUrl: repo.url,
    forceRefresh: true
  }))
}
