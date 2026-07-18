import type { PostPrCommentsPayload, PostPrCommentsResult, ReviewReport } from '../../shared/types'
import { mcpRegistry } from '../mcp-manager/registry'
import { getAppConfig } from '../config/store'
import { DEFAULT_PR_COMMENT_TOOLS, parseGithubRepo } from './code-fetcher'

const parseOwnerRepo = (
  repoUrl: string,
  owner?: string,
  repo?: string
): { owner: string; repo: string } => {
  if (owner && repo) return { owner, repo }
  const parsed = parseGithubRepo(repoUrl)
  if (!parsed) {
    throw new Error('无法从仓库 URL 解析 owner/repo，请手动指定')
  }
  return parsed
}

const resolveCommentTools = async (
  serverId: string | null,
  preferred?: string
): Promise<string[]> => {
  const ordered = preferred?.trim()
    ? [preferred.trim(), ...DEFAULT_PR_COMMENT_TOOLS.filter((t) => t !== preferred.trim())]
    : [...DEFAULT_PR_COMMENT_TOOLS]

  try {
    const client = serverId
      ? mcpRegistry.getClient(serverId)
      : mcpRegistry.getFirstConnectedClient()
    if (!client) return ordered
    const listed = await client.listTools()
    const names = (listed.tools ?? []).map((t) => t.name)
    const available = ordered.filter((name) => names.includes(name))
    const fuzzy = names.filter((name) =>
      /review_comment|pull_request_review_comment|create_comment/i.test(name)
    )
    return Array.from(new Set([...available, ...fuzzy, ...ordered]))
  } catch {
    return ordered
  }
}

export const postSelectedIssuesAsPrComments = async (
  report: ReviewReport,
  payload: PostPrCommentsPayload
): Promise<PostPrCommentsResult> => {
  if (!report.prNumber) {
    throw new Error('当前报告没有 PR 编号，无法回写行级评论')
  }
  if (!mcpRegistry.hasConnectedClient()) {
    throw new Error('请先在 Settings 连接 MCP Server，再回写评论')
  }

  const config = getAppConfig()
  const server = config.mcpServers.find((item) => item.enabled)
  const { owner, repo } = parseOwnerRepo(report.repoUrl, payload.owner, payload.repo)
  const selected = report.issues.filter((issue) => payload.issueIds.includes(issue.id))

  if (!selected.length) {
    return { posted: 0, failed: 0, details: ['未选择任何问题'] }
  }

  const toolCandidates = await resolveCommentTools(
    server?.id ?? null,
    config.prCommentToolName
  )

  let posted = 0
  let failed = 0
  const details: string[] = []

  for (const issue of selected) {
    let success = false
    let lastError = ''

    for (const toolName of toolCandidates) {
      const argVariants: Record<string, unknown>[] = [
        {
          owner,
          repo,
          pull_number: Number(report.prNumber),
          body: `**[${issue.severity}]** ${issue.message}\n\n_rule: \`${issue.ruleId}\` · source: ${issue.source}_`,
          path: issue.filePath,
          line: issue.line,
          side: 'RIGHT'
        },
        {
          owner,
          repo,
          pullNumber: Number(report.prNumber),
          body: `**[${issue.severity}]** ${issue.message}`,
          path: issue.filePath,
          line: issue.line
        },
        {
          owner,
          repo,
          issue_number: Number(report.prNumber),
          body: `**[${issue.severity}] ${issue.filePath}:${issue.line}** ${issue.message}`
        }
      ]

      for (const args of argVariants) {
        try {
          await mcpRegistry.callTool(server?.id ?? null, toolName, args)
          success = true
          posted += 1
          details.push(`✓ ${issue.filePath}:${issue.line} via ${toolName}`)
          break
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
        }
      }
      if (success) break
    }

    if (!success) {
      failed += 1
      details.push(`✗ ${issue.filePath}:${issue.line} — ${lastError}`)
    }
  }

  return { posted, failed, details }
}
