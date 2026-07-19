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
  deleteTrailingAssistantMessages,
  getChatSessionById,
  getReviewReportById,
  listChatSessions,
  updateChatSessionMeta
} from '../database/db'
import { splitThinkingContent } from '../../shared/chat-thinking'
import { runChatCompletion } from './llm-chat'

const buildSystemPrompt = (report: ReviewReport | null): string => {
  const base = [
    '你是 Reviewer 桌面端的代码审查助手，可称呼自己为「小智」。',
    '用简洁中文回答，聚焦代码质量、安全、可维护性与修复建议。',
    '如果用户问题与当前审查报告相关，请结合报告中的问题与文件内容作答。',
    '不确定时说明假设，不要编造不存在的文件或行号。',
    '回答前先在 <think>...</think> 中写出简要思考过程（分析步骤与结论依据），标签外只输出最终回复。'
  ]

  if (!report) {
    return base.join('\n')
  }

  const errors = (report.issues ?? []).filter((issue) => issue.severity === 'error')
  const issueLines = errors
    .slice(0, 30)
    .map(
      (issue, index) =>
        `${index + 1}. [error] ${issue.filePath}:${issue.line} — ${issue.message}`
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
    `- 错误数：${errors.length}`,
    '',
    '问题摘要：',
    issueLines || '（暂无错误）',
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

const isAbortError = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || /aborted|取消|暂停/i.test(error.message)
}

/** 当前进行中的对话生成（带 token，避免取消误伤下一轮） */
let activeGeneration: { controller: AbortController; token: string } | null = null

export class GenerationCancelledError extends Error {
  constructor() {
    super('已停止生成')
    this.name = 'GenerationCancelledError'
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

  /** 暂停当前正在进行的模型生成 */
  cancelGeneration: (): void => {
    activeGeneration?.controller.abort()
  },

  sendMessage: async (payload: SendChatPayload): Promise<ChatSession> => {
    const content = payload.content?.trim()
    if (!content) {
      throw new Error('消息不能为空')
    }

    let session = payload.sessionId ? getChatSessionById(payload.sessionId) : null

    if (payload.regenerate) {
      if (!session) throw new Error('重新生成需要有效会话')
      deleteTrailingAssistantMessages(session.id)
      session = getChatSessionById(session.id)!
      const lastUser = [...session.messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) throw new Error('没有可重新生成的用户消息')
    } else if (!session) {
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

    if (!payload.regenerate) {
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

    // 新请求覆盖前先中止旧轮，防止 controller 泄漏
    activeGeneration?.controller.abort()
    const abort = new AbortController()
    const generationToken = randomUUID()
    activeGeneration = { controller: abort, token: generationToken }
    try {
      const result = await runChatCompletion(config, system, history, abort.signal)
      const split = splitThinkingContent(result.content)
      // 仅保留模型真实返回的思考内容，不伪造占位文案
      const thinking = result.thinking?.trim() || split.thinking || undefined
      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'assistant',
        content: split.content || result.content,
        ...(thinking ? { thinking } : {}),
        createdAt: new Date().toISOString()
      }
      appendChatMessage(assistantMessage)
    } catch (error) {
      if (isAbortError(error, abort.signal)) {
        throw new GenerationCancelledError()
      }
      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'assistant',
        content: `对话失败：${error instanceof Error ? error.message : String(error)}`,
        createdAt: new Date().toISOString()
      }
      appendChatMessage(assistantMessage)
    } finally {
      if (activeGeneration?.token === generationToken) {
        activeGeneration = null
      }
    }

    return getChatSessionById(session.id)!
  }
}
