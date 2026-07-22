import type {
  AppConfig,
  ChatMessage,
  LlmMemory,
  MemoryKind,
  MemorySource,
  ReviewIssue,
  UpsertMemoryInput
} from '../../shared/types'
import { getAppConfig } from '../config/store'
import {
  enforceLlmMemoryCapacity,
  getLlmMemoryStats,
  listLlmMemories,
  normalizeMemoryRepoUrl,
  upsertLlmMemory
} from '../database/db'

/** 注入记忆的大致字符上限 */
const MAX_MEMORY_CHARS = 2400
const MAX_MEMORY_ITEMS = 12

const KIND_LABEL: Record<LlmMemory['kind'], string> = {
  preference: '用户偏好',
  convention: '项目约定',
  review: '审查结论',
  fix: '修复经验',
  note: '笔记'
}

const normalizeContentKey = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, 120)

/** 简单相似度：归一化后包含或相等 */
export const findSimilarMemory = (
  content: string,
  candidates?: LlmMemory[]
): LlmMemory | null => {
  const key = normalizeContentKey(content)
  if (key.length < 4) return null
  const list = candidates || listLlmMemories({})
  for (const m of list) {
    const other = normalizeContentKey(m.content)
    if (!other) continue
    if (other === key) return m
    if (other.includes(key) || key.includes(other)) {
      const shorter = Math.min(other.length, key.length)
      const longer = Math.max(other.length, key.length)
      if (shorter / longer >= 0.72) return m
    }
  }
  return null
}

export const upsertMemoryWithDedup = (
  input: UpsertMemoryInput,
  maxCount?: number
): { memory: LlmMemory; merged: boolean } => {
  const similar = findSimilarMemory(input.content)
  if (similar) {
    const merged = upsertLlmMemory({
      id: similar.id,
      title: input.title || similar.title,
      content: input.content.length >= similar.content.length ? input.content : similar.content,
      kind: input.kind || similar.kind,
      scope: input.scope || similar.scope,
      repoUrl: input.repoUrl ?? similar.repoUrl,
      tags: Array.from(new Set([...(similar.tags || []), ...(input.tags || [])])),
      enabled: input.enabled ?? similar.enabled,
      source: input.source || similar.source
    })
    const config = getAppConfig()
    enforceLlmMemoryCapacity(maxCount ?? config.memoryMaxCount ?? 200)
    return { memory: merged, merged: true }
  }
  const memory = upsertLlmMemory(input)
  const config = getAppConfig()
  enforceLlmMemoryCapacity(maxCount ?? config.memoryMaxCount ?? 200)
  return { memory, merged: false }
}

const charBigrams = (text: string): Set<string> => {
  const s = text.toLowerCase().replace(/\s+/g, '')
  const out = new Set<string>()
  if (s.length <= 1) {
    if (s) out.add(s)
    return out
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of Array.from(a)) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export const selectMemoriesForContext = (input: {
  config: AppConfig
  repoUrl?: string | null
  queryText?: string
  skipMemory?: boolean
}): LlmMemory[] => {
  if (!input.config.enableMemory || input.skipMemory) return []

  const repo = normalizeMemoryRepoUrl(input.repoUrl)
  const all = listLlmMemories({ enabledOnly: true })
  const scoped = all.filter((m) => {
    if (m.scope === 'global') return true
    if (m.scope === 'repo') {
      if (!repo) return false
      return normalizeMemoryRepoUrl(m.repoUrl) === repo
    }
    return false
  })

  const q = (input.queryText || '').trim().toLowerCase()
  const tokens = q
    ? q
        .split(/[\s,，、;；|/]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
    : []
  const queryGrams = q ? charBigrams(q) : new Set<string>()
  const hybrid = input.config.memoryRetrievalMode !== 'keyword'

  const scored = scoped
    .map((m) => {
      let score = 1
      if (m.scope === 'repo') score += 3
      const hay = `${m.title}\n${m.content}\n${m.tags.join(' ')}`.toLowerCase()
      if (tokens.length) {
        for (const t of tokens) {
          if (hay.includes(t)) score += 2
        }
      }
      if (hybrid && queryGrams.size) {
        const sim = jaccard(queryGrams, charBigrams(hay))
        score += sim * 8
      }
      return { m, score }
    })
    .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt))

  const picked: LlmMemory[] = []
  let chars = 0
  for (const { m } of scored) {
    if (picked.length >= MAX_MEMORY_ITEMS) break
    const piece = `${m.title}\n${m.content}`
    if (chars + piece.length > MAX_MEMORY_CHARS && picked.length > 0) break
    picked.push(m)
    chars += piece.length
  }
  return picked
}

export const formatMemoriesForPrompt = (memories: LlmMemory[]): string => {
  if (!memories.length) return ''
  const lines = memories.map((m, i) => {
    const scope =
      m.scope === 'repo' ? `仓库${m.repoUrl ? ` · ${m.repoUrl}` : ''}` : '全局'
    const tags = m.tags.length ? ` · 标签: ${m.tags.join(', ')}` : ''
    return `${i + 1}. [${KIND_LABEL[m.kind]} · ${scope}${tags}] ${m.title}\n${m.content}`
  })
  return [
    '【长期记忆】以下是用户确认保存的跨会话记忆，请在回答或审查时优先遵守；若与当前代码冲突，以当前代码为准并说明。',
    ...lines
  ].join('\n\n')
}

export const buildMemoryPromptBlock = (input: {
  config: AppConfig
  repoUrl?: string | null
  queryText?: string
  skipMemory?: boolean
}): { block: string; memories: LlmMemory[] } => {
  const memories = selectMemoriesForContext(input)
  return { block: formatMemoriesForPrompt(memories), memories }
}

/** /remember 正文 → 写入一条笔记记忆 */
export const rememberFromText = (input: {
  text: string
  repoUrl?: string | null
}): LlmMemory => {
  const raw = input.text.trim()
  if (!raw) throw new Error('请提供要记住的内容，例如 /remember 本仓库禁止硬编码密钥')

  const repo = normalizeMemoryRepoUrl(input.repoUrl)
  const title =
    raw.length > 36 ? `${raw.slice(0, 36).replace(/\s+/g, ' ')}…` : raw.replace(/\s+/g, ' ')

  return upsertMemoryWithDedup({
    title,
    content: raw,
    kind: 'note',
    scope: repo ? 'repo' : 'global',
    repoUrl: repo || undefined,
    tags: [],
    enabled: true,
    source: 'remember'
  }).memory
}

const looksDistillable = (text: string): boolean => {
  const t = text.trim()
  if (t.length < 4 || t.length > 400) return false
  if (/^\/\w+/.test(t)) return false
  return /我是|我叫|请记住|以后请|以后要|不要再|务必|必须|习惯|偏好|约定|禁止|始终|永远|称呼我|我的名字/.test(
    t
  )
}

const inferKind = (text: string): MemoryKind => {
  if (/禁止|必须|务必|约定|规范/.test(text)) return 'convention'
  if (/我是|我叫|称呼|偏好|习惯/.test(text)) return 'preference'
  if (/修复|改成|应该用|不要用/.test(text)) return 'fix'
  return 'note'
}

const titleFromContent = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 36 ? `${one.slice(0, 36)}…` : one
}

/** 从对话用户消息启发式沉淀（需自动开关或手动触发） */
export const distillMemoriesFromChat = (input: {
  messages: ChatMessage[]
  repoUrl?: string | null
  source?: MemorySource
  force?: boolean
}): LlmMemory[] => {
  const config = getAppConfig()
  if (!config.enableMemory) return []
  if (!input.force && !config.enableMemoryAutoExtract) return []

  const repo = normalizeMemoryRepoUrl(input.repoUrl)
  const created: LlmMemory[] = []
  const users = input.messages.filter((m) => m.role === 'user').slice(-6)
  for (const msg of users) {
    const text = msg.content.trim()
    // 去掉附件块，只看纯文本
    const plain = text
      .replace(/\[附件:[^\]]+\][\s\S]*?(?=\n\[附件:|$)/g, '')
      .trim()
    if (!looksDistillable(plain)) continue
    const { memory } = upsertMemoryWithDedup({
      title: titleFromContent(plain),
      content: plain,
      kind: inferKind(plain),
      scope: repo ? 'repo' : 'global',
      repoUrl: repo || undefined,
      tags: ['auto-chat'],
      enabled: true,
      source: input.source || 'chat'
    })
    if (!created.some((c) => c.id === memory.id)) created.push(memory)
  }
  return created
}

/** 从审查 error 沉淀关键结论 */
export const distillMemoriesFromReview = (input: {
  issues: ReviewIssue[]
  repoUrl?: string | null
  force?: boolean
}): LlmMemory[] => {
  const config = getAppConfig()
  if (!config.enableMemory) return []
  if (!input.force && !config.enableMemoryAutoExtract) return []

  const repo = normalizeMemoryRepoUrl(input.repoUrl)
  const errors = (input.issues || [])
    .filter((i) => (i.severity || '').toLowerCase() === 'error')
    .slice(0, 8)

  const created: LlmMemory[] = []
  for (const issue of errors) {
    const content = `${issue.filePath}:${issue.line} — ${issue.message}`.trim()
    if (content.length < 8) continue
    const { memory } = upsertMemoryWithDedup({
      title: titleFromContent(issue.message || content),
      content: `审查曾发现：${content}`,
      kind: 'review',
      scope: repo ? 'repo' : 'global',
      repoUrl: repo || undefined,
      tags: ['auto-review', issue.ruleId].filter(Boolean) as string[],
      enabled: true,
      source: 'review'
    })
    if (!created.some((c) => c.id === memory.id)) created.push(memory)
  }
  return created
}

export const memoryStats = (): ReturnType<typeof getLlmMemoryStats> => {
  const config = getAppConfig()
  return getLlmMemoryStats(config.memoryMaxCount ?? 200)
}

export type MemoryExportPayload = {
  version: 1
  exportedAt: string
  items: Array<{
    title: string
    content: string
    kind: MemoryKind
    scope: 'global' | 'repo'
    repoUrl?: string
    tags: string[]
    enabled: boolean
    source: MemorySource
  }>
}

export const exportMemoriesPayload = (): MemoryExportPayload => {
  const items = listLlmMemories({}).map((m) => ({
    title: m.title,
    content: m.content,
    kind: m.kind,
    scope: m.scope,
    repoUrl: m.repoUrl,
    tags: m.tags,
    enabled: m.enabled,
    source: m.source
  }))
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    items
  }
}

export const importMemoriesPayload = (
  payload: unknown
): { imported: number; merged: number } => {
  const data = payload as MemoryExportPayload
  if (!data || data.version !== 1 || !Array.isArray(data.items)) {
    throw new Error('无效的记忆备份文件')
  }
  let imported = 0
  let merged = 0
  for (const item of data.items) {
    if (!item?.content?.trim()) continue
    const r = upsertMemoryWithDedup({
      title: item.title || titleFromContent(item.content),
      content: item.content.trim(),
      kind: item.kind || 'note',
      scope: item.scope === 'repo' ? 'repo' : 'global',
      repoUrl: item.repoUrl,
      tags: Array.isArray(item.tags) ? item.tags : [],
      enabled: item.enabled !== false,
      source: item.source || 'manual'
    })
    if (r.merged) merged++
    else imported++
  }
  return { imported, merged }
}

const extractTextFromMcpResult = (toolResult: unknown): string => {
  if (!toolResult || typeof toolResult !== 'object') return ''
  const content = (toolResult as { content?: Array<{ type?: string; text?: string }> })
    .content
  if (!Array.isArray(content)) return JSON.stringify(toolResult)
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}

/** 从已连接的 Memory MCP 尝试导入（可选适配，非主路径） */
export const importFromMemoryMcp = async (): Promise<{
  imported: number
  merged: number
  detail: string
}> => {
  const { mcpRegistry } = await import('../mcp-manager/registry')
  const { getAppConfig: loadConfig } = await import('../config/store')
  const config = loadConfig()
  const memoryServer =
    config.mcpServers.find(
      (s) =>
        s.enabled &&
        (s.name?.toLowerCase().includes('memory') ||
          s.id?.toLowerCase().includes('memory') ||
          (s.args || []).some((a) => String(a).includes('server-memory')))
    ) || null

  if (!memoryServer) {
    throw new Error(
      '未找到 Memory MCP 配置。请在设置 → MCP 添加「Memory」并启用。'
    )
  }

  const toolNames = mcpRegistry.getTools(memoryServer.id).map((t) => t.name)
  if (!toolNames.length) {
    throw new Error(
      'Memory MCP 未连接。请在设置 → MCP 连接「Memory」后重试。'
    )
  }
  const readTools = [
    'read_graph',
    'search_nodes',
    'open_nodes',
    'list_entities',
    'get_entities'
  ]
  const toolName = readTools.find((t) => toolNames.includes(t))
  if (!toolName) {
    throw new Error(
      `Memory MCP 未暴露可读工具（尝试过：${readTools.join(', ')}）`
    )
  }

  const args =
    toolName === 'search_nodes'
      ? { query: '' }
      : toolName === 'open_nodes'
        ? { names: [] as string[] }
        : {}
  const raw = await mcpRegistry.callTool(memoryServer.id, toolName, args)
  const text = extractTextFromMcpResult(raw)
  let entities: Array<{ name?: string; observations?: string[] }> = []
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) {
      entities = parsed as Array<{ name?: string; observations?: string[] }>
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { entities?: unknown }).entities)
    ) {
      entities = (parsed as { entities: Array<{ name?: string; observations?: string[] }> })
        .entities
    }
  } catch {
    // 非 JSON：整段作为一条笔记
    if (text.trim()) {
      const r = upsertMemoryWithDedup({
        title: 'MCP Memory 导入',
        content: text.trim().slice(0, 2000),
        kind: 'note',
        scope: 'global',
        tags: ['mcp-memory'],
        source: 'manual'
      })
      return {
        imported: r.merged ? 0 : 1,
        merged: r.merged ? 1 : 0,
        detail: `已从 ${toolName} 导入文本`
      }
    }
    throw new Error(`Memory MCP 工具 ${toolName} 返回内容无法解析`)
  }

  let imported = 0
  let merged = 0
  for (const ent of entities.slice(0, 100)) {
    const name = (ent.name || '').trim()
    const obs = (ent.observations || []).filter(Boolean).join('\n')
    const content = [name, obs].filter(Boolean).join('\n').trim()
    if (!content) continue
    const r = upsertMemoryWithDedup({
      title: name || titleFromContent(content),
      content,
      kind: 'note',
      scope: 'global',
      tags: ['mcp-memory'],
      source: 'manual'
    })
    if (r.merged) merged++
    else imported++
  }
  return {
    imported,
    merged,
    detail: `工具 ${toolName} · 实体 ${entities.length} 个`
  }
}
