export type ChatCommandDef = {
  id: string
  key: string
  slash: string
  name: string
  description: string
  promptTemplate: string
  sortOrder?: number
}

/** 本地动作类命令（不走 LLM） */
export const LOCAL_COMMAND_KEYS = new Set([
  'clear',
  'help',
  'model',
  'report',
  'remember'
])

/** 云端拉取失败时仍可用的本地命令兜底 */
export const FALLBACK_LOCAL_COMMANDS: ChatCommandDef[] = [
  {
    id: 'local-clear',
    key: 'clear',
    slash: '/clear',
    name: '清空上下文',
    description: '开启新对话，清空当前上下文',
    promptTemplate: '',
    sortOrder: 900
  },
  {
    id: 'local-help',
    key: 'help',
    slash: '/help',
    name: '帮助',
    description: '列出可用 Slash 命令',
    promptTemplate: '',
    sortOrder: 910
  },
  {
    id: 'local-model',
    key: 'model',
    slash: '/model',
    name: '模型',
    description: '查看或切换当前模型',
    promptTemplate: '',
    sortOrder: 920
  },
  {
    id: 'local-report',
    key: 'report',
    slash: '/report',
    name: '报告',
    description: '查看或切换关联审查报告',
    promptTemplate: '',
    sortOrder: 930
  },
  {
    id: 'local-remember',
    key: 'remember',
    slash: '/remember',
    name: '记住',
    description: '将内容写入大模型记忆，如 /remember 本仓库禁止直接改生产配置',
    promptTemplate: '',
    sortOrder: 940
  }
]

export const renderPromptTemplate = (
  template: string,
  vars: { args?: string; reportId?: string }
): string => {
  return template
    .replace(/\{\{args\}\}/g, vars.args?.trim() || '（无）')
    .replace(/\{\{reportId\}\}/g, vars.reportId?.trim() || '（未关联）')
}

/** 合并云端命令与本地兜底（同 key 以云端为准） */
export const mergeChatCommands = (
  remote: ChatCommandDef[] | null | undefined
): ChatCommandDef[] => {
  const map = new Map<string, ChatCommandDef>()
  for (const c of FALLBACK_LOCAL_COMMANDS) map.set(c.key, c)
  for (const c of remote || []) {
    if (c?.key) map.set(c.key, c)
  }
  return Array.from(map.values()).sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.key.localeCompare(b.key)
  )
}

/** 解析输入：/review 补充说明 → { slash, args } */
export const parseSlashInput = (
  text: string
): { slash: string; args: string } | null => {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const m = trimmed.match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  return { slash: m[1], args: (m[2] || '').trim() }
}

export const matchCommand = (
  commands: ChatCommandDef[],
  slash: string
): ChatCommandDef | undefined => {
  const key = slash.toLowerCase()
  return commands.find(
    (c) => c.slash.toLowerCase() === key || `/${c.key}`.toLowerCase() === key
  )
}

export const filterCommands = (
  commands: ChatCommandDef[],
  query: string
): ChatCommandDef[] => {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  if (!q) return commands
  return commands.filter(
    (c) =>
      c.key.toLowerCase().includes(q) ||
      c.slash.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      (c.description || '').toLowerCase().includes(q)
  )
}

/** 会话标题：优先短 slash，避免整段提示词污染 */
export const titleFromChatContent = (content: string): string => {
  const trimmed = content.trim()
  const slash = trimmed.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i)
  if (slash) {
    const args = (slash[2] || '').replace(/\s+/g, ' ').trim()
    if (args) {
      return args.length > 20
        ? `/${slash[1]} ${args.slice(0, 20)}…`
        : `/${slash[1]} ${args}`
    }
    return `/${slash[1]}`
  }
  const line = trimmed.replace(/\s+/g, ' ')
  return line.length > 28 ? `${line.slice(0, 28)}…` : line || '新对话'
}

/**
 * 将用户可见的 slash 输入展开为发给 LLM 的提示词。
 * 本地命令或未知命令不展开；展示内容保持原输入。
 */
export const expandSlashForLlm = (
  content: string,
  commands: ChatCommandDef[],
  vars: { reportId?: string }
): { display: string; llm: string; command?: ChatCommandDef } => {
  const display = content.trim()
  const parsed = parseSlashInput(display)
  if (!parsed) return { display, llm: display }

  const cmd = matchCommand(commands, parsed.slash)
  if (!cmd || LOCAL_COMMAND_KEYS.has(cmd.key)) {
    return { display, llm: display, command: cmd }
  }

  const template = cmd.promptTemplate?.trim() || cmd.description || cmd.name
  const llm = renderPromptTemplate(template, {
    args: parsed.args,
    reportId: vars.reportId
  })
  return { display, llm, command: cmd }
}

/** 构造发送给主进程的 slash 原文（不展开模板） */
export const formatSlashMessage = (cmd: ChatCommandDef, args = ''): string => {
  const a = args.trim()
  return a ? `${cmd.slash} ${a}` : cmd.slash
}
