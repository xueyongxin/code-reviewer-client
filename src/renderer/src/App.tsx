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
  AppstoreOutlined,
  CodeOutlined,
  CommentOutlined,
  DeleteOutlined,
  DownOutlined,
  FileSearchOutlined
} from '@ant-design/icons'
import ChatPage from './pages/ChatPage'
import ConfigPage, { type SettingsSection } from './pages/ConfigPage'
import { useAppearance } from './prefs/AppearanceProvider'
import Dashboard from './pages/Dashboard'
import RepoEditorPage from './pages/RepoEditorPage'
import ReportPage from './pages/ReportPage'
import SiderToggleIcon from './components/SiderToggleIcon'
import UserAccountMenu from './components/UserAccountMenu'
import { useAppStore } from './store/useAppStore'
import { formatDateTime } from '../../shared/datetime'
import {
  RPT_LEFT_COLLAPSED_KEY,
  RPT_PANELS_EVENT,
  RPT_RIGHT_COLLAPSED_KEY,
  RPT_TOGGLE_EVENT
} from './lib/panelPrefs'

const SIDER_WIDTH_KEY = 'cr.siderWidth'
const SIDER_COLLAPSED_KEY = 'cr.siderCollapsed.v2'
const EXPLORER_COLLAPSED_KEY = 'cr.ideExplorerCollapsed'
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

const readStoredExplorerCollapsed = (): boolean => {
  try {
    return localStorage.getItem(EXPLORER_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

const TABS = [
  {
    key: 'review',
    path: '/review',
    labelKey: 'nav.newReview' as const,
    icon: <CodeOutlined />
  },
  {
    key: 'inbox',
    path: '/report',
    labelKey: 'nav.records' as const,
    icon: <FileSearchOutlined />
  },
  { key: 'chat', path: '/', labelKey: 'nav.chat' as const, icon: <CommentOutlined /> }
] as const

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
  const chatSessions = useAppStore((s) => s.chatSessions)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const selectChatSession = useAppStore((s) => s.selectChatSession)
  const refreshChatSessions = useAppStore((s) => s.refreshChatSessions)
  const [listOpen, setListOpen] = useState(true)
  const [siderWidth, setSiderWidth] = useState(readStoredSiderWidth)
  const [siderCollapsed, setSiderCollapsed] = useState(readStoredSiderCollapsed)
  /** IDE 资源管理器折叠（与审查侧栏状态分离） */
  const [explorerCollapsed, setExplorerCollapsed] = useState(readStoredExplorerCollapsed)
  const [rptLeftCollapsed, setRptLeftCollapsed] = useState(
    () => {
      try {
        return localStorage.getItem(RPT_LEFT_COLLAPSED_KEY) === '1'
      } catch {
        return false
      }
    }
  )
  const [rptRightCollapsed, setRptRightCollapsed] = useState(
    () => {
      try {
        return localStorage.getItem(RPT_RIGHT_COLLAPSED_KEY) === '1'
      } catch {
        return false
      }
    }
  )
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

  useEffect(() => {
    try {
      localStorage.setItem(EXPLORER_COLLAPSED_KEY, explorerCollapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [explorerCollapsed])

  const toggleSider = useCallback(() => {
    setSiderCollapsed((v) => !v)
  }, [])

  const toggleExplorer = useCallback(() => {
    setExplorerCollapsed((v) => !v)
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

  const isRepoEditor = location.pathname.startsWith('/review/editor')
  /** 顶栏模式：仅 IDE 页点亮 IDE；其余任意页（含对话/记录）点亮「审查」 */
  const isReviewMode = !isRepoEditor
  /** 顶栏红绿灯后：IDE / 审查（任意页面常驻） */
  const showReviewModeSwitch = true

  const goReviewEditor = useCallback((): void => {
    const pipelines = config?.reviewPipelines ?? []
    const candidate =
      new URLSearchParams(location.search).get('pipelineId') ||
      config?.activePipelineId ||
      pipelines[0]?.id ||
      ''
    const id = pipelines.some((p) => p.id === candidate)
      ? candidate
      : pipelines[0]?.id || ''
    navigate(id ? `/review/editor?pipelineId=${encodeURIComponent(id)}` : '/review/editor')
  }, [config, location.search, navigate])

  /** 侧栏「代码审查」/顶栏「审查」：始终进入流水线列表（无流水线则为引导空态） */
  const goReviewHome = useCallback((): void => {
    navigate('/review?home=1')
  }, [navigate])

  /** 查看报告详情时隐藏应用侧栏，把横向空间全部留给问题列表 + Diff */
  const reportDetailId = useMemo(() => {
    if (!location.pathname.startsWith('/report')) return null
    return new URLSearchParams(location.search).get('id')
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!reportDetailId) return
    const sync = (): void => {
      try {
        setRptLeftCollapsed(localStorage.getItem(RPT_LEFT_COLLAPSED_KEY) === '1')
        setRptRightCollapsed(localStorage.getItem(RPT_RIGHT_COLLAPSED_KEY) === '1')
      } catch {
        // ignore
      }
    }
    sync()
    window.addEventListener(RPT_PANELS_EVENT, sync)
    return () => window.removeEventListener(RPT_PANELS_EVENT, sync)
  }, [reportDetailId])

  const toggleRptPanel = useCallback((side: 'left' | 'right'): void => {
    window.dispatchEvent(new CustomEvent(RPT_TOGGLE_EVENT, { detail: side }))
  }, [])

  const hideAppSider = isRepoEditor || Boolean(reportDetailId)
  /** 仅对话页显示侧栏列表；审查记录/报告详情不再挂任务列表 */
  const showSiderList = activeTab === 'chat' && !hideAppSider

  const fillStage = true

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
      <header className={`app-titlebar ${isRepoEditor ? 'is-editor' : ''}`}>
        <div className="app-titlebar-traffic-space" aria-hidden />
        {showReviewModeSwitch ? (
          <div
            className="repo-mode-switch app-titlebar-mode-switch"
            role="tablist"
            aria-label="视图切换"
          >
            <button
              type="button"
              role="tab"
              aria-selected={isRepoEditor}
              className={`repo-mode-btn ${isRepoEditor ? 'active' : ''}`}
              onClick={goReviewEditor}
            >
              <CodeOutlined />
              <span>IDE</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isReviewMode}
              className={`repo-mode-btn ${isReviewMode ? 'active' : ''}`}
              onClick={goReviewHome}
            >
              <AppstoreOutlined />
              <span>审查</span>
            </button>
          </div>
        ) : null}
        {reportDetailId ? (
          <button
            type="button"
            className={`sider-toggle${rptLeftCollapsed ? '' : ' is-on'}`}
            title={rptLeftCollapsed ? '展开问题列表' : '折叠问题列表'}
            aria-label={rptLeftCollapsed ? '展开问题列表' : '折叠问题列表'}
            aria-pressed={!rptLeftCollapsed}
            onClick={() => toggleRptPanel('left')}
          >
            <SiderToggleIcon side="left" />
          </button>
        ) : (
          <button
            type="button"
            className="sider-toggle"
            title={
              isRepoEditor
                ? explorerCollapsed
                  ? '展开资源管理器'
                  : '折叠资源管理器'
                : siderCollapsed
                  ? t('nav.expandSider')
                  : t('nav.collapseSider')
            }
            aria-label={
              isRepoEditor
                ? explorerCollapsed
                  ? '展开资源管理器'
                  : '折叠资源管理器'
                : siderCollapsed
                  ? t('nav.expandSider')
                  : t('nav.collapseSider')
            }
            onClick={isRepoEditor ? toggleExplorer : toggleSider}
          >
            <SiderToggleIcon />
          </button>
        )}
        <div className="app-titlebar-drag">
          <span className="app-titlebar-name">Code Reviewer</span>
        </div>
        {reportDetailId ? (
          <button
            type="button"
            className={`sider-toggle app-titlebar-right-toggle${rptRightCollapsed ? '' : ' is-on'}`}
            title={rptRightCollapsed ? '展开流程与摘要' : '折叠流程与摘要'}
            aria-label={rptRightCollapsed ? '展开流程与摘要' : '折叠流程与摘要'}
            aria-pressed={!rptRightCollapsed}
            onClick={() => toggleRptPanel('right')}
          >
            <SiderToggleIcon side="right" />
          </button>
        ) : null}
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
          } ${!hideAppSider && siderCollapsed ? 'sider-collapsed' : ''} ${
            hideAppSider ? 'sider-collapsed' : ''
          } ${isRepoEditor ? 'is-repo-editor' : ''} ${
            isRepoEditor && explorerCollapsed ? 'explorer-collapsed' : ''
          } ${reportDetailId ? 'is-report-detail' : ''}`}
        >
          <aside
            className="app-sider"
            style={{
              width: hideAppSider || siderCollapsed ? 0 : siderWidth
            }}
            aria-hidden={hideAppSider || siderCollapsed}
          >
            <div className="app-sider-body">
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
                      if (tab.key === 'review') {
                        goReviewHome()
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

              {showSiderList ? (
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
                </div>
                {listOpen && (
                  <div className="app-sider-list">
                    {chatSessions.length === 0 ? (
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
                              {formatDateTime(item.updatedAt || item.createdAt)}
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
                    )}
                  </div>
                )}
              </div>
              ) : null}
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
              <Route path="/" element={<ChatPage onOpenSettings={openSettings} />} />
              <Route path="/review" element={<Dashboard onOpenSettings={openSettings} />} />
              <Route path="/review/editor" element={<RepoEditorPage />} />
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
