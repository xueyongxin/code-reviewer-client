import { useEffect, useMemo, useRef, useState } from 'react'
import { Dropdown, Modal, Select, message } from 'antd'
import {
  AppstoreOutlined,
  ArrowUpOutlined,
  CommentOutlined,
  CopyOutlined,
  DeleteOutlined,
  DislikeOutlined,
  EllipsisOutlined,
  LikeOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { useAppStore } from '../store/useAppStore'
import MarkdownMessage from '../components/MarkdownMessage'
import type { ChatMessage, ChatSession } from '../../../shared/types'
import {
  LOCAL_COMMAND_KEYS,
  filterCommands,
  formatSlashMessage,
  matchCommand,
  mergeChatCommands,
  parseSlashInput,
  type ChatCommandDef
} from '../../../shared/chat-commands'

const shortRepo = (url: string): string => {
  try {
    const cleaned = url.replace(/\.git$/, '')
    const parts = cleaned.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || url
  } catch {
    return url
  }
}

const formatChatTime = (iso?: string): string => {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    if (sameDay) return hm
    if (isYesterday) return `昨天 ${hm}`
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

const estimateDurationLabel = (messages: ChatMessage[]): string | null => {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant) return null
  const prevUser = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.createdAt <= lastAssistant.createdAt)
  if (!prevUser) return null
  const ms =
    new Date(lastAssistant.createdAt).getTime() - new Date(prevUser.createdAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const sec = Math.max(1, Math.round(ms / 1000))
  return `任务耗时 ${sec}s`
}

const ChatPage = (): JSX.Element => {
  const currentReport = useAppStore((s) => s.currentReport)
  const history = useAppStore((s) => s.history)
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const chatSelectSeq = useAppStore((s) => s.chatSelectSeq)
  const setActiveChatId = useAppStore((s) => s.setActiveChatId)
  const refreshChatSessions = useAppStore((s) => s.refreshChatSessions)

  const [active, setActive] = useState<ChatSession | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [reportId, setReportId] = useState<string | undefined>(currentReport?.id)
  const [commands, setCommands] = useState<ChatCommandDef[]>([])
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [feedback, setFeedback] = useState<Record<string, 'up' | 'down'>>({})
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const loadSeqRef = useRef(0)

  const reportOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of history) {
      map.set(item.id, `${shortRepo(item.repoUrl)} · ${item.issues.length} 问题`)
    }
    if (currentReport?.id) {
      map.set(
        currentReport.id,
        `${shortRepo(currentReport.repoUrl)} · ${currentReport.issues.length} 问题`
      )
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
  }, [history, currentReport])

  const activeProvider = useMemo(() => {
    const providers = config?.llmProviders ?? []
    return (
      providers.find((p) => p.id === config?.activeLlmProviderId) ||
      providers.find((p) => p.enabled) ||
      null
    )
  }, [config])

  const modelLabel = activeProvider
    ? activeProvider.displayName || activeProvider.model || activeProvider.name
    : '未配置模型'

  const slashQuery = useMemo(() => {
    if (!draft.startsWith('/')) return null
    if (draft.includes('\n')) return null
    const space = draft.indexOf(' ')
    if (space >= 0) return null
    return draft.slice(1)
  }, [draft])

  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return []
    return filterCommands(commands, slashQuery)
  }, [commands, slashQuery])

  useEffect(() => {
    setCmdOpen(slashQuery !== null && filteredCommands.length > 0)
    setCmdIndex(0)
  }, [slashQuery, filteredCommands.length])

  useEffect(() => {
    void (async () => {
      await refreshChatSessions()
      try {
        const list = await window.electronAPI.cloudChatCommands()
        setCommands(mergeChatCommands(list))
      } catch {
        setCommands(mergeChatCommands([]))
      }
    })().catch((e) => console.error('[chat] init failed', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换左侧会话：立刻清空旧内容，并用序号丢弃过期的异步结果
  useEffect(() => {
    const seq = ++loadSeqRef.current
    if (!activeChatId || !window.electronAPI?.getChatSession) {
      setActive(null)
      return
    }
    setActive((prev) => (prev?.id === activeChatId ? prev : null))
    void (async () => {
      try {
        const full = await window.electronAPI.getChatSession(activeChatId)
        if (seq !== loadSeqRef.current) return
        setActive(full)
        if (full?.reportId) setReportId(full.reportId)
      } catch (e) {
        if (seq !== loadSeqRef.current) return
        console.error('[chat] loadSession failed', e)
        setActive(null)
      }
    })()
  }, [activeChatId, chatSelectSeq])

  useEffect(() => {
    if (!listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [active?.messages.length, sending])

  const appendLocalAssistant = (content: string): void => {
    const now = new Date().toISOString()
    const msg: ChatMessage = {
      id: `local-${Date.now()}`,
      sessionId: activeChatId || 'local',
      role: 'assistant',
      content,
      createdAt: now
    }
    setActive((prev) => {
      if (!prev) {
        return {
          id: 'local',
          title: '本地命令',
          createdAt: now,
          updatedAt: now,
          messages: [msg]
        }
      }
      return {
        ...prev,
        updatedAt: now,
        messages: [...prev.messages, msg]
      }
    })
  }

  const handleNewChat = async (): Promise<void> => {
    try {
      const session = await window.electronAPI.createChatSession(reportId)
      setActive(session)
      await refreshChatSessions(session.id)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '新建失败')
    }
  }

  const handleDelete = (): void => {
    if (!activeChatId) return
    const id = activeChatId
    Modal.confirm({
      centered: true,
      title: '删除对话',
      content: '删除后无法恢复，确定删除该会话及其消息？',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.electronAPI.deleteChatSession(id)
          await refreshChatSessions()
          setActive(null)
          message.success('已删除对话')
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败')
          throw e
        }
      }
    })
  }

  const runLocalCommand = async (
    cmd: ChatCommandDef,
    args: string
  ): Promise<boolean> => {
    if (cmd.key === 'clear') {
      await handleNewChat()
      message.success('已开启新对话（上下文已清空）')
      return true
    }
    if (cmd.key === 'help') {
      const lines = commands.map(
        (c) => `${c.slash.padEnd(10)} ${c.name} — ${c.description || '无说明'}`
      )
      appendLocalAssistant(`可用命令（来自配置中心）：\n\n${lines.join('\n')}`)
      return true
    }
    if (cmd.key === 'model') {
      const providers = (config?.llmProviders ?? []).filter((p) => p.enabled)
      if (!providers.length) {
        message.warning('暂无已启用模型，请先在设置 → 模型中配置')
        return true
      }
      const want = args.trim().toLowerCase()
      if (want) {
        const hit = providers.find(
          (p) =>
            p.model.toLowerCase().includes(want) ||
            p.name.toLowerCase().includes(want) ||
            (p.displayName || '').toLowerCase().includes(want)
        )
        if (!hit || !config) {
          message.warning(`未找到模型：${args}`)
          return true
        }
        await saveConfig({ ...config, activeLlmProviderId: hit.id })
        message.success(`已切换模型：${hit.displayName || hit.model}`)
        return true
      }
      const list = providers
        .map(
          (p) =>
            `${p.id === config?.activeLlmProviderId ? '•' : ' '} ${p.displayName || p.model}（${p.name}）`
        )
        .join('\n')
      appendLocalAssistant(
        `当前模型：${modelLabel}\n\n可用模型（/model 名称 可切换）：\n${list}`
      )
      return true
    }
    if (cmd.key === 'report') {
      if (args.trim()) {
        const hit = reportOptions.find(
          (o) =>
            o.value === args.trim() ||
            o.label.toLowerCase().includes(args.trim().toLowerCase())
        )
        if (!hit) {
          message.warning(`未找到审查报告：${args}`)
          return true
        }
        setReportId(hit.value)
        message.success(`已关联报告：${hit.label}`)
        return true
      }
      const list =
        reportOptions.length === 0
          ? '（暂无审查报告）'
          : reportOptions
              .map(
                (o) =>
                  `${o.value === reportId ? '•' : ' '} ${o.label}`
              )
              .join('\n')
      appendLocalAssistant(
        `当前关联：${reportId || '未关联'}\n\n可选报告（/report 关键字 可切换）：\n${list}`
      )
      return true
    }
    return false
  }

  const sendContent = async (content: string): Promise<void> => {
    const boundSessionId = activeChatId
    setSending(true)
    setDraft('')
    setCmdOpen(false)
    try {
      const session = await window.electronAPI.sendChatMessage({
        sessionId: boundSessionId ?? undefined,
        content,
        reportId
      })
      await refreshChatSessions(session.id)
      // 发送中途若已切换会话，不把回复刷到错误会话
      const currentId = useAppStore.getState().activeChatId
      const stillOnBound =
        boundSessionId == null
          ? currentId == null || currentId === session.id
          : currentId === boundSessionId
      if (stillOnBound) {
        setActiveChatId(session.id)
        setActive(session)
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const regenerateLast = async (): Promise<void> => {
    if (sending || !active?.messages?.length) return
    const lastUser = [...active.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser?.content) {
      message.info('没有可重新生成的用户消息')
      return
    }
    await sendContent(lastUser.content)
  }

  const attachFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return
    const parts: string[] = []
    for (const file of Array.from(files).slice(0, 5)) {
      if (file.size > 200 * 1024) {
        message.warning(`${file.name} 超过 200KB，已跳过`)
        continue
      }
      const text = await file.text()
      parts.push(`【附件 ${file.name}】\n\`\`\`\n${text.slice(0, 12000)}\n\`\`\``)
    }
    if (!parts.length) return
    setDraft((prev) => (prev ? `${prev}\n\n${parts.join('\n\n')}` : parts.join('\n\n')))
    message.success(`已附加 ${parts.length} 个文件到输入框`)
  }

  const applyCommand = async (cmd: ChatCommandDef, args = ''): Promise<void> => {
    setCmdOpen(false)
    if (LOCAL_COMMAND_KEYS.has(cmd.key)) {
      setDraft('')
      await runLocalCommand(cmd, args)
      return
    }
    // 展示与入库保持短 slash；主进程再展开为 LLM 提示词
    await sendContent(formatSlashMessage(cmd, args))
  }

  const handleSend = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || sending) return

    const parsed = parseSlashInput(content)
    if (parsed) {
      const cmd = matchCommand(commands, parsed.slash)
      if (cmd) {
        await applyCommand(cmd, parsed.args)
        return
      }
      message.warning(`未知命令 ${parsed.slash}，输入 /help 查看可用命令`)
      return
    }

    await sendContent(content)
  }

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }

  const hasMessages = Boolean(active?.messages.length) || sending
  const durationLabel = active ? estimateDurationLabel(active.messages) : null
  const headerTitle = active?.title?.trim() || '新对话'

  return (
    <div className="chat-page">
      <header className="chat-page-header">
        <div className="chat-page-header-left">
          <CommentOutlined className="chat-page-header-icon" />
          <span className="chat-page-header-title" title={headerTitle}>
            {headerTitle}
          </span>
          {active?.updatedAt ? (
            <span className="chat-page-header-time">
              {formatChatTime(active.updatedAt)}
            </span>
          ) : null}
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'new',
                  icon: <PlusOutlined />,
                  label: '新建对话',
                  onClick: () => void handleNewChat()
                },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: '删除对话',
                  danger: true,
                  disabled: !activeChatId,
                  onClick: () => void handleDelete()
                }
              ]
            }}
          >
            <button type="button" className="chat-icon-btn" title="更多">
              <EllipsisOutlined />
            </button>
          </Dropdown>
        </div>
      </header>

      <div className="chat-page-body" ref={listRef}>
        {!hasMessages ? (
          <div className="chat-welcome">
            <div className="chat-welcome-mark">R</div>
            <div className="chat-welcome-title">Work with Reviewer</div>
            <p className="chat-welcome-desc">
              输入 / 唤起命令（如 /review /help）。帮你审查代码、解读报告、给出修复建议。
            </p>
          </div>
        ) : (
          <div className="chat-messages">
            {(active?.messages ?? []).map((msg, idx) => {
              if (msg.role === 'user') {
                return (
                  <div key={msg.id} className="chat-row user">
                    <div className="chat-user-bubble">{msg.content}</div>
                  </div>
                )
              }
              if (msg.role !== 'assistant') return null
              const isLastAssistant =
                idx ===
                (active?.messages ?? []).reduce(
                  (last, m, i) => (m.role === 'assistant' ? i : last),
                  -1
                )
              return (
                <div key={msg.id} className="chat-row assistant">
                  <div className="chat-assistant-card">
                    <div className="chat-assistant-head">
                      <span className="chat-assistant-avatar">R</span>
                      <span className="chat-assistant-name">Reviewer</span>
                      {isLastAssistant && durationLabel ? (
                        <span className="chat-assistant-meta">{durationLabel}</span>
                      ) : null}
                    </div>
                    <MarkdownMessage
                      className="chat-assistant-content chat-md"
                      content={msg.content}
                    />
                    <div className="chat-assistant-actions">
                      <button
                        type="button"
                        className="chat-action-btn"
                        title="复制"
                        onClick={() => void copyText(msg.content)}
                      >
                        <CopyOutlined />
                      </button>
                      <button
                        type="button"
                        className={`chat-action-btn ${feedback[msg.id] === 'up' ? 'is-on' : ''}`}
                        title="有用"
                        onClick={() => {
                          setFeedback((f) => ({ ...f, [msg.id]: 'up' }))
                          message.success('已记录反馈')
                        }}
                      >
                        <LikeOutlined />
                      </button>
                      <button
                        type="button"
                        className={`chat-action-btn ${feedback[msg.id] === 'down' ? 'is-on' : ''}`}
                        title="无用"
                        onClick={() => {
                          setFeedback((f) => ({ ...f, [msg.id]: 'down' }))
                          message.success('已记录反馈')
                        }}
                      >
                        <DislikeOutlined />
                      </button>
                      <button
                        type="button"
                        className="chat-action-btn"
                        title="重新生成"
                        disabled={sending || !isLastAssistant}
                        onClick={() => void regenerateLast()}
                      >
                        <ReloadOutlined />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
            {sending ? (
              <div className="chat-row assistant">
                <div className="chat-assistant-card">
                  <div className="chat-assistant-head">
                    <span className="chat-assistant-avatar">R</span>
                    <span className="chat-assistant-name">Reviewer</span>
                  </div>
                  <div className="chat-assistant-content chat-typing">正在思考…</div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="chat-composer-wrap">
        {cmdOpen ? (
          <div className="chat-cmd-menu" role="listbox">
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.key}
                type="button"
                className={`chat-cmd-item ${i === cmdIndex ? 'active' : ''}`}
                onMouseEnter={() => setCmdIndex(i)}
                onClick={() => void applyCommand(cmd)}
              >
                <span className="chat-cmd-slash">{cmd.slash}</span>
                <span className="chat-cmd-name">{cmd.name}</span>
                <span className="chat-cmd-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="chat-composer">
          <textarea
            ref={inputRef}
            className="chat-composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="输入 / 选择命令，或直接提问审查问题…"
            rows={2}
            onKeyDown={(e) => {
              if (cmdOpen && filteredCommands.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCmdIndex((v) => (v + 1) % filteredCommands.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCmdIndex(
                    (v) => (v - 1 + filteredCommands.length) % filteredCommands.length
                  )
                  return
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && slashQuery !== null)) {
                  e.preventDefault()
                  const hit = filteredCommands[cmdIndex]
                  if (hit) void applyCommand(hit)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setCmdOpen(false)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
          />
          <div className="chat-composer-bar">
            <div className="chat-composer-left">
              <button
                type="button"
                className="chat-icon-btn"
                title="命令"
                onClick={() => {
                  setDraft('/')
                  setCmdOpen(true)
                  inputRef.current?.focus()
                }}
              >
                <AppstoreOutlined />
              </button>
              <button
                type="button"
                className="chat-icon-btn"
                title="附加文本文件"
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperClipOutlined />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.json,.yml,.yaml,.ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.css,.html"
                style={{ display: 'none' }}
                onChange={(e) => {
                  void attachFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <Select
                allowClear
                size="small"
                variant="borderless"
                placeholder="关联审查"
                className="chat-report-select"
                value={reportId}
                options={reportOptions}
                onChange={(value) => setReportId(value)}
                popupMatchSelectWidth={280}
              />
            </div>
            <div className="chat-composer-right">
              <span className="chat-model-chip" title={activeProvider?.name}>
                {modelLabel}
              </span>
              <button type="button" className="chat-icon-btn" title="快速模式">
                <ThunderboltOutlined />
              </button>
              <button
                type="button"
                className={`chat-send ${draft.trim() && !sending ? 'ready' : ''}`}
                disabled={!draft.trim() || sending}
                title="发送"
                onClick={() => void handleSend()}
              >
                <ArrowUpOutlined />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ChatPage
