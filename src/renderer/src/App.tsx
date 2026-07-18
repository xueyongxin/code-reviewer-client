import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Modal, message } from 'antd'
import {
  CommentOutlined,
  DeleteOutlined,
  DownOutlined,
  FileSearchOutlined,
  FilterOutlined,
  PlusCircleOutlined
} from '@ant-design/icons'
import ChatPage from './pages/ChatPage'
import ConfigPage, { type SettingsSection } from './pages/ConfigPage'
import { useAppearance } from './prefs/AppearanceProvider'
import Dashboard from './pages/Dashboard'
import ReportPage from './pages/ReportPage'
import UserAccountMenu from './components/UserAccountMenu'
import { useAppStore } from './store/useAppStore'
import type { ReviewReport } from '../../shared/types'
import { formatDuration } from './components/FlowTimeline'

const SIDER_WIDTH_KEY = 'cr.siderWidth'
const SIDER_COLLAPSED_KEY = 'cr.siderCollapsed.v2'
const SIDER_DEFAULT = 260
/** 向左收窄：最小约占窗口 10% */
const SIDER_MIN_RATIO = 0.1
/** 向右拉宽：最大约占窗口 40% */
const SIDER_MAX_RATIO = 0.4

const clampSiderWidth = (width: number, viewport = window.innerWidth): number => {
  const min = Math.max(200, Math.round(viewport * SIDER_MIN_RATIO))
  const max = Math.max(min, Math.round(viewport * SIDER_MAX_RATIO))
  return Math.min(max, Math.max(min, Math.round(width)))
}

const readStoredSiderWidth = (): number => {
  try {
    const raw = localStorage.getItem(SIDER_WIDTH_KEY)
    const n = raw ? Number(raw) : SIDER_DEFAULT
    if (Number.isFinite(n) && n > 0) return clampSiderWidth(n)
  } catch {
    // ignore
  }
  return clampSiderWidth(SIDER_DEFAULT)
}

const readStoredSiderCollapsed = (): boolean => {
  try {
    // 清理旧版错误折叠状态
    localStorage.removeItem('cr.siderCollapsed')
    return localStorage.getItem(SIDER_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** 侧栏折叠图标（与 Cursor / 系统侧栏切换同款） */
const SiderToggleIcon = (): JSX.Element => (
  <svg
    className="sider-toggle-svg"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    aria-hidden="true"
  >
    <rect
      x="1.5"
      y="1.5"
      width="13"
      height="13"
      rx="2.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M5.5 2v12" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
)

const TABS = [
  {
    key: 'review',
    path: '/review',
    labelKey: 'nav.newReview' as const,
    icon: <PlusCircleOutlined />
  },
  {
    key: 'inbox',
    path: '/report',
    labelKey: 'nav.records' as const,
    icon: <FileSearchOutlined />
  },
  { key: 'chat', path: '/', labelKey: 'nav.chat' as const, icon: <CommentOutlined /> }
] as const

const shortRepo = (url: string): string => {
  try {
    const cleaned = url.replace(/\.git$/, '')
    const parts = cleaned.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || url
  } catch {
    return url
  }
}

const formatTime = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

const userInitials = (name?: string): string => {
  const n = (name || '').trim()
  if (!n) return '?'
  return n.slice(0, 1).toUpperCase()
}

const Shell = (): JSX.Element => {
  const navigate = useNavigate()
  const location = useLocation()
  const bootstrap = useAppStore((s) => s.bootstrap)
  const subscribeProgress = useAppStore((s) => s.subscribeProgress)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const config = useAppStore((s) => s.config)
  const currentReport = useAppStore((s) => s.currentReport)
  const history = useAppStore((s) => s.history)
  const chatSessions = useAppStore((s) => s.chatSessions)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const selectChatSession = useAppStore((s) => s.selectChatSession)
  const refreshChatSessions = useAppStore((s) => s.refreshChatSessions)
  const [listOpen, setListOpen] = useState(true)
  const [siderWidth, setSiderWidth] = useState(readStoredSiderWidth)
  const [siderCollapsed, setSiderCollapsed] = useState(readStoredSiderCollapsed)
  const [siderDragging, setSiderDragging] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)

  const cloudUser =
    config?.cloud?.accessToken && config.cloud.user ? config.cloud.user : undefined
  const [loginBusy, setLoginBusy] = useState(false)
  const { t } = useAppearance()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('cloud')
  const openSettings = useCallback((section: SettingsSection = 'cloud') => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  useEffect(() => {
    void bootstrap().catch((e) => {
      console.error('[app] bootstrap failed', e)
    })
    try {
      return subscribeProgress()
    } catch (e) {
      console.error('[app] subscribeProgress failed', e)
      return undefined
    }
  }, [bootstrap, subscribeProgress])

  useEffect(() => {
    const onResize = (): void => {
      setSiderWidth((w) => clampSiderWidth(w))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SIDER_WIDTH_KEY, String(siderWidth))
    } catch {
      // ignore
    }
  }, [siderWidth])

  useEffect(() => {
    try {
      localStorage.setItem(SIDER_COLLAPSED_KEY, siderCollapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [siderCollapsed])

  const toggleSider = useCallback(() => {
    setSiderCollapsed((v) => !v)
  }, [])

  const onSiderResizeStart = useCallback((e: ReactMouseEvent) => {
    if (siderCollapsed) return
    e.preventDefault()
    const shellLeft = shellRef.current?.getBoundingClientRect().left ?? 0
    setSiderDragging(true)

    const onMove = (ev: MouseEvent): void => {
      setSiderWidth(clampSiderWidth(ev.clientX - shellLeft))
    }
    const onUp = (): void => {
      setSiderDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [siderCollapsed])

  useEffect(() => {
    if (!window.electronAPI?.onCloudAuthComplete) return undefined
    return window.electronAPI.onCloudAuthComplete((payload) => {
      void (async () => {
        if (payload.ok && payload.config) {
          await saveConfig(payload.config)
          message.success('登录成功')
          navigate('/')
        } else if (payload.error) {
          message.error(payload.error)
        }
      })()
    })
  }, [navigate, saveConfig])

  const activeTab = useMemo(() => {
    if (location.pathname.startsWith('/report')) return 'inbox'
    if (location.pathname.startsWith('/review')) return 'review'
    return 'chat'
  }, [location.pathname])

  const fillStage = true
  const railItems: ReviewReport[] = useMemo(() => {
    const list = history.length ? history : currentReport ? [currentReport] : []
    return list.slice(0, 20)
  }, [history, currentReport])

  useEffect(() => {
    if (activeTab !== 'chat') return
    void refreshChatSessions().catch(() => undefined)
  }, [activeTab, refreshChatSessions])

  /** 进入「对话」或点击新建：优先复用空的新会话，否则创建 */
  const openFreshChat = useCallback((): void => {
    void (async () => {
      try {
        await refreshChatSessions()
        const activeId = useAppStore.getState().activeChatId
        if (activeId && window.electronAPI?.getChatSession) {
          const current = await window.electronAPI.getChatSession(activeId)
          if (
            current &&
            current.messages.length === 0 &&
            (current.title === '新对话' || !current.title?.trim())
          ) {
            selectChatSession(current.id)
            navigate('/')
            return
          }
        }
        const session = await window.electronAPI.createChatSession(
          useAppStore.getState().currentReport?.id
        )
        selectChatSession(session.id)
        await refreshChatSessions(session.id)
        navigate('/')
      } catch (e) {
        message.error(e instanceof Error ? e.message : '新建对话失败')
      }
    })()
  }, [navigate, refreshChatSessions, selectChatSession])

  const handleDeleteChat = (sessionId: string, e: ReactMouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    Modal.confirm({
      centered: true,
      title: '删除对话',
      content: '删除后无法恢复，确定删除该会话及其消息？',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.electronAPI.deleteChatSession(sessionId)
          await refreshChatSessions()
          const nextId = useAppStore.getState().activeChatId
          selectChatSession(nextId)
          message.success('已删除对话')
        } catch (err) {
          message.error(err instanceof Error ? err.message : '删除失败')
          throw err
        }
      }
    })
  }

  return (
    <div className={`ln-app ${siderCollapsed ? 'sider-collapsed' : ''}`}>
      <header className="app-titlebar">
        <div className="app-titlebar-traffic-space" aria-hidden />
        <button
          type="button"
          className="sider-toggle"
                  title={siderCollapsed ? t('nav.expandSider') : t('nav.collapseSider')}
                  aria-label={
                    siderCollapsed ? t('nav.expandSider') : t('nav.collapseSider')
                  }
                  onClick={toggleSider}
        >
          <SiderToggleIcon />
        </button>
        <div className="app-titlebar-drag">
          <span className="app-titlebar-name">Code Reviewer</span>
        </div>
      </header>

      {currentReport?.status === 'running' && (
        <div className="ln-progress">
          <div
            className="ln-progress-bar"
            style={{ width: `${Math.max(4, currentReport.progress)}%` }}
          />
          <div className="ln-progress-label">{currentReport.progressLabel}</div>
        </div>
      )}

      <div className={`ln-main ${fillStage ? 'ln-main-fill' : ''}`}>
        <div
          ref={shellRef}
          className={`app-shell ${fillStage ? 'app-shell-fill' : ''} ${
            siderDragging ? 'is-resizing' : ''
          } ${siderCollapsed ? 'sider-collapsed' : ''}`}
        >
          <aside
            className="app-sider"
            style={{ width: siderCollapsed ? 0 : siderWidth }}
            aria-hidden={siderCollapsed}
          >
            <div className="app-sider-body">
              <div className="app-sider-brand">
                <div className="app-sider-avatar">
                  <FileSearchOutlined />
                </div>
                <div className="app-sider-brand-text">
                  <div className="app-sider-title">Reviewer</div>
                </div>
              </div>

              <nav className="app-sider-nav">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`app-sider-item ${activeTab === tab.key ? 'active' : ''}`}
                    onClick={() => {
                      // 「对话」在审查记录下方：进入时应开新会话，而不是停在旧历史
                      if (tab.key === 'chat') {
                        openFreshChat()
                        return
                      }
                      navigate(tab.path)
                    }}
                  >
                    <span className="app-sider-icon">{tab.icon}</span>
                    {t(tab.labelKey)}
                  </button>
                ))}
              </nav>

              <div className="app-sider-section">
                <div className="app-sider-section-head">
                  <button
                    type="button"
                    className="app-sider-section-toggle"
                    onClick={() => setListOpen((v) => !v)}
                  >
                    <span>
                      {activeTab === 'chat' ? '对话列表' : t('nav.taskList')}
                    </span>
                    <DownOutlined
                      className={`app-sider-chevron ${listOpen ? 'open' : ''}`}
                    />
                  </button>
                  {activeTab === 'chat' ? null : (
                    <button type="button" className="app-sider-section-filter" title="筛选">
                      <FilterOutlined />
                    </button>
                  )}
                </div>
                {listOpen && (
                  <div className="app-sider-list">
                    {activeTab === 'chat' ? (
                      chatSessions.length === 0 ? (
                        <div className="app-sider-empty">暂无对话</div>
                      ) : (
                        chatSessions.map((item) => (
                          <div
                            key={item.id}
                            className={`app-sider-record ${
                              activeChatId === item.id ? 'active' : ''
                            }`}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              selectChatSession(item.id)
                              navigate('/')
                            }}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter' || ev.key === ' ') {
                                ev.preventDefault()
                                selectChatSession(item.id)
                                navigate('/')
                              }
                            }}
                          >
                            <span className="app-sider-record-dot" />
                            <div className="app-sider-record-main">
                              <div className="app-sider-record-name">
                                {item.title?.trim() || '新对话'}
                              </div>
                              <div className="app-sider-record-meta">
                                {formatTime(item.updatedAt || item.createdAt)}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="app-sider-record-delete"
                              title="删除对话"
                              aria-label="删除对话"
                              onClick={(ev) => handleDeleteChat(item.id, ev)}
                            >
                              <DeleteOutlined />
                            </button>
                          </div>
                        ))
                      )
                    ) : railItems.length === 0 ? (
                      <div className="app-sider-empty">{t('nav.noTasks')}</div>
                    ) : (
                      railItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`app-sider-record ${currentReport?.id === item.id ? 'active' : ''}`}
                          onClick={() => {
                            void useAppStore.getState().loadReport(item.id)
                            navigate(`/report?id=${encodeURIComponent(item.id)}`)
                          }}
                        >
                          <span className="app-sider-record-dot" />
                          <div className="app-sider-record-main">
                            <div className="app-sider-record-name">
                              {shortRepo(item.repoUrl)}
                            </div>
                            <div className="app-sider-record-meta">
                              {item.issues.length} 问题
                              {item.totalDurationMs != null
                                ? ` · ${formatDuration(item.totalDurationMs)}`
                                : ''}{' '}
                              · {formatTime(item.createdAt)}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="app-sider-foot">
              {cloudUser ? (
                <UserAccountMenu
                  displayName={cloudUser.displayName}
                  phone={cloudUser.phone}
                  email={cloudUser.email}
                  avatarUrl={cloudUser.avatarUrl}
                  initials={userInitials(cloudUser.displayName)}
                  onOpenSettings={openSettings}
                />
              ) : (
                <button
                  type="button"
                  className="app-sider-user guest"
                  title="浏览器授权登录"
                  disabled={loginBusy}
                  onClick={() => {
                    void (async () => {
                      setLoginBusy(true)
                      try {
                        await window.electronAPI.cloudStartBrowserLogin()
                        message.info('已打开浏览器，请完成登录授权')
                      } catch (e) {
                        message.error(
                          e instanceof Error ? e.message : '无法打开登录页'
                        )
                      } finally {
                        setLoginBusy(false)
                      }
                    })()
                  }}
                >
                  <span className="app-sider-user-avatar">
                    <span>?</span>
                  </span>
                  <span className="app-sider-user-meta">
                    <span className="app-sider-user-name">{t('nav.guest')}</span>
                    <span className="app-sider-user-sub">
                      {loginBusy ? t('nav.openingLogin') : t('nav.clickLogin')}
                    </span>
                  </span>
                </button>
              )}
            </div>
            <div
              className="app-sider-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              title="拖拽调整宽度"
              onMouseDown={onSiderResizeStart}
            />
          </aside>

          <div className={`app-stage ${fillStage ? 'app-stage-fill' : ''}`}>
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/review" element={<Dashboard />} />
              <Route path="/report" element={<ReportPage />} />
              <Route path="/chat" element={<Navigate to="/" replace />} />
              <Route
                path="/config"
                element={<ConfigRouteEntry onOpen={openSettings} />}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </div>

      <ConfigPage
        open={settingsOpen}
        onClose={closeSettings}
        initialSection={settingsSection}
      />
    </div>
  )
}

/** 兼容旧 #/config 深链：打开设置弹框并回到主界面 */
const ConfigRouteEntry = ({ onOpen }: { onOpen: () => void }): JSX.Element => {
  useEffect(() => {
    onOpen()
  }, [onOpen])
  return <Navigate to="/" replace />
}

const App = (): JSX.Element => (
  <HashRouter>
    <Shell />
  </HashRouter>
)

export default App
