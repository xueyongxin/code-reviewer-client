import { randomUUID } from 'crypto'
import type {
  AppConfig,
  IssueSeverity,
  LlmProviderConfig,
  ReviewFileResult,
  ReviewIssue
} from '../../shared/types'

interface LlmIssuePayload {
  filePath?: string
  line?: number
  severity?: string
  message?: string
  ruleId?: string
}

const normalizeSeverity = (value?: string): IssueSeverity => {
  const v = (value ?? '').toLowerCase()
  if (v === 'error' || v === 'critical' || v === 'high') return 'error'
  if (v === 'warning' || v === 'warn' || v === 'medium') return 'warning'
  return 'info'
}

const extractJsonArray = (text: string): LlmIssuePayload[] => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = (fenced?.[1] ?? text).trim()
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? (parsed as LlmIssuePayload[]) : []
  } catch {
    return []
  }
}

export interface LlmFocusMethod {
  id: string
  name: string
  description: string
}

const buildPrompt = (
  files: ReviewFileResult[],
  focusMethods?: LlmFocusMethod[],
  memoryBlock?: string
): string => {
  const snippets = files
    .slice(0, 8)
    .map((file) => {
      const body = file.content.split('\n').slice(0, 220).join('\n')
      return `### ${file.filePath}\n\`\`\`\n${body}\n\`\`\``
    })
    .join('\n\n')

  const focusBlock =
    focusMethods && focusMethods.length
      ? [
          '【强制重点】本次流水线已勾选下列审查方式。你必须逐项检查，优先报告这些类别的真实缺陷：',
          ...focusMethods.map(
            (m, i) =>
              `${i + 1}. ruleId="${m.id}"｜${m.name}：${m.description}`
          ),
          '规则：',
          '- 每条发现的 ruleId 必须使用上表对应 id（不要自造 ruleId）。',
          '- 只报告确认的严重缺陷，severity 一律用 error；不要输出 warning / info。',
          '- 若某项确认无问题可不报；但不得用行过长、命名风格等琐事充数。',
          '- 可额外报告其它严重问题，但仍须归到最接近的 ruleId；无法归类则用 "llm-other"。',
          ''
        ]
      : []

  const memoryLines = memoryBlock?.trim() ? [memoryBlock.trim(), ''] : []

  return [
    '你是资深代码审查助手。请审查下列变更代码，只找出严重真实问题（安全、正确性、数据损坏、严重缺陷）。',
    ...focusBlock,
    ...memoryLines,
    '只返回 JSON 数组，不要其他文字。每项字段：filePath, line, severity（固定为 error）, message, ruleId。',
    '不要输出 warning / info；忽略风格与轻微可维护性建议。不要重复显而易见的 console.log 之类（静态规则已覆盖）。最多返回 24 条。',
    '',
    snippets
  ].join('\n')
}

const fingerprint = (issue: Pick<ReviewIssue, 'filePath' | 'line' | 'message'>): string =>
  `${issue.filePath}::${issue.line}::${issue.message.toLowerCase().trim()}`

export const dedupeIssues = (issues: ReviewIssue[]): ReviewIssue[] => {
  const seen = new Set<string>()
  const result: ReviewIssue[] = []
  for (const issue of issues) {
    const key = fingerprint(issue)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(issue)
  }
  return result
}

export const resolveActiveProvider = (config: AppConfig): LlmProviderConfig | null => {
  const providers = config.llmProviders ?? []
  const active =
    providers.find((p) => p.id === config.activeLlmProviderId && p.enabled) ||
    providers.find((p) => p.enabled && p.apiKey?.trim()) ||
    providers.find((p) => p.enabled)

  if (active) return active

  // 兼容旧单模型字段（必须已有 baseUrl + model，不填默认厂商）
  if (config.llmApiKey?.trim() && config.llmBaseUrl?.trim() && config.llmModel?.trim()) {
    return {
      id: 'legacy',
      name: 'Legacy',
      protocol: 'openai-compatible',
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      enabled: true,
      fallbackModels: config.llmFallbackModels
    }
  }
  return null
}

const callOpenAiCompatible = async (
  provider: LlmProviderConfig,
  prompt: string,
  signal?: AbortSignal
): Promise<string> => {
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const endpoint = `${baseUrl}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`
    },
    signal,
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: '你只输出合法 JSON 数组，不要 Markdown 解释。' },
        { role: 'user', content: prompt }
      ]
    })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${provider.name} 调用失败 (${response.status}): ${detail.slice(0, 240)}`)
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? ''
}

const callAnthropic = async (
  provider: LlmProviderConfig,
  prompt: string,
  signal?: AbortSignal
): Promise<string> => {
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const endpoint = `${baseUrl}/v1/messages`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal,
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 2048,
      temperature: 0.1,
      system: '你只输出合法 JSON 数组，不要 Markdown 解释。',
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${provider.name} 调用失败 (${response.status}): ${detail.slice(0, 240)}`)
  }
  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>
  }
  return (data.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
}

const callOllama = async (
  provider: LlmProviderConfig,
  prompt: string,
  signal?: AbortSignal
): Promise<string> => {
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  // 优先 OpenAI 兼容口，失败再走原生 /api/chat
  try {
    return await callOpenAiCompatible(
      { ...provider, baseUrl: `${baseUrl}/v1`, apiKey: provider.apiKey || 'ollama' },
      prompt,
      signal
    )
  } catch {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        messages: [
          { role: 'system', content: '你只输出合法 JSON 数组，不要 Markdown 解释。' },
          { role: 'user', content: prompt }
        ]
      })
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`${provider.name} 调用失败 (${response.status}): ${detail.slice(0, 240)}`)
    }
    const data = (await response.json()) as { message?: { content?: string } }
    return data.message?.content ?? ''
  }
}

const callProvider = async (
  provider: LlmProviderConfig,
  prompt: string,
  signal?: AbortSignal
): Promise<string> => {
  if (provider.protocol === 'anthropic') {
    return callAnthropic(provider, prompt, signal)
  }
  if (provider.protocol === 'ollama') {
    return callOllama(provider, prompt, signal)
  }
  return callOpenAiCompatible(provider, prompt, signal)
}

const toIssues = (
  content: string,
  files: ReviewFileResult[]
): ReviewIssue[] => {
  const payloads = extractJsonArray(content)
  const knownFiles = new Set(files.map((f) => f.filePath))
  return payloads
    .filter((item) => item.message && item.filePath)
    .map((item) => ({
      id: randomUUID(),
      filePath: knownFiles.has(item.filePath!)
        ? item.filePath!
        : files[0]?.filePath || item.filePath!,
      line: Math.max(1, Number(item.line) || 1),
      severity: normalizeSeverity(item.severity),
      ruleId: item.ruleId?.trim() || 'llm-semantic',
      message: String(item.message).trim(),
      source: 'llm' as const
    }))
    // 报告只收录 error
    .filter((issue) => issue.severity === 'error')
}

/** 备用模型：优先提供商配置，其次全局配置，源码不写死厂商模型名 */
const modelFallbacks = (provider: LlmProviderConfig, config: AppConfig): string[] => {
  const primary = provider.model
  const extras = [
    ...(provider.fallbackModels ?? []),
    ...(config.llmFallbackModels ?? [])
  ].filter((m) => m && m !== primary)
  return [primary, ...Array.from(new Set(extras))]
}

export const runLlmReview = async (
  files: ReviewFileResult[],
  config: AppConfig,
  signal?: AbortSignal,
  options?: {
    focusHints?: string[]
    focusMethods?: LlmFocusMethod[]
    providerId?: string
    repoUrl?: string
    memoryBlock?: string
  }
): Promise<ReviewIssue[]> => {
  if (!config.enableLlm) return []

  const provider =
    (options?.providerId
      ? config.llmProviders.find((p) => p.id === options.providerId)
      : null) || resolveActiveProvider(config)
  if (!provider?.apiKey?.trim() && provider?.protocol !== 'ollama') {
    return []
  }

  const focusMethods =
    options?.focusMethods?.length
      ? options.focusMethods
      : options?.focusHints?.map((h, i) => ({
          id: `focus-${i + 1}`,
          name: h.split('：')[0] || h,
          description: h
        }))

  const prompt = buildPrompt(files, focusMethods, options?.memoryBlock)
  const models = modelFallbacks(provider, config)
  let lastError = ''

  for (const model of models) {
    try {
      const content = await callProvider({ ...provider, model }, prompt, signal)
      const issues = toIssues(content, files)
      if (issues.length || content.trim()) {
        return issues
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (signal?.aborted) throw error
    }
  }

  if (lastError) throw new Error(lastError)
  return []
}
