import type { ReviewFileResult } from '../../shared/types'
import { languageFromPath } from '../../shared/language'
import { mcpRegistry } from '../mcp-manager/registry'

export const extractTextContent = (toolResult: unknown): string => {
  if (!toolResult || typeof toolResult !== 'object') return ''
  const content = (toolResult as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return JSON.stringify(toolResult, null, 2)
  return content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n')
}

export const parseGithubRepo = (
  repoUrl: string
): { owner: string; repo: string } | null => {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i)
  if (!match) return null
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') }
}

export { languageFromPath }

/** 将 unified patch 还原为修改前/后文本 */
export const splitPatchToSides = (
  patch?: string
): { original: string; modified: string } => {
  if (!patch?.trim()) return { original: '', modified: '' }
  const original: string[] = []
  const modified: string[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) continue
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('-')) {
      original.push(line.slice(1))
      continue
    }
    if (line.startsWith('+')) {
      modified.push(line.slice(1))
      continue
    }
    if (line.startsWith('\\')) continue
    const body = line.startsWith(' ') ? line.slice(1) : line
    original.push(body)
    modified.push(body)
  }
  return {
    original: original.join('\n'),
    modified: modified.join('\n')
  }
}

interface PrFileEntry {
  filename?: string
  status?: string
  patch?: string
  previous_filename?: string
}

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        return null
      }
    }
    const oStart = text.indexOf('{')
    const oEnd = text.lastIndexOf('}')
    if (oStart >= 0 && oEnd > oStart) {
      try {
        return JSON.parse(text.slice(oStart, oEnd + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export const prFilesToReviewFiles = (text: string): ReviewFileResult[] => {
  const parsed = tryParseJson(text)
  const list: PrFileEntry[] = Array.isArray(parsed)
    ? (parsed as PrFileEntry[])
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)
      ? ((parsed as { files: PrFileEntry[] }).files)
      : []

  if (!list.length) return []

  return list
    .filter((item) => item.filename)
    .slice(0, 40)
    .map((item) => {
      const sides = splitPatchToSides(item.patch)
      const content =
        sides.modified ||
        (item.status === 'removed' ? '' : sides.original) ||
        item.patch ||
        ''
      const originalContent =
        sides.original || (item.status === 'added' ? '' : sides.modified) || ''
      return {
        filePath: item.filename!,
        originalContent,
        content: content || `// ${item.status || 'changed'}: ${item.filename}`,
        language: languageFromPath(item.filename!),
        issues: []
      }
    })
}

/** 仅供联调/文档演示脚本显式调用；生产拉码失败不得回退到此数据 */
export const demoFilesForRepo = (repoUrl: string): ReviewFileResult[] => {
  const originalTs = `// demo file for ${repoUrl}
export const hello = () => {
  return "hello"
}
`

  const modifiedTs = `// demo file for ${repoUrl}
const token = "sk-demo-hardcoded-token-123456"
var legacy = 1

export const hello = () => {
  console.log("hello")
  debugger
  try {
    eval("1+1")
  } catch (e) {}
  return legacy as any
}
`

  return [
    {
      filePath: 'src/demo/sample.ts',
      originalContent: originalTs,
      content: modifiedTs,
      language: 'typescript',
      issues: []
    },
    {
      filePath: 'README.md',
      originalContent: `# README\n\nProject docs\n`,
      content: `# README\n\nTODO: replace with real MCP fetched content\nVisit http://example.com for details\n`,
      language: 'markdown',
      issues: []
    }
  ]
}

const listConnectedToolNames = async (serverId: string | null): Promise<string[]> => {
  try {
    const client = serverId
      ? mcpRegistry.getClient(serverId)
      : mcpRegistry.getFirstConnectedClient()
    if (!client) return []
    const tools = await client.listTools()
    return (tools.tools ?? []).map((t) => t.name)
  } catch {
    return []
  }
}

const pickTool = (available: string[], candidates: string[]): string | null => {
  for (const name of candidates) {
    if (available.includes(name)) return name
  }
  // 模糊匹配
  for (const name of candidates) {
    const hit = available.find((item) => item.toLowerCase().includes(name.toLowerCase()))
    if (hit) return hit
  }
  return candidates[0] ?? null
}

export const fetchReviewFiles = async (input: {
  repoUrl: string
  prNumber?: string
  serverId: string | null
  enableGitClone?: boolean
  branch?: string
  workDir?: string
}): Promise<{
  files: ReviewFileResult[]
  usedDemo: boolean
  reason?: string
  commitSha?: string
  workDir?: string
  ephemeral?: boolean
  source?: 'mcp' | 'git'
}> => {
  const errors: string[] = []
  const allowGit = input.enableGitClone !== false
  // 配置了工作目录时优先走 Git 克隆，确保代码落到指定本地目录
  const preferGitWorkDir = Boolean(input.workDir?.trim()) && allowGit

  if (!preferGitWorkDir && mcpRegistry.hasConnectedClient()) {
    const parsed = parseGithubRepo(input.repoUrl)
    const available = await listConnectedToolNames(input.serverId)

    const attempts: Array<{
      tools: string[]
      args: Record<string, unknown>
      map: (text: string) => ReviewFileResult[] | null
    }> = []

    if (parsed && input.prNumber) {
      attempts.push({
        tools: [
          'get_pull_request_files',
          'list_pull_request_files',
          'pull_request_files',
          'get_pr_files'
        ],
        args: {
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: Number(input.prNumber),
          pullNumber: Number(input.prNumber)
        },
        map: (text) => {
          const files = prFilesToReviewFiles(text)
          return files.length ? files : null
        }
      })
    }

    if (parsed) {
      attempts.push({
        tools: ['get_file_contents', 'get_file_content', 'git_get_file'],
        args: {
          owner: parsed.owner,
          repo: parsed.repo,
          path: 'README.md'
        },
        map: (text) => [
          {
            filePath: 'README.md',
            originalContent: '',
            content: text,
            language: 'markdown',
            issues: []
          }
        ]
      })
    }

    attempts.push({
      tools: ['git_diff', 'get_diff', 'diff'],
      args: { repo: input.repoUrl, pr: input.prNumber, pull_number: input.prNumber },
      map: (text) => [
        {
          filePath: input.prNumber ? `pr-${input.prNumber}.diff` : 'fetched.diff',
          originalContent: '',
          content: text,
          language: 'plaintext',
          issues: []
        }
      ]
    })

    for (const attempt of attempts) {
      const toolName = pickTool(available.length ? available : attempt.tools, attempt.tools)
      if (!toolName) continue
      try {
        const result = await mcpRegistry.callTool(input.serverId, toolName, attempt.args)
        const text = extractTextContent(result)
        if (!text.trim()) {
          errors.push(`${toolName}: 空响应`)
          continue
        }
        const mapped = attempt.map(text)
        if (mapped?.length) {
          return { files: mapped, usedDemo: false, source: 'mcp' }
        }
        errors.push(`${toolName}: 无法解析响应`)
      } catch (error) {
        errors.push(`${toolName}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } else {
    errors.push('未连接 MCP')
  }

  if (allowGit && input.repoUrl?.trim()) {
    try {
      const { fetchViaGitClone } = await import('./git-fetcher')
      const cloned = await fetchViaGitClone(input.repoUrl.trim(), {
        mcpServerId: input.serverId ?? undefined,
        branch: input.branch,
        workDir: input.workDir
      })
      return {
        files: cloned.files,
        usedDemo: false,
        source: 'git',
        commitSha: cloned.commitSha,
        workDir: cloned.workDir,
        ephemeral: cloned.ephemeral,
        reason: errors.length
          ? `MCP 不可用，已通过 Git 克隆拉取（${errors[0]}）`
          : input.workDir?.trim()
            ? `已克隆到工作目录 ${cloned.workDir}`
            : '已通过 Git 克隆拉取'
      }
    } catch (error) {
      errors.push(`Git: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const detail = errors.filter(Boolean).slice(0, 3).join('；') || '未知原因'
  throw new Error(
    `拉码失败，已终止审查（不再使用演示数据）。${detail}`
  )
}

export const DEFAULT_PR_COMMENT_TOOLS = [
  'create_pull_request_review_comment',
  'create_review_comment',
  'add_issue_comment',
  'create_pending_pull_request_review'
]
