import type { McpServerConfig } from '../../shared/types'
import { mcpRegistry } from '../mcp-manager/registry'
import { getAppConfig } from '../config/store'
import {
  clearMcpRepoCache,
  getAllCachedRepos,
  getCachedBranches,
  getCachedRepos,
  getCachedSources,
  setCachedBranches,
  setCachedRepos,
  setCachedSources
} from './mcp-cache'

export interface McpRepoItem {
  url: string
  name: string
  fullName?: string
  provider: string
  serverId: string
  serverName: string
  defaultBranch?: string
}

const LIST_REPO_TOOLS = [
  'list_user_repos',
  'list_repositories',
  'list_repos',
  'list_projects',
  'search_repositories',
  'list_user_repositories',
  'list_owned_projects'
]

const detectProvider = (server: McpServerConfig, statusName: string): string => {
  const blob = [
    statusName,
    server.name,
    server.command,
    ...(server.args ?? []),
    ...Object.keys(server.env ?? {}),
    ...Object.values(server.env ?? {})
  ]
    .join(' ')
    .toLowerCase()
  if (/gitee|码云/.test(blob)) return 'gitee'
  if (/gitlab/.test(blob)) return 'gitlab'
  if (/github/.test(blob)) return 'github'
  return 'git'
}

const hostForProvider = (provider: string): string => {
  if (provider === 'github') return 'github.com'
  if (provider === 'gitlab') return 'gitlab.com'
  if (provider === 'gitee') return 'gitee.com'
  return 'gitee.com'
}

const providerLabel = (provider: string): string => {
  if (provider === 'github') return 'GitHub'
  if (provider === 'gitlab') return 'GitLab'
  if (provider === 'gitee') return 'Gitee'
  return 'Git'
}

/** 是否已配置平台 Token（有 Token 就走 HTTP API，禁止回退慢 MCP） */
const hasPlatformToken = (server: McpServerConfig, provider: string): boolean => {
  const env = server.env ?? {}
  if (provider === 'gitee') {
    return Boolean(env.GITEE_ACCESS_TOKEN || env.GITEE_PERSONAL_ACCESS_TOKEN)
  }
  if (provider === 'github') {
    return Boolean(env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN)
  }
  if (provider === 'gitlab') {
    return Boolean(env.GITLAB_PERSONAL_ACCESS_TOKEN || env.GITLAB_TOKEN)
  }
  return false
}

const toolContentToText = (result: unknown): string => {
  if (!result || typeof result !== 'object') return String(result ?? '')
  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text ?? '')
        }
        return typeof part === 'string' ? part : JSON.stringify(part)
      })
      .join('\n')
  }
  if ('structuredContent' in (result as object)) {
    return JSON.stringify((result as { structuredContent: unknown }).structuredContent)
  }
  return JSON.stringify(result)
}

const extractJson = (text: string): unknown => {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const startArr = trimmed.indexOf('[')
    const endArr = trimmed.lastIndexOf(']')
    if (startArr >= 0 && endArr > startArr) {
      try {
        return JSON.parse(trimmed.slice(startArr, endArr + 1))
      } catch {
        // continue
      }
    }
    const startObj = trimmed.indexOf('{')
    const endObj = trimmed.lastIndexOf('}')
    if (startObj >= 0 && endObj > startObj) {
      try {
        return JSON.parse(trimmed.slice(startObj, endObj + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

const asRepoList = (raw: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    for (const key of ['data', 'repos', 'repositories', 'items', 'list', 'result']) {
      if (Array.isArray(obj[key])) return obj[key] as Array<Record<string, unknown>>
    }
  }
  return []
}

const pickString = (row: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const normalizeRepoUrl = (
  row: Record<string, unknown>,
  provider: string
): string => {
  const html = pickString(row, [
    'html_url',
    'htmlUrl',
    'web_url',
    'webUrl',
    'clone_url',
    'cloneUrl',
    'http_url_to_repo',
    'ssh_url'
  ])
  if (/^https?:\/\//i.test(html) && !/\/api\//i.test(html) && !html.startsWith('git@')) {
    return html.endsWith('.git') ? html : `${html.replace(/\/$/, '')}.git`
  }
  const fullName =
    pickString(row, [
      'full_name',
      'fullName',
      'path_with_namespace',
      'pathWithNamespace',
      'path',
      'human_name',
      'humanName',
      'name_with_namespace'
    ]) || ''
  if (fullName.includes('/')) {
    return `https://${hostForProvider(provider)}/${fullName.replace(/\.git$/, '')}.git`
  }
  const name = pickString(row, ['name', 'repo', 'repository'])
  let owner = pickString(row, ['namespace', 'owner', 'login'])
  if (typeof row.namespace === 'object' && row.namespace) {
    owner =
      pickString(row.namespace as Record<string, unknown>, ['path', 'name', 'login', 'full_path']) ||
      owner
  }
  if (typeof row.owner === 'object' && row.owner) {
    owner =
      pickString(row.owner as Record<string, unknown>, ['login', 'name', 'path', 'username']) ||
      owner
  }
  if (owner && name) {
    return `https://${hostForProvider(provider)}/${owner}/${name}.git`
  }
  return ''
}

const isGitHostServer = (server: McpServerConfig): boolean => {
  const blob = [
    server.name,
    server.command,
    ...(server.args ?? []),
    ...Object.keys(server.env ?? {}),
    ...Object.values(server.env ?? {})
  ]
    .join(' ')
    .toLowerCase()
  // 只认代码托管 MCP；本地 filesystem/git 不出现在仓库来源里
  return /gitee|github|gitlab|码云|mcp-gitee|server-github|server-gitlab|gitee-mcp/.test(
    blob
  )
}

export interface McpRepoSource {
  serverId: string
  serverName: string
  provider: string
  connected: boolean
}

export const listGitMcpSources = async (): Promise<McpRepoSource[]> => {
  const config = getAppConfig()
  const statuses = mcpRegistry.getStatusFast(config.mcpServers)
  const statusMap = new Map(statuses.map((s) => [s.serverId, s]))

  const cached = getCachedSources()
  if (cached) {
    // 缓存结构可复用，但连接状态必须实时
    return cached.map((s) => ({
      ...s,
      connected: Boolean(statusMap.get(s.serverId)?.connected)
    }))
  }

  const sources = config.mcpServers.filter(isGitHostServer).map((s) => {
    const provider = detectProvider(s, s.name)
    return {
      serverId: s.id,
      serverName: `${providerLabel(provider)} · ${s.name}`,
      provider,
      connected: Boolean(statusMap.get(s.id)?.connected)
    }
  })
  setCachedSources(sources)
  return sources
}

const rowsToRepoItems = (
  rows: Array<Record<string, unknown>>,
  server: McpServerConfig,
  serverName: string,
  provider: string
): McpRepoItem[] => {
  const repos: McpRepoItem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const url = normalizeRepoUrl(row, provider)
    if (!url) continue
    const dedupeKey = url.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    const name =
      pickString(row, ['name', 'path', 'full_name', 'fullName', 'human_name']) || url
    repos.push({
      url,
      name,
      fullName:
        pickString(row, [
          'full_name',
          'fullName',
          'path_with_namespace',
          'path',
          'human_name'
        ]) || name,
      provider,
      serverId: server.id,
      serverName,
      defaultBranch: pickString(row, ['default_branch', 'defaultBranch']) || undefined
    })
  }
  return repos
}

/** 优先平台 API（快）；仅无 Token 时才回退 MCP（MCP 列仓常 30s+） */
const fetchReposForServer = async (
  server: McpServerConfig,
  serverName: string,
  provider: string,
  toolNames: string[]
): Promise<{ repos: McpRepoItem[]; error?: string }> => {
  const api = await listReposViaApi(server, provider)
  if (api.repos.length) {
    return {
      repos: rowsToRepoItems(api.repos, server, serverName, provider)
    }
  }

  // 已配置 Token 却 API 失败：直接报错，禁止拖进慢 MCP
  if (hasPlatformToken(server, provider)) {
    return {
      repos: [],
      error: api.error || `${server.name}: API 拉取仓库失败`
    }
  }

  const tool =
    LIST_REPO_TOOLS.find((name) => toolNames.includes(name)) ||
    toolNames.find((name) => /list.*(repo|project)/i.test(name))
  if (!tool) {
    return {
      repos: [],
      error:
        api.error ||
        `${server.name}: 请在 MCP 环境变量配置 ACCESS_TOKEN，以启用快速仓库列表`
    }
  }

  try {
    const result = await mcpRegistry.callTool(server.id, tool, {
      type: 'all',
      sort: 'updated',
      ownership: 'owned',
      page: 1,
      per_page: 50,
      perPage: 50
    })
    const text = toolContentToText(result)
    const rows = asRepoList(extractJson(text))
    if (!rows.length) {
      return { repos: [], error: api.error || `${server.name}: ${tool} 未返回仓库` }
    }
    return { repos: rowsToRepoItems(rows, server, serverName, provider) }
  } catch (error) {
    return {
      repos: [],
      error:
        api.error ||
        `${server.name}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

const listReposViaApi = async (
  server: McpServerConfig,
  provider: string
): Promise<{ repos: Array<Record<string, unknown>>; error?: string }> => {
  const env = server.env ?? {}
  try {
    if (provider === 'gitee') {
      const token = env.GITEE_ACCESS_TOKEN || env.GITEE_PERSONAL_ACCESS_TOKEN || ''
      if (!token) return { repos: [], error: 'Gitee: 缺少 ACCESS_TOKEN' }
      const apiBase = (env.GITEE_API_BASE || 'https://gitee.com/api/v5').replace(/\/$/, '')
      const url = `${apiBase}/user/repos?type=all&sort=updated&per_page=50&access_token=${encodeURIComponent(token)}`
      const res = await fetch(url)
      if (!res.ok) return { repos: [], error: `Gitee API ${res.status}` }
      const data = (await res.json()) as unknown
      return { repos: asRepoList(data) }
    }
    if (provider === 'github') {
      const token =
        env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || ''
      if (!token) return { repos: [], error: 'GitHub: 缺少 TOKEN' }
      const res = await fetch(
        'https://api.github.com/user/repos?per_page=50&sort=updated&affiliation=owner,collaborator,organization_member',
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`
          }
        }
      )
      if (!res.ok) return { repos: [], error: `GitHub API ${res.status}` }
      const data = (await res.json()) as unknown
      return { repos: asRepoList(data) }
    }
    if (provider === 'gitlab') {
      const token = env.GITLAB_PERSONAL_ACCESS_TOKEN || env.GITLAB_TOKEN || ''
      if (!token) return { repos: [], error: 'GitLab: 缺少 TOKEN' }
      const apiBase = (env.GITLAB_API_URL || 'https://gitlab.com/api/v4').replace(/\/$/, '')
      const res = await fetch(`${apiBase}/projects?membership=true&simple=true&per_page=50&order_by=last_activity_at`, {
        headers: { 'PRIVATE-TOKEN': token }
      })
      if (!res.ok) return { repos: [], error: `GitLab API ${res.status}` }
      const data = (await res.json()) as unknown
      return { repos: asRepoList(data) }
    }
  } catch (error) {
    return {
      repos: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
  return { repos: [], error: '无法拉取仓库' }
}

/** 连接成功后预热仓库缓存 */
export const warmMcpRepoCache = async (serverId: string): Promise<void> => {
  const config = getAppConfig()
  const server = config.mcpServers.find((s) => s.id === serverId)
  if (!server || !isGitHostServer(server)) return
  const provider = detectProvider(server, server.name)
  const serverName = `${providerLabel(provider)} · ${server.name}`
  const tools = mcpRegistry.getTools(serverId).map((t) => t.name)
  const result = await fetchReposForServer(server, serverName, provider, tools)
  if (result.repos.length) {
    setCachedRepos(serverId, result.repos)
  }
  const sources = await listGitMcpSources()
  setCachedSources(
    sources.map((s) =>
      s.serverId === serverId ? { ...s, connected: true } : s
    )
  )
}

export const listReposFromMcp = async (
  serverId?: string,
  options?: { forceRefresh?: boolean }
): Promise<{
  repos: McpRepoItem[]
  errors: string[]
  sources: McpRepoSource[]
  fromCache: boolean
}> => {
  const force = Boolean(options?.forceRefresh)
  if (force) {
    clearMcpRepoCache(serverId)
  }

  const sources = await listGitMcpSources()

  if (!force) {
    const cachedRepos = serverId
      ? getCachedRepos(serverId, true)
      : getAllCachedRepos(true)
    if (cachedRepos && cachedRepos.length) {
      const filtered = serverId
        ? cachedRepos.filter((r) => r.serverId === serverId)
        : cachedRepos
      if (filtered.length) {
        return {
          repos: filtered,
          errors: [],
          sources,
          fromCache: true
        }
      }
    }
  }

  const config = getAppConfig()
  const statuses = mcpRegistry.getStatusFast(config.mcpServers)
  const connectedIds = new Set(statuses.filter((s) => s.connected).map((s) => s.serverId))
  const targets = sources.filter((s) => {
    if (serverId && s.serverId !== serverId) return false
    const server = config.mcpServers.find((c) => c.id === s.serverId)
    if (!server) return false
    // 有 Token 可直接走 HTTP API；否则必须已连接 MCP
    if (hasPlatformToken(server, s.provider)) return true
    return connectedIds.has(s.serverId)
  })

  const repos: McpRepoItem[] = []
  const errors: string[] = []

  for (const source of sources) {
    if (serverId && source.serverId !== serverId) continue
    const server = config.mcpServers.find((c) => c.id === source.serverId)
    if (!server) continue
    if (!hasPlatformToken(server, source.provider) && !connectedIds.has(source.serverId)) {
      errors.push(`${source.serverName}: 未连接，且未配置 ACCESS_TOKEN`)
    }
  }

  await Promise.all(
    targets.map(async (source) => {
      const server = config.mcpServers.find((c) => c.id === source.serverId)
      if (!server) return
      if (!force) {
        const cached = getCachedRepos(source.serverId, true)
        if (cached?.length) {
          repos.push(...cached)
          return
        }
      }
      const tools = mcpRegistry.getTools(source.serverId).map((t) => t.name)
      const result = await fetchReposForServer(
        server,
        source.serverName,
        source.provider,
        tools
      )
      if (result.repos.length) {
        setCachedRepos(source.serverId, result.repos)
        repos.push(...result.repos)
      } else if (result.error) {
        errors.push(result.error)
      }
    })
  )

  return { repos, errors, sources, fromCache: false }
}

const parseOwnerRepo = (
  repoUrl: string
): { owner: string; repo: string } | null => {
  try {
    const cleaned = repoUrl.trim().replace(/\.git$/i, '')
    const m = cleaned.match(
      /(?:https?:\/\/)?(?:www\.)?(?:gitee\.com|github\.com|gitlab\.com)[/:]([^/]+)\/([^/#?]+)/i
    )
    if (!m) return null
    return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

const LIST_BRANCH_TOOLS = [
  'list_branches',
  'list_repo_branches',
  'gitee_list_branches',
  'list_repository_branches',
  'get_branches'
]

const asBranchNames = (raw: unknown): string[] => {
  const names: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) names.push(v.trim())
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>
        push(row.name ?? row.branch ?? row.ref ?? row.path)
      }
    }
    return Array.from(new Set(names))
  }

  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    for (const key of ['data', 'branches', 'items', 'list', 'result', 'refs']) {
      if (Array.isArray(obj[key])) return asBranchNames(obj[key])
    }
  }
  return []
}

const listBranchesViaApi = async (
  server: McpServerConfig,
  parsed: { owner: string; repo: string }
): Promise<{ branches: string[]; error?: string }> => {
  const provider = detectProvider(server, server.name)
  const env = server.env ?? {}

  try {
    if (provider === 'gitee') {
      const token = env.GITEE_ACCESS_TOKEN || env.GITEE_PERSONAL_ACCESS_TOKEN || ''
      const apiBase = (env.GITEE_API_BASE || 'https://gitee.com/api/v5').replace(/\/$/, '')
      const url = `${apiBase}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches?per_page=100${token ? `&access_token=${encodeURIComponent(token)}` : ''}`
      const res = await fetch(url)
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { branches: [], error: `Gitee API ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}` }
      }
      const data = (await res.json()) as unknown
      return { branches: asBranchNames(data) }
    }

    if (provider === 'github') {
      const token =
        env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || ''
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches?per_page=100`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          }
        }
      )
      if (!res.ok) return { branches: [], error: `GitHub API ${res.status}` }
      const data = (await res.json()) as unknown
      return { branches: asBranchNames(data) }
    }

    if (provider === 'gitlab') {
      const token = env.GITLAB_PERSONAL_ACCESS_TOKEN || env.GITLAB_TOKEN || ''
      const apiBase = (env.GITLAB_API_URL || 'https://gitlab.com/api/v4').replace(/\/$/, '')
      const project = encodeURIComponent(`${parsed.owner}/${parsed.repo}`)
      const res = await fetch(`${apiBase}/projects/${project}/repository/branches?per_page=100`, {
        headers: token ? { 'PRIVATE-TOKEN': token } : {}
      })
      if (!res.ok) return { branches: [], error: `GitLab API ${res.status}` }
      const data = (await res.json()) as unknown
      return { branches: asBranchNames(data) }
    }
  } catch (error) {
    return {
      branches: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }

  return { branches: [], error: '无法查询分支' }
}

/** 通过 API/MCP 查询分支；优先缓存与平台 API */
export const listBranchesFromMcp = async (input: {
  serverId: string
  repoUrl: string
  forceRefresh?: boolean
}): Promise<{ branches: string[]; error?: string; fromCache?: boolean }> => {
  const config = getAppConfig()
  const server = config.mcpServers.find((s) => s.id === input.serverId)
  if (!server) return { branches: [], error: '未找到对应 MCP' }

  if (!input.forceRefresh) {
    const cached = getCachedBranches(input.serverId, input.repoUrl, true)
    if (cached?.length) return { branches: cached, fromCache: true }
  }

  const parsed = parseOwnerRepo(input.repoUrl)
  if (!parsed) {
    return { branches: [], error: `无法解析仓库地址: ${input.repoUrl}` }
  }

  const provider = detectProvider(server, server.name)

  // 有 Token：直接 API（不依赖 MCP 是否已连接、也不走慢工具）
  const apiFirst = await listBranchesViaApi(server, parsed)
  if (apiFirst.branches.length) {
    setCachedBranches(input.serverId, input.repoUrl, apiFirst.branches)
    return { branches: apiFirst.branches, fromCache: false }
  }

  if (hasPlatformToken(server, provider)) {
    return {
      branches: [],
      error: apiFirst.error || 'API 未返回分支（请检查仓库权限）'
    }
  }

  const status = mcpRegistry.getStatusFast(config.mcpServers).find((s) => s.serverId === input.serverId)
  if (!status?.connected) {
    return { branches: [], error: '该 MCP 未连接，且未配置 ACCESS_TOKEN' }
  }

  const toolNames = mcpRegistry.getTools(input.serverId).map((t) => t.name)
  const tool =
    LIST_BRANCH_TOOLS.find((name) => toolNames.includes(name)) ||
    toolNames.find((name) => /list.*branch/i.test(name) || /branch.*list/i.test(name))

  if (!tool) {
    return {
      branches: [],
      error: apiFirst.error || '无法列出分支：请配置 ACCESS_TOKEN，或确认 MCP 支持分支工具'
    }
  }

  try {
    const result = await mcpRegistry.callTool(input.serverId, tool, {
      owner: parsed.owner,
      repo: parsed.repo,
      project_id: `${parsed.owner}/${parsed.repo}`,
      path_with_namespace: `${parsed.owner}/${parsed.repo}`,
      page: 1,
      per_page: 100,
      perPage: 100
    })
    const text = toolContentToText(result)
    const branches = asBranchNames(extractJson(text))
    if (!branches.length) {
      return { branches: [], error: apiFirst.error || `${tool} 未返回分支` }
    }
    setCachedBranches(input.serverId, input.repoUrl, branches)
    return { branches, fromCache: false }
  } catch (error) {
    return {
      branches: [],
      error:
        apiFirst.error ||
        (error instanceof Error ? error.message : String(error))
    }
  }
}
