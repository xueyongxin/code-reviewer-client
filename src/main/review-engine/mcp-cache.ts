interface McpRepoItem {
  url: string
  name: string
  fullName?: string
  provider: string
  serverId: string
  serverName: string
  defaultBranch?: string
}

interface McpRepoSource {
  serverId: string
  serverName: string
  provider: string
  connected: boolean
}

interface RepoCacheEntry {
  repos: McpRepoItem[]
  fetchedAt: number
}

interface BranchCacheEntry {
  branches: string[]
  fetchedAt: number
}

const REPO_TTL_MS = 10 * 60 * 1000
const BRANCH_TTL_MS = 10 * 60 * 1000

const repoCache = new Map<string, RepoCacheEntry>()
const branchCache = new Map<string, BranchCacheEntry>()
const sourcesCache: { sources: McpRepoSource[]; fetchedAt: number } = {
  sources: [],
  fetchedAt: 0
}

const branchKey = (serverId: string, repoUrl: string): string =>
  `${serverId}::${repoUrl.trim().toLowerCase()}`

export const getCachedSources = (): McpRepoSource[] | null => {
  if (!sourcesCache.fetchedAt) return null
  if (Date.now() - sourcesCache.fetchedAt > REPO_TTL_MS) return null
  return sourcesCache.sources
}

export const setCachedSources = (sources: McpRepoSource[]): void => {
  sourcesCache.sources = sources
  sourcesCache.fetchedAt = Date.now()
}

export const getCachedRepos = (
  serverId: string,
  allowStale = false
): McpRepoItem[] | null => {
  const hit = repoCache.get(serverId)
  if (!hit) return null
  if (!allowStale && Date.now() - hit.fetchedAt > REPO_TTL_MS) return null
  return hit.repos
}

export const setCachedRepos = (serverId: string, repos: McpRepoItem[]): void => {
  repoCache.set(serverId, { repos, fetchedAt: Date.now() })
}

export const getAllCachedRepos = (allowStale = true): McpRepoItem[] => {
  const out: McpRepoItem[] = []
  for (const [serverId, entry] of Array.from(repoCache.entries())) {
    if (!allowStale && Date.now() - entry.fetchedAt > REPO_TTL_MS) continue
    out.push(...entry.repos.map((r: McpRepoItem) => ({ ...r, serverId: r.serverId || serverId })))
  }
  return out
}

export const getCachedBranches = (
  serverId: string,
  repoUrl: string,
  allowStale = false
): string[] | null => {
  const hit = branchCache.get(branchKey(serverId, repoUrl))
  if (!hit) return null
  if (!allowStale && Date.now() - hit.fetchedAt > BRANCH_TTL_MS) return null
  return hit.branches
}

export const setCachedBranches = (
  serverId: string,
  repoUrl: string,
  branches: string[]
): void => {
  branchCache.set(branchKey(serverId, repoUrl), {
    branches,
    fetchedAt: Date.now()
  })
}

export const clearMcpRepoCache = (serverId?: string): void => {
  if (!serverId) {
    repoCache.clear()
    branchCache.clear()
    sourcesCache.sources = []
    sourcesCache.fetchedAt = 0
    return
  }
  repoCache.delete(serverId)
  for (const key of Array.from(branchCache.keys())) {
    if (key.startsWith(`${serverId}::`)) branchCache.delete(key)
  }
}

export const cacheAgeLabel = (serverId: string): string => {
  const hit = repoCache.get(serverId)
  if (!hit) return ''
  const sec = Math.max(1, Math.round((Date.now() - hit.fetchedAt) / 1000))
  if (sec < 60) return `${sec}s 前缓存`
  return `${Math.round(sec / 60)} 分钟前缓存`
}
