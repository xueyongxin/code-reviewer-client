import { randomUUID } from 'crypto'
import type { ChatMessage, ChatSession, ReviewReport, SendChatPayload } from '../../shared/types'
import {
  expandSlashForLlm,
  mergeChatCommands,
  titleFromChatContent
} from '../../shared/chat-commands'
import { cloudFetchChatCommands } from '../cloud/client'
import { getAppConfig } from '../config/store'
import {
  appendChatMessage,
  createChatSession,
  deleteChatSession,
  getChatSessionById,
  getReviewReportById,
  listChatSessions,
  updateChatSessionMeta
} from '../database/db'
import { runChatCompletion } from './llm-chat'

const buildSystemPrompt = (report: ReviewReport | null): string => {
  const base = [
    '你是 Reviewer 桌面端的代码审查助手。',
    '用简洁中文回答，聚焦代码质量、安全、可维护性与修复建议。',
    '如果用户问题与当前审查报告相关，请结合报告中的问题与文件内容作答。',
    '不确定时说明假设，不要编造不存在的文件或行号。'
  ]

  if (!report) {
    return base.join('\n')
  }

  const issueLines = (report.issues ?? [])
    .slice(0, 30)
    .map(
      (issue, index) =>
        `${index + 1}. [${issue.severity}] ${issue.filePath}:${issue.line} — ${issue.message}`
    )
    .join('\n')

  const fileLines = (report.files ?? [])
    .slice(0, 8)
    .map((file) => {
      const body = file.content.split('\n').slice(0, 80).join('\n')
      return `### ${file.filePath}\n\`\`\`\n${body}\n\`\`\``
    })
    .join('\n\n')

  return [
    ...base,
    '',
    `当前关联审查报告：`,
    `- 仓库：${report.repoUrl}`,
    `- 状态：${report.status}`,
    `- Commit：${report.commitSha || '未知'}`,
    `- 问题数：${report.issues?.length ?? 0}`,
    '',
    '问题摘要：',
    issueLines || '（暂无问题）',
    '',
    '相关文件片段：',
    fileLines || '（无文件内容）'
  ].join('\n')
}

const loadCommandsForExpand = async () => {
  try {
    const remote = await cloudFetchChatCommands()
    return mergeChatCommands(remote)
  } catch {
    return mergeChatCommands([])
  }
}

export const chatService = {
  listSessions: (): ChatSession[] => listChatSessions(50),

  getSession: (sessionId: string): ChatSession | null => getChatSessionById(sessionId),

  createSession: (reportId?: string): ChatSession => {
    return createChatSession({
      id: randomUUID(),
      title: '新对话',
      reportId
    })
  },

  deleteSession: (sessionId: string): void => {
    deleteChatSession(sessionId)
  },

  sendMessage: async (payload: SendChatPayload): Promise<ChatSession> => {
    const content = payload.content?.trim()
    if (!content) {
      throw new Error('消息不能为空')
    }

    let session = payload.sessionId ? getChatSessionById(payload.sessionId) : null
    if (!session) {
      session = createChatSession({
        id: randomUUID(),
        title: titleFromChatContent(content),
        reportId: payload.reportId
      })
    } else if (payload.reportId && payload.reportId !== session.reportId) {
      updateChatSessionMeta(session.id, { reportId: payload.reportId })
      session = getChatSessionById(session.id)!
    }

    const reportIdForExpand = payload.reportId || session.reportId
    const commands = await loadCommandsForExpand()
    const expanded = expandSlashForLlm(content, commands, { reportId: reportIdForExpand })

    const userMessage: ChatMessage = {
      id: randomUUID(),
      sessionId: session.id,
      role: 'user',
      content: expanded.display,
      createdAt: new Date().toISOString()
    }
    appendChatMessage(userMessage)

    if (session.messages.length === 0 && session.title === '新对话') {
      updateChatSessionMeta(session.id, { title: titleFromChatContent(expanded.display) })
    }

    const refreshed = getChatSessionById(session.id)!
    const report = refreshed.reportId
      ? getReviewReportById(refreshed.reportId)
      : payload.reportId
        ? getReviewReportById(payload.reportId)
        : null

    const config = getAppConfig()
    const system = buildSystemPrompt(report)
    // 展示用短 slash；发给模型时把历史里所有 slash 用户消息重新展开
    const history = refreshed.messages.map((m) => {
      if (m.role !== 'user') return { role: m.role, content: m.content }
      const again = expandSlashForLlm(m.content, commands, {
        reportId: refreshed.reportId || reportIdForExpand
      })
      return { role: m.role, content: again.llm }
    })

    try {
      const result = await runChatCompletion(config, system, history)
      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'assistant',
        content: result.content,
        createdAt: new Date().toISOString()
      }
      appendChatMessage(assistantMessage)
    } catch (error) {
      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'assistant',
        content: `对话失败：${error instanceof Error ? error.message : String(error)}`,
        createdAt: new Date().toISOString()
      }
      appendChatMessage(assistantMessage)
    }

    return getChatSessionById(session.id)!
  }
}
