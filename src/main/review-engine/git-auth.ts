import { chmodSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAppConfig } from '../config/store'
import { isSecretMasked } from '../config/secrets'
import type { CodeRepoProviderId } from '../../shared/code-repo-providers'
import type { ExternalAppConnection } from '../../shared/types'

export type GitAuth = { username: string; password: string; providerId: CodeRepoProviderId }

export type VerifyExternalAppResult =
  | { ok: true; accountLabel: string }
  | { ok: false; message: string }

const KNOWN_HOSTS: Array<{ id: CodeRepoProviderId; hosts: string[] }> = [
  { id: 'github', hosts: ['github.com', 'www.github.com'] },
  { id: 'gitee', hosts: ['gitee.com', 'www.gitee.com'] },
  { id: 'gitlab', hosts: ['gitlab.com', 'www.gitlab.com'] },
  { id: 'bitbucket', hosts: ['bitbucket.org', 'www.bitbucket.org'] },
  {
    id: 'coding',
    hosts: ['coding.net', 'e.coding.net', 'coding.tencent.com']
  },
  { id: 'gitcode', hosts: ['gitcode.com', 'gitcode.net', 'www.gitcode.com'] },
  {
    id: 'azure',
    hosts: ['dev.azure.com', 'visualstudio.com', 'ssh.dev.azure.com']
  }
]

const normalizeHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^www\./, '')

const hostnameOf = (raw?: string): string => {
  if (!raw?.trim()) return ''
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    return normalizeHost(new URL(withProto).hostname)
  } catch {
    return normalizeHost(raw.replace(/^https?:\/\//i, '').split('/')[0] || '')
  }
}

const providerConn = (
  id: CodeRepoProviderId
): ExternalAppConnection | undefined => {
  const config = getAppConfig()
  const conn = config.externalApps?.providers?.[id]
  if (conn?.connected && conn.accessToken?.trim()) return conn
  if (id === 'github' && config.githubToken?.trim()) {
    return {
      connected: true,
      accessToken: config.githubToken,
      accountLabel: conn?.accountLabel || 'GitHub Token'
    }
  }
  return conn?.connected ? conn : undefined
}

/** 根据仓库 URL 匹配已连接的代码仓库平台（含自建实例 baseUrl） */
export const matchProviderForRepo = (
  repoUrl: string
): CodeRepoProviderId | null => {
  const host = hostnameOf(repoUrl)
  if (!host) return null

  for (const row of KNOWN_HOSTS) {
    if (row.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return row.id
    }
  }

  // 自建：用已保存的 baseUrl 主机名匹配
  const config = getAppConfig()
  const providers = config.externalApps?.providers ?? {}
  for (const id of ['gitlab', 'gitea', 'azure', 'other', 'coding'] as CodeRepoProviderId[]) {
    const baseHost = hostnameOf(providers[id]?.baseUrl)
    if (baseHost && (host === baseHost || host.endsWith(`.${baseHost}`))) {
      return id
    }
  }

  // 未识别主机：若仅连接了一个「其他/自建」类，则用之
  const fallbacks: CodeRepoProviderId[] = ['other', 'gitea', 'gitlab']
  const connected = fallbacks.filter((id) => providerConn(id)?.accessToken?.trim())
  if (connected.length === 1) return connected[0]

  return null
}

const gitUsernameFor = (providerId: CodeRepoProviderId): string => {
  switch (providerId) {
    case 'github':
      return 'x-access-token'
    case 'bitbucket':
      return 'x-token-auth'
    case 'azure':
      return 'pat'
    case 'gitee':
    case 'gitlab':
    case 'gitea':
    case 'coding':
    case 'gitcode':
    case 'other':
    default:
      return 'oauth2'
  }
}

/** 解析 clone / fetch 用的 Git HTTPS 凭据：代码仓库授权优先，其次 MCP */
export const resolveGitAuth = (
  repoUrl: string,
  mcpServerId?: string
): GitAuth | null => {
  const providerId = matchProviderForRepo(repoUrl)
  if (providerId) {
    const conn = providerConn(providerId)
    const token = conn?.accessToken?.trim()
    if (token) {
      return {
        username: gitUsernameFor(providerId),
        password: token,
        providerId
      }
    }
  }

  // 兼容：任意已连接平台 Token（主机未匹配时仍尝试 githubToken）
  const gh = providerConn('github')?.accessToken?.trim()
  if (gh && /github\.com/i.test(repoUrl)) {
    return { username: 'x-access-token', password: gh, providerId: 'github' }
  }

  const fromMcp = tokenFromMcpServer(mcpServerId, providerId || undefined)
  if (fromMcp) return fromMcp

  return null
}

const tokenFromMcpServer = (
  mcpServerId?: string,
  hint?: CodeRepoProviderId | string
): GitAuth | null => {
  if (!mcpServerId) return null
  const server = getAppConfig().mcpServers.find((s) => s.id === mcpServerId)
  if (!server) return null
  const env = server.env ?? {}

  const pick = (
    providerId: CodeRepoProviderId,
    keys: string[]
  ): GitAuth | null => {
    for (const k of keys) {
      const token = env[k]?.trim()
      if (token) {
        return {
          username: gitUsernameFor(providerId),
          password: token,
          providerId
        }
      }
    }
    return null
  }

  if (hint === 'gitee' || /gitee|码云/.test(JSON.stringify(env).toLowerCase())) {
    const hit = pick('gitee', ['GITEE_ACCESS_TOKEN', 'GITEE_PERSONAL_ACCESS_TOKEN'])
    if (hit) return hit
  }
  if (hint === 'github' || env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN) {
    const hit = pick('github', [
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'GITHUB_TOKEN',
      'GH_TOKEN'
    ])
    if (hit) return hit
  }
  if (hint === 'gitlab' || env.GITLAB_PERSONAL_ACCESS_TOKEN || env.GITLAB_TOKEN) {
    const hit = pick('gitlab', [
      'GITLAB_PERSONAL_ACCESS_TOKEN',
      'GITLAB_TOKEN'
    ])
    if (hit) return hit
  }

  return (
    pick('gitee', ['GITEE_ACCESS_TOKEN', 'GITEE_PERSONAL_ACCESS_TOKEN']) ||
    pick('github', ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) ||
    pick('gitlab', ['GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_TOKEN'])
  )
}

export const hasGitAuthForRepo = (repoUrl: string, mcpServerId?: string): boolean =>
  Boolean(resolveGitAuth(repoUrl, mcpServerId))

/** 不含凭据的规范化仓库 URL（写入 .git/config 只用这个） */
export const cleanRepoUrl = (repoUrl: string): string => {
  try {
    const normalized = repoUrl.endsWith('.git')
      ? repoUrl
      : `${repoUrl.replace(/\/$/, '')}.git`
    const u = new URL(normalized)
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return repoUrl
  }
}

/**
 * 通过 GIT_ASKPASS 注入凭据，避免 token 写入 remote URL / .git/config。
 */
export const beginGitAuthEnv = (
  auth: Pick<GitAuth, 'username' | 'password'> | null
): { env: NodeJS.ProcessEnv; cleanup: () => void } => {
  const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (!auth) {
    return { env: baseEnv, cleanup: () => undefined }
  }

  const scriptPath = join(
    tmpdir(),
    `crc-git-askpass-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
  )
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      "const p = process.argv[2] || ''",
      "if (/username/i.test(p)) process.stdout.write(process.env.CRC_GIT_USERNAME || '')",
      'else process.stdout.write(process.env.CRC_GIT_PASSWORD || "")'
    ].join('\n'),
    'utf-8'
  )
  try {
    chmodSync(scriptPath, 0o700)
  } catch {
    /* Windows 可忽略 */
  }

  return {
    env: {
      ...baseEnv,
      GIT_ASKPASS: scriptPath,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      CRC_GIT_USERNAME: auth.username,
      CRC_GIT_PASSWORD: auth.password
    },
    cleanup: () => {
      try {
        unlinkSync(scriptPath)
      } catch {
        /* ignore */
      }
    }
  }
}

const trimBase = (baseUrl?: string): string =>
  (baseUrl || '').trim().replace(/\/$/, '')

const fetchJson = async (
  url: string,
  init?: RequestInit
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> => {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Code-Reviewer-Desktop',
      ...(init?.headers || {})
    }
  })
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

const labelFrom = (
  json: Record<string, unknown> | null,
  fallback: string
): string => {
  if (!json) return fallback
  const login =
    (typeof json.login === 'string' && json.login) ||
    (typeof json.username === 'string' && json.username) ||
    (typeof json.name === 'string' && json.name) ||
    (typeof json.nickname === 'string' && json.nickname) ||
    (typeof json.emailAddress === 'string' && json.emailAddress) ||
    ''
  return login || fallback
}

const failAuth = (status: number, platform: string): VerifyExternalAppResult => {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      message: `未能通过 ${platform} 校验，请确认访问令牌有效且具备仓库读权限`
    }
  }
  if (status === 404) {
    return {
      ok: false,
      message: `未能访问 ${platform} 接口，请确认实例地址是否正确`
    }
  }
  return {
    ok: false,
    message: `暂时无法完成 ${platform} 校验，请稍后重试`
  }
}

/** 连接前真实请求平台 API 校验 Token */
export const verifyExternalAppAuth = async (payload: {
  providerId: CodeRepoProviderId
  accessToken?: string
  baseUrl?: string
}): Promise<VerifyExternalAppResult> => {
  const { providerId } = payload
  let token = (payload.accessToken || '').trim()
  if (!token || isSecretMasked(token)) {
    token = providerConn(providerId)?.accessToken?.trim() || ''
  }
  if (!token) {
    return { ok: false, message: '请先填写访问令牌后再连接' }
  }

  const baseUrl =
    trimBase(payload.baseUrl) || trimBase(providerConn(providerId)?.baseUrl)

  try {
    switch (providerId) {
      case 'github': {
        const { status, json } = await fetchJson('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (status < 200 || status >= 300) return failAuth(status, 'GitHub')
        return { ok: true, accountLabel: labelFrom(json, 'GitHub') }
      }
      case 'gitlab': {
        if (!baseUrl) {
          return { ok: false, message: '请填写 GitLab 实例地址后再连接' }
        }
        const { status, json } = await fetchJson(`${baseUrl}/api/v4/user`, {
          headers: { 'PRIVATE-TOKEN': token }
        })
        if (status < 200 || status >= 300) return failAuth(status, 'GitLab')
        return { ok: true, accountLabel: labelFrom(json, 'GitLab') }
      }
      case 'gitee': {
        const { status, json } = await fetchJson(
          `https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`
        )
        if (status < 200 || status >= 300) return failAuth(status, 'Gitee')
        return { ok: true, accountLabel: labelFrom(json, 'Gitee') }
      }
      case 'bitbucket': {
        const { status, json } = await fetchJson(
          'https://api.bitbucket.org/2.0/user',
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (status < 200 || status >= 300) return failAuth(status, 'Bitbucket')
        return { ok: true, accountLabel: labelFrom(json, 'Bitbucket') }
      }
      case 'azure': {
        if (!baseUrl) {
          return { ok: false, message: '请填写 Azure DevOps 组织地址后再连接' }
        }
        const basic = Buffer.from(`:${token}`).toString('base64')
        // 优先 Profile API；部分组织也可用 connectionData
        let result = await fetchJson(
          `${baseUrl}/_apis/profile/profiles/me?api-version=7.1`,
          { headers: { Authorization: `Basic ${basic}` } }
        )
        if (result.status < 200 || result.status >= 300) {
          result = await fetchJson(
            `${baseUrl}/_apis/connectionData?api-version=7.1`,
            { headers: { Authorization: `Basic ${basic}` } }
          )
        }
        if (result.status < 200 || result.status >= 300) {
          return failAuth(result.status, 'Azure DevOps')
        }
        const authUser = result.json?.authenticatedUser as
          | Record<string, unknown>
          | undefined
        const label =
          labelFrom(result.json, '') ||
          (typeof authUser?.providerDisplayName === 'string'
            ? authUser.providerDisplayName
            : '') ||
          'Azure DevOps'
        return { ok: true, accountLabel: label }
      }
      case 'gitea': {
        if (!baseUrl) {
          return { ok: false, message: '请填写 Gitea 实例地址后再连接' }
        }
        const { status, json } = await fetchJson(`${baseUrl}/api/v1/user`, {
          headers: { Authorization: `token ${token}` }
        })
        if (status < 200 || status >= 300) return failAuth(status, 'Gitea')
        return { ok: true, accountLabel: labelFrom(json, 'Gitea') }
      }
      case 'coding': {
        // CODING 开放 API：当前用户
        const apiBase = baseUrl || 'https://coding.net'
        const { status, json } = await fetchJson(
          `${apiBase}/api/account/current_user`,
          { headers: { Authorization: `token ${token}` } }
        )
        if (status < 200 || status >= 300) {
          // 兼容 access_token 查询参数
          const alt = await fetchJson(
            `${apiBase}/api/account/current_user?access_token=${encodeURIComponent(token)}`
          )
          if (alt.status < 200 || alt.status >= 300) {
            return failAuth(alt.status, 'CODING')
          }
          const data = (alt.json?.data as Record<string, unknown>) || alt.json
          return {
            ok: true,
            accountLabel: labelFrom(data, 'CODING')
          }
        }
        const data = (json?.data as Record<string, unknown>) || json
        return { ok: true, accountLabel: labelFrom(data, 'CODING') }
      }
      case 'gitcode': {
        const { status, json } = await fetchJson(
          `https://api.gitcode.com/api/v5/user?access_token=${encodeURIComponent(token)}`
        )
        if (status < 200 || status >= 300) {
          const alt = await fetchJson('https://gitcode.com/api/v5/user', {
            headers: { Authorization: `Bearer ${token}` }
          })
          if (alt.status < 200 || alt.status >= 300) {
            return failAuth(alt.status, 'GitCode')
          }
          return { ok: true, accountLabel: labelFrom(alt.json, 'GitCode') }
        }
        return { ok: true, accountLabel: labelFrom(json, 'GitCode') }
      }
      case 'other': {
        if (!baseUrl) {
          return { ok: false, message: '请填写仓库实例地址后再连接' }
        }
        // 依次尝试 Gitea / GitLab 风格
        const gitea = await fetchJson(`${baseUrl}/api/v1/user`, {
          headers: { Authorization: `token ${token}` }
        })
        if (gitea.status >= 200 && gitea.status < 300) {
          return { ok: true, accountLabel: labelFrom(gitea.json, 'Git') }
        }
        const gitlab = await fetchJson(`${baseUrl}/api/v4/user`, {
          headers: { 'PRIVATE-TOKEN': token }
        })
        if (gitlab.status >= 200 && gitlab.status < 300) {
          return { ok: true, accountLabel: labelFrom(gitlab.json, 'Git') }
        }
        return {
          ok: false,
          message: '未能校验该实例，请确认地址支持常见 Git API，并检查访问令牌'
        }
      }
      default:
        return { ok: false, message: '暂不支持该平台，请选择其他代码托管服务' }
    }
  } catch {
    return {
      ok: false,
      message: '网络暂时不可用，请检查网络后重试'
    }
  }
}
