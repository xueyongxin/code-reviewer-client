import { createHash } from 'crypto'
import { getAppConfig } from '../config/store'
import {
  clearExtAppRepoCache,
  getExtAppRepoCache,
  setExtAppRepoCache
} from '../database/db'
import {
  CODE_REPO_PROVIDERS_FALLBACK,
  type CodeRepoProviderId
} from '../../shared/code-repo-providers'
import type { ExternalAppConnection } from '../../shared/types'

/** 仓库列表 SQLite 缓存 TTL（超时仍可先读缓存，再后台刷新） */
const REPO_CACHE_TTL_MS = 10 * 60 * 1000

export interface ExtAppRepoItem {
  url: string
  name: string
  fullName?: string
  providerId: string
  providerName: string
  defaultBranch?: string
}

export interface ExtAppRepoSource {
  providerId: string
  providerName: string
  connected: boolean
  accountLabel?: string
}

const providerNameOf = (id: string): string =>
  CODE_REPO_PROVIDERS_FALLBACK.find((p) => p.id === id)?.name || id

const trimBase = (raw?: string): string => (raw || '').trim().replace(/\/$/, '')

const pickString = (row: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const asRepoList = (raw: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    for (const key of [
      'data',
      'repos',
      'repositories',
      'items',
      'list',
      'result',
      'value'
    ]) {
      if (Array.isArray(obj[key])) return obj[key] as Array<Record<string, unknown>>
    }
  }
  return []
}

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
    for (const key of ['data', 'branches', 'items', 'list', 'result', 'refs', 'value']) {
      if (Array.isArray(obj[key])) return asBranchNames(obj[key])
    }
  }
  return []
}

const connectedProviders = (): Array<{
  id: CodeRepoProviderId
  conn: ExternalAppConnection
  token: string
}> => {
  const config = getAppConfig()
  const providers = config.externalApps?.providers ?? {}
  const out: Array<{ id: CodeRepoProviderId; conn: ExternalAppConnection; token: string }> = []
  const ids = new Set<string>([
    ...Object.keys(providers),
    ...(config.githubToken?.trim() ? ['github'] : [])
  ])

  for (const id of Array.from(ids)) {
    const conn = providers[id]
    const token =
      conn?.accessToken?.trim() ||
      (id === 'github' ? config.githubToken?.trim() : '') ||
      ''
    const connected = Boolean(conn?.connected && token) || (id === 'github' && Boolean(token))
    if (!connected || !token) continue
    out.push({
      id,
      conn: conn || { connected: true, accessToken: token },
      token
    })
  }
  return out
}

const defaultHost = (id: string, baseUrl?: string): string => {
  const fromBase = trimBase(baseUrl)
  if (fromBase) {
    try {
      return new URL(/^https?:\/\//i.test(fromBase) ? fromBase : `https://${fromBase}`)
        .hostname
    } catch {
      /* ignore */
    }
  }
  switch (id) {
    case 'github':
      return 'github.com'
    case 'gitlab':
      return 'gitlab.com'
    case 'gitee':
      return 'gitee.com'
    case 'bitbucket':
      return 'bitbucket.org'
    case 'gitcode':
      return 'gitcode.com'
    case 'coding':
      return 'e.coding.net'
    default:
      return ''
  }
}

const normalizeRepoUrl = (
  row: Record<string, unknown>,
  providerId: string,
  baseUrl?: string
): string => {
  const html = pickString(row, [
    'clone_url',
    'cloneUrl',
    'http_url_to_repo',
    'httpUrlToRepo',
    'html_url',
    'htmlUrl',
    'web_url',
    'webUrl',
    'remoteUrl',
    'ssh_url'
  ])
  if (/^https?:\/\//i.test(html) && !/\/api\//i.test(html) && !html.startsWith('git@')) {
    return html.endsWith('.git') ? html : `${html.replace(/\/$/, '')}.git`
  }

  // Bitbucket links
  const links = row.links as Record<string, unknown> | undefined
  const clone = links?.clone
  if (Array.isArray(clone)) {
    const https = clone.find(
      (c) =>
        c &&
        typeof c === 'object' &&
        (c as { name?: string }).name === 'https' &&
        typeof (c as { href?: string }).href === 'string'
    ) as { href: string } | undefined
    if (https?.href) {
      return https.href.endsWith('.git') ? https.href : `${https.href.replace(/\/$/, '')}.git`
    }
  }

  const fullName =
    pickString(row, [
      'full_name',
      'fullName',
      'path_with_namespace',
      'pathWithNamespace',
      'path',
      'name_with_namespace'
    ]) || ''
  const host = defaultHost(providerId, baseUrl)
  if (fullName.includes('/') && host) {
    return `https://${host}/${fullName.replace(/\.git$/, '')}.git`
  }

  const name = pickString(row, ['name', 'repo', 'repository', 'repoName'])
  let owner = pickString(row, ['namespace', 'owner', 'login', 'projectName'])
  if (typeof row.namespace === 'object' && row.namespace) {
    owner =
      pickString(row.namespace as Record<string, unknown>, [
        'path',
        'name',
        'login',
        'full_path'
      ]) || owner
  }
  if (typeof row.owner === 'object' && row.owner) {
    owner =
      pickString(row.owner as Record<string, unknown>, [
        'login',
        'name',
        'path',
        'username',
        'display_name'
      ]) || owner
  }
  if (owner && name && host) {
    return `https://${host}/${owner}/${name}.git`
  }
  return ''
}

const toItems = (
  rows: Array<Record<string, unknown>>,
  providerId: string,
  baseUrl?: string
): ExtAppRepoItem[] => {
  const providerName = providerNameOf(providerId)
  const items: ExtAppRepoItem[] = []
  for (const row of rows) {
    const url = normalizeRepoUrl(row, providerId, baseUrl)
    if (!url) continue
    const name =
      pickString(row, ['name', 'repo', 'repository', 'repoName']) ||
      url.split('/').pop()?.replace(/\.git$/i, '') ||
      url
    const fullName =
      pickString(row, [
        'full_name',
        'fullName',
        'path_with_namespace',
        'pathWithNamespace',
        'name_with_namespace'
      ]) || name
    const defaultBranch =
      pickString(row, ['default_branch', 'defaultBranch', 'main_branch']) || undefined
    items.push({
      url,
      name,
      fullName,
      providerId,
      providerName,
      defaultBranch
    })
  }
  return items
}

const fetchJson = async (
  url: string,
  init?: RequestInit
): Promise<{ status: number; json: unknown }> => {
  const res = await fetch(url, init)
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

const listForProvider = async (
  id: CodeRepoProviderId,
  token: string,
  baseUrl?: string
): Promise<{ repos: ExtAppRepoItem[]; error?: string }> => {
  const base = trimBase(baseUrl)
  try {
    switch (id) {
      case 'github': {
        const { status, json } = await fetchJson(
          'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
          {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`
            }
          }
        )
        if (status < 200 || status >= 300) {
          return { repos: [], error: `GitHub API ${status}` }
        }
        return { repos: toItems(asRepoList(json), id) }
      }
      case 'gitlab': {
        const apiBase = `${base || 'https://gitlab.com'}/api/v4`
        const { status, json } = await fetchJson(
          `${apiBase}/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at`,
          { headers: { 'PRIVATE-TOKEN': token } }
        )
        if (status < 200 || status >= 300) {
          return { repos: [], error: `GitLab API ${status}` }
        }
        return { repos: toItems(asRepoList(json), id, base || 'https://gitlab.com') }
      }
      case 'gitee': {
        const { status, json } = await fetchJson(
          `https://gitee.com/api/v5/user/repos?type=all&sort=updated&per_page=100&access_token=${encodeURIComponent(token)}`
        )
        if (status < 200 || status >= 300) {
          return { repos: [], error: `Gitee API ${status}` }
        }
        return { repos: toItems(asRepoList(json), id) }
      }
      case 'bitbucket': {
        const { status, json } = await fetchJson(
          'https://api.bitbucket.org/2.0/repositories?role=member&pagelen=50',
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (status < 200 || status >= 300) {
          return { repos: [], error: `Bitbucket API ${status}` }
        }
        return { repos: toItems(asRepoList(json), id) }
      }
      case 'gitea': {
        if (!base) return { repos: [], error: 'Gitea: 缺少实例地址' }
        const { status, json } = await fetchJson(`${base}/api/v1/user/repos?limit=100`, {
          headers: { Authorization: `token ${token}` }
        })
        if (status < 200 || status >= 300) {
          return { repos: [], error: `Gitea API ${status}` }
        }
        return { repos: toItems(asRepoList(json), id, base) }
      }
      case 'gitcode': {
        let result = await fetchJson(
          `https://api.gitcode.com/api/v5/user/repos?type=all&sort=updated&per_page=100&access_token=${encodeURIComponent(token)}`
        )
        if (result.status < 200 || result.status >= 300) {
          result = await fetchJson(
            'https://gitcode.com/api/v5/user/repos?type=all&sort=updated&per_page=100',
            { headers: { Authorization: `Bearer ${token}` } }
          )
        }
        if (result.status < 200 || result.status >= 300) {
          return { repos: [], error: `GitCode API ${result.status}` }
        }
        return { repos: toItems(asRepoList(result.json), id) }
      }
      case 'azure': {
        if (!base) return { repos: [], error: 'Azure DevOps: 缺少组织地址' }
        const basic = Buffer.from(`:${token}`).toString('base64')
        const { status, json } = await fetchJson(
          `${base}/_apis/git/repositories?api-version=7.1`,
          { headers: { Authorization: `Basic ${basic}` } }
        )
        if (status < 200 || status >= 300) {
          return { repos: [], error: `Azure DevOps API ${status}` }
        }
        const rows = asRepoList(json).map((row) => {
          const remote = pickString(row, ['remoteUrl', 'webUrl'])
          return remote ? { ...row, clone_url: remote } : row
        })
        return { repos: toItems(rows, id, base) }
      }
      case 'coding': {
        const apiBase = base || 'https://coding.net'
        // 尽力拉取；CODING 开放接口因企业域差异较大，失败时给出提示
        const { status, json } = await fetchJson(
          `${apiBase}/api/user/projects?page=1&pageSize=100`,
          { headers: { Authorization: `token ${token}` } }
        )
        if (status < 200 || status >= 300) {
          return {
            repos: [],
            error: 'CODING 暂无法自动列出仓库，请改用「添加流水线源」手动填写地址'
          }
        }
        return { repos: toItems(asRepoList(json), id, apiBase) }
      }
      case 'other': {
        if (!base) return { repos: [], error: '其他 Git: 缺少实例地址' }
        const gitea = await fetchJson(`${base}/api/v1/user/repos?limit=100`, {
          headers: { Authorization: `token ${token}` }
        })
        if (gitea.status >= 200 && gitea.status < 300) {
          return { repos: toItems(asRepoList(gitea.json), id, base) }
        }
        const gitlab = await fetchJson(
          `${base}/api/v4/projects?membership=true&simple=true&per_page=100`,
          { headers: { 'PRIVATE-TOKEN': token } }
        )
        if (gitlab.status >= 200 && gitlab.status < 300) {
          return { repos: toItems(asRepoList(gitlab.json), id, base) }
        }
        return {
          repos: [],
          error: '该实例暂无法自动列出仓库，请手动填写仓库地址'
        }
      }
      default:
        return { repos: [], error: `暂不支持从 ${providerNameOf(id)} 自动列出仓库` }
    }
  } catch (error) {
    return {
      repos: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export const listExternalAppSources = (): ExtAppRepoSource[] => {
  return connectedProviders().map(({ id, conn }) => ({
    providerId: id,
    providerName: providerNameOf(id),
    connected: true,
    accountLabel: conn.accountLabel
  }))
}

/** 连接指纹：Token/实例变更后旧缓存自动失效 */
const buildRepoCacheFingerprint = (): string => {
  const parts = connectedProviders()
    .map(({ id, conn, token }) => {
      const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16)
      return `${id}|${trimBase(conn.baseUrl)}|${tokenHash}`
    })
    .sort()
  if (!parts.length) return ''
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

const isExtAppRepoItem = (raw: unknown): raw is ExtAppRepoItem => {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Record<string, unknown>
  return (
    typeof row.url === 'string' &&
    typeof row.name === 'string' &&
    typeof row.providerId === 'string' &&
    typeof row.providerName === 'string'
  )
}

const fetchReposFromProviders = async (
  providerId?: string
): Promise<{
  repos: ExtAppRepoItem[]
  errors: string[]
  sources: ExtAppRepoSource[]
}> => {
  const connected = connectedProviders()
  const sources = listExternalAppSources()
  const targets = providerId
    ? connected.filter((c) => c.id === providerId)
    : connected

  if (!targets.length) {
    return {
      repos: [],
      errors: sources.length
        ? []
        : ['尚未连接任何代码仓库，请先到「设置 → 代码仓库」完成连接'],
      sources
    }
  }

  const repos: ExtAppRepoItem[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  await Promise.all(
    targets.map(async ({ id, conn, token }) => {
      const result = await listForProvider(id, token, conn.baseUrl)
      if (result.error) errors.push(`${providerNameOf(id)}: ${result.error}`)
      for (const repo of result.repos) {
        const key = `${repo.providerId}||${repo.url}`
        if (seen.has(key)) continue
        seen.add(key)
        repos.push(repo)
      }
    })
  )

  repos.sort((a, b) =>
    (a.fullName || a.name).localeCompare(b.fullName || b.name, 'zh-CN')
  )
  return { repos, errors, sources }
}

export const listReposFromExternalApps = async (options?: {
  providerId?: string
  /** 跳过 SQLite，强制打平台 API 并写回缓存 */
  forceRefresh?: boolean
}): Promise<{
  repos: ExtAppRepoItem[]
  errors: string[]
  sources: ExtAppRepoSource[]
  fromCache?: boolean
  stale?: boolean
}> => {
  const sources = listExternalAppSources()
  const fingerprint = buildRepoCacheFingerprint()
  const force = Boolean(options?.forceRefresh)

  if (!fingerprint) {
    clearExtAppRepoCache()
    return {
      repos: [],
      errors: ['尚未连接任何代码仓库，请先到「设置 → 代码仓库」完成连接'],
      sources,
      fromCache: false,
      stale: false
    }
  }

  if (!force) {
    const cached = getExtAppRepoCache()
    if (cached && cached.fingerprint === fingerprint) {
      const repos = cached.repos.filter(isExtAppRepoItem)
      const filtered = options?.providerId
        ? repos.filter((r) => r.providerId === options.providerId)
        : repos
      const stale = Date.now() - cached.fetchedAt > REPO_CACHE_TTL_MS
      return {
        repos: filtered,
        errors: cached.errors,
        sources,
        fromCache: true,
        stale
      }
    }
  }

  const live = await fetchReposFromProviders(options?.providerId)
  // 仅在拉全量时写缓存，避免按平台筛选结果覆盖全量列表
  if (!options?.providerId) {
    setExtAppRepoCache({
      fingerprint,
      repos: live.repos,
      errors: live.errors
    })
  }
  return {
    ...live,
    sources,
    fromCache: false,
    stale: false
  }
}

export const invalidateExtAppRepoCache = (): void => {
  clearExtAppRepoCache()
}

const parseOwnerRepo = (
  repoUrl: string
): { owner: string; repo: string } | null => {
  try {
    const cleaned = repoUrl.trim().replace(/\.git$/i, '')
    const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`
    const u = new URL(withProto)
    const parts = u.pathname.replace(/^\//, '').split('/').filter(Boolean)
    if (parts.length < 2) return null
    const gitIdx = parts.indexOf('_git')
    if (gitIdx >= 0 && parts[gitIdx + 1]) {
      return {
        owner: decodeURIComponent(parts[0]),
        repo: decodeURIComponent(parts[gitIdx + 1])
      }
    }
    return {
      owner: decodeURIComponent(parts[0]),
      repo: decodeURIComponent(parts[parts.length - 1])
    }
  } catch {
    return null
  }
}

export const listBranchesFromExternalApp = async (input: {
  providerId: string
  repoUrl: string
}): Promise<{ branches: string[]; error?: string }> => {
  const hit = connectedProviders().find((c) => c.id === input.providerId)
  if (!hit) {
    return { branches: [], error: '该平台未连接或令牌不可用' }
  }

  const parsed = parseOwnerRepo(input.repoUrl)
  if (!parsed) {
    return { branches: [], error: `无法解析仓库地址: ${input.repoUrl}` }
  }

  const { token, conn, id } = hit
  const base = trimBase(conn.baseUrl)

  try {
    switch (id) {
      case 'github': {
        const { status, json } = await fetchJson(
          `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches?per_page=100`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`
            }
          }
        )
        if (status < 200 || status >= 300) {
          return { branches: [], error: `GitHub API ${status}` }
        }
        return { branches: asBranchNames(json) }
      }
      case 'gitlab': {
        const apiBase = `${base || 'https://gitlab.com'}/api/v4`
        const project = encodeURIComponent(`${parsed.owner}/${parsed.repo}`)
        const { status, json } = await fetchJson(
          `${apiBase}/projects/${project}/repository/branches?per_page=100`,
          { headers: { 'PRIVATE-TOKEN': token } }
        )
        if (status < 200 || status >= 300) {
          return { branches: [], error: `GitLab API ${status}` }
        }
        return { branches: asBranchNames(json) }
      }
      case 'gitee': {
        const { status, json } = await fetchJson(
          `https://gitee.com/api/v5/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches?per_page=100&access_token=${encodeURIComponent(token)}`
        )
        if (status < 200 || status >= 300) {
          return { branches: [], error: `Gitee API ${status}` }
        }
        return { branches: asBranchNames(json) }
      }
      case 'bitbucket': {
        const { status, json } = await fetchJson(
          `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/refs/branches?pagelen=100`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (status < 200 || status >= 300) {
          return { branches: [], error: `Bitbucket API ${status}` }
        }
        return { branches: asBranchNames(json) }
      }
      case 'gitea':
      case 'other': {
        if (!base) return { branches: [], error: '缺少实例地址' }
        const gitea = await fetchJson(
          `${base}/api/v1/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches`,
          { headers: { Authorization: `token ${token}` } }
        )
        if (gitea.status >= 200 && gitea.status < 300) {
          return { branches: asBranchNames(gitea.json) }
        }
        if (id === 'other') {
          const project = encodeURIComponent(`${parsed.owner}/${parsed.repo}`)
          const gitlab = await fetchJson(
            `${base}/api/v4/projects/${project}/repository/branches?per_page=100`,
            { headers: { 'PRIVATE-TOKEN': token } }
          )
          if (gitlab.status >= 200 && gitlab.status < 300) {
            return { branches: asBranchNames(gitlab.json) }
          }
        }
        return { branches: [], error: `分支接口 ${gitea.status}` }
      }
      case 'gitcode': {
        let result = await fetchJson(
          `https://api.gitcode.com/api/v5/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches?per_page=100&access_token=${encodeURIComponent(token)}`
        )
        if (result.status < 200 || result.status >= 300) {
          result = await fetchJson(
            `https://gitcode.com/api/v5/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches?per_page=100`,
            { headers: { Authorization: `Bearer ${token}` } }
          )
        }
        if (result.status < 200 || result.status >= 300) {
          return { branches: [], error: `GitCode API ${result.status}` }
        }
        return { branches: asBranchNames(result.json) }
      }
      case 'azure': {
        if (!base) return { branches: [], error: '缺少组织地址' }
        const basic = Buffer.from(`:${token}`).toString('base64')
        // 用仓库名查 refs
        const { status, json } = await fetchJson(
          `${base}/_apis/git/repositories/${encodeURIComponent(parsed.repo)}/refs?filter=heads/&api-version=7.1`,
          { headers: { Authorization: `Basic ${basic}` } }
        )
        if (status < 200 || status >= 300) {
          return { branches: [], error: `Azure DevOps API ${status}` }
        }
        const names = asBranchNames(json).map((n) => n.replace(/^refs\/heads\//, ''))
        return { branches: Array.from(new Set(names)) }
      }
      default:
        return { branches: [], error: '该平台暂不支持自动拉取分支，请手动填写' }
    }
  } catch (error) {
    return {
      branches: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export const hasConnectedExternalApps = (): boolean => connectedProviders().length > 0
