import type { McpServerConfig } from './types'

export const DEFAULT_MCP_JSON = `{
  "mcpServers": {
    "My MCP": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-everything"
      ],
      "env": {}
    }
  }
}`

export type ParseMcpJsonOptions = {
  preferName?: string
  keepId?: string
  enabled?: boolean
  /** 测试时可注入固定 id */
  createId?: () => string
}

/** 解析 Trae/Cursor 常见 mcpServers JSON，取第一条（或指定名称） */
export const parseMcpServersJson = (
  text: string,
  options?: ParseMcpJsonOptions
): McpServerConfig => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('JSON 格式无效，请检查后重试')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('配置内容无效')
  }

  const root = parsed as Record<string, unknown>
  let entries: Array<[string, Record<string, unknown>]> = []

  if (root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)) {
    entries = Object.entries(root.mcpServers as Record<string, unknown>).filter(
      (pair): pair is [string, Record<string, unknown>] =>
        Boolean(pair[0]) &&
        !!pair[1] &&
        typeof pair[1] === 'object' &&
        !Array.isArray(pair[1])
    )
  } else if (root.command || root.url) {
    const name =
      typeof root.name === 'string' && root.name.trim() ? root.name.trim() : 'My MCP'
    entries = [[name, root]]
  }

  if (!entries.length) {
    throw new Error('未找到 mcpServers 配置，请粘贴标准 MCP JSON')
  }

  const prefer = options?.preferName?.trim().toLowerCase()
  const hit =
    (prefer && entries.find(([n]) => n.toLowerCase() === prefer)) || entries[0]
  const [name, cfg] = hit

  const url = typeof cfg.url === 'string' ? cfg.url : ''
  const command = typeof cfg.command === 'string' ? cfg.command : ''
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
  const env =
    cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
      ? Object.fromEntries(
          Object.entries(cfg.env as Record<string, unknown>).map(([k, v]) => [
            k,
            String(v ?? '')
          ])
        )
      : {}

  if (!url && !command) {
    throw new Error('请至少配置 command 或 url')
  }

  const createId = options?.createId || (() => `mcp-${Date.now()}`)

  return {
    id: options?.keepId || createId(),
    name: name.trim() || '未命名 MCP',
    transport: url && !command ? 'sse' : 'stdio',
    command,
    args,
    url,
    env,
    enabled: options?.enabled ?? true
  }
}

export const titleFromMcpJson = (text: string, fallback: string): string => {
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> }
    const keys = parsed?.mcpServers ? Object.keys(parsed.mcpServers) : []
    if (keys[0]) return keys[0]
  } catch {
    // ignore
  }
  return fallback
}

export const buildMcpServersJson = (server: {
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}): string => {
  const body =
    server.transport === 'sse'
      ? { url: server.url || '' }
      : {
          command: server.command || '',
          args: server.args ?? [],
          env: server.env || {}
        }
  return JSON.stringify(
    {
      mcpServers: {
        [server.name]: body
      }
    },
    null,
    2
  )
}
