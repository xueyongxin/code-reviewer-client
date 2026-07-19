import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { Button, Checkbox, Dropdown, Modal, Tag, Tree, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  EllipsisOutlined,
  EyeOutlined,
  PlusOutlined,
  SearchOutlined,
  SyncOutlined
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import DiffViewer from '../components/DiffViewer'
import WorkspaceEditor, {
  isRichDocPath
} from '../components/WorkspaceEditor'
import ExplorerContextMenu, {
  type ExplorerCtxTarget
} from '../components/ExplorerContextMenu'
import FlowTimeline, { formatDuration } from '../components/FlowTimeline'
import QuickOpenDialog from '../components/QuickOpenDialog'
import { buildRepoFileTree } from '../lib/fileTree'
import { parentDirsOf } from '../lib/pathUtils'
import {
  RPT_LEFT_COLLAPSED_KEY,
  RPT_LEFT_W_KEY,
  RPT_PANELS_EVENT,
  RPT_RIGHT_COLLAPSED_KEY,
  RPT_RIGHT_W_KEY,
  RPT_TOGGLE_EVENT
} from '../lib/panelPrefs'
import { useAppStore } from '../store/useAppStore'
import { reviewMethodById } from '../../../shared/review-methods'
import { formatDateTime } from '../../../shared/datetime'
import {
  resolvePipelineProjectRoot,
  shortRepo
} from '../../../shared/repo-path'
import type {
  IssueSeverity,
  RepoFileEntry,
  ReviewIssue,
  ReviewReport
} from '../../../shared/types'

const reportStageNodes = (
  report: ReviewReport
): Array<{ key: string; label: string; done: boolean }> => [
  {
    key: 'pull',
    label: '拉取',
    done:
      report.status === 'completed' ||
      report.status === 'failed' ||
      report.status === 'cancelled' ||
      (report.progress ?? 0) >= 30
  },
  {
    key: 'review',
    label: '审查',
    done:
      report.status === 'completed' ||
      report.status === 'failed' ||
      report.status === 'cancelled' ||
      (report.progress ?? 0) >= 70
  },
  {
    key: 'report',
    label: '报告',
    done: report.status === 'completed'
  }
]

const RPT_PANEL_MIN = 200
const RPT_PANEL_MAX = 480
const RPT_LEFT_DEFAULT = 300
const RPT_RIGHT_DEFAULT = 280

const readStoredWidth = (key: string, fallback: number): number => {
  try {
    const n = Number(localStorage.getItem(key))
    if (Number.isFinite(n) && n >= RPT_PANEL_MIN && n <= RPT_PANEL_MAX) return n
  } catch {
    // ignore
  }
  return fallback
}

const readStoredCollapsed = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

const STATUS_META: Record<
  ReviewReport['status'],
  { color: string; text: string; tone: string }
> = {
  pending: { color: 'default', text: '等待中', tone: 'pending' },
  running: { color: 'processing', text: '进行中', tone: 'running' },
  completed: { color: 'success', text: '已完成', tone: 'completed' },
  failed: { color: 'error', text: '失败', tone: 'failed' },
  cancelled: { color: 'warning', text: '已取消', tone: 'cancelled' }
}

const statusTag = (status: ReviewReport['status']) => {
  const m = STATUS_META[status] || { color: 'default', text: status }
  return <Tag color={m.color}>{m.text}</Tag>
}

const statusText = (status: ReviewReport['status']): string =>
  STATUS_META[status]?.text ?? status

const countIssues = (
  report: ReviewReport
): { total: number; error: number } => {
  const error = (report.issues ?? []).filter((i) => i.severity === 'error').length
  return { total: error, error }
}

const severityLabel = (s: IssueSeverity): string =>
  s === 'error' ? '错误' : s === 'warning' ? '警告' : '提示'

const ReportPage = (): JSX.Element => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const detailId = searchParams.get('id')

  const currentReport = useAppStore((s) => s.currentReport)
  const history = useAppStore((s) => s.history)
  const config = useAppStore((s) => s.config)
  const loadReport = useAppStore((s) => s.loadReport)
  const deleteReport = useAppStore((s) => s.deleteReport)
  const bootstrap = useAppStore((s) => s.bootstrap)

  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [focusLine, setFocusLine] = useState<number | undefined>(undefined)
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<string[]>([])
  /** 本地工作区文件树（与 IDE 打开文件夹同源） */
  const [workspaceEntries, setWorkspaceEntries] = useState<RepoFileEntry[]>([])
  const [workspaceLabel, setWorkspaceLabel] = useState('')
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [previewFile, setPreviewFile] = useState<{
    path: string
    content: string
    language?: string
  } | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [docSaving, setDocSaving] = useState(false)
  /** 右键菜单目标：null 表示点在空白处 */
  const [ctxTarget, setCtxTarget] = useState<ExplorerCtxTarget>(null)
  const [leftWidth, setLeftWidth] = useState(() =>
    readStoredWidth(RPT_LEFT_W_KEY, RPT_LEFT_DEFAULT)
  )
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth(RPT_RIGHT_W_KEY, RPT_RIGHT_DEFAULT)
  )
  const [leftCollapsed, setLeftCollapsed] = useState(() =>
    readStoredCollapsed(RPT_LEFT_COLLAPSED_KEY)
  )
  const [rightCollapsed, setRightCollapsed] = useState(() =>
    readStoredCollapsed(RPT_RIGHT_COLLAPSED_KEY)
  )
  const [panelDragging, setPanelDragging] = useState(false)
  const [listQuery, setListQuery] = useState('')
  const [listStatus, setListStatus] = useState<'all' | ReviewReport['status']>('all')
  const [listSelectedIds, setListSelectedIds] = useState<string[]>([])
  const [batchDeleting, setBatchDeleting] = useState(false)

  useEffect(() => {
    if (!history.length) {
      void bootstrap()
    }
  }, [history.length, bootstrap])

  const listStats = useMemo(() => {
    let completed = 0
    let failed = 0
    let withError = 0
    for (const r of history) {
      if (r.status === 'completed') completed += 1
      if (r.status === 'failed') failed += 1
      if ((r.issues ?? []).some((i) => i.severity === 'error')) withError += 1
    }
    return {
      total: history.length,
      completed,
      failed,
      withError
    }
  }, [history])

  const filteredHistory = useMemo(() => {
    const q = listQuery.trim().toLowerCase()
    return history
      .filter((r) => {
        if (listStatus !== 'all' && r.status !== listStatus) return false
        if (!q) return true
        const hay = [
          r.repoUrl,
          shortRepo(r.repoUrl),
          r.branch ?? '',
          r.runNote ?? '',
          r.commitSha ?? '',
          r.prNumber ? `pr #${r.prNumber}` : ''
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.createdAt).getTime()
        const tb = new Date(b.createdAt).getTime()
        return tb - ta
      })
  }, [history, listQuery, listStatus])

  useEffect(() => {
    if (!detailId) return
    if (currentReport?.id === detailId) {
      setLoadingDetail(false)
      return
    }
    setLoadingDetail(true)
    void loadReport(detailId)
      .catch((e) => message.error(e instanceof Error ? e.message : '加载报告失败'))
      .finally(() => setLoadingDetail(false))
  }, [detailId, currentReport?.id, loadReport])

  useEffect(() => {
    setActiveFile(null)
    setFocusLine(undefined)
    setActiveIssueId(null)
    setQuickOpen(false)
    setExpandedDirs([])
    setWorkspaceEntries([])
    setWorkspaceLabel('')
    setPreviewFile(null)
    setEditDraft('')
  }, [detailId])

  /** 审查进行中：展开右侧流程，方便盯每一步 */
  useEffect(() => {
    if (currentReport?.id !== detailId) return
    if (currentReport.status === 'running') {
      setRightCollapsed(false)
    }
  }, [currentReport?.id, currentReport?.status, detailId])

  useEffect(() => {
    try {
      localStorage.setItem(RPT_LEFT_W_KEY, String(leftWidth))
    } catch {
      // ignore
    }
  }, [leftWidth])

  useEffect(() => {
    try {
      localStorage.setItem(RPT_RIGHT_W_KEY, String(rightWidth))
    } catch {
      // ignore
    }
  }, [rightWidth])

  useEffect(() => {
    try {
      localStorage.setItem(RPT_LEFT_COLLAPSED_KEY, leftCollapsed ? '1' : '0')
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(RPT_PANELS_EVENT))
  }, [leftCollapsed])

  useEffect(() => {
    try {
      localStorage.setItem(RPT_RIGHT_COLLAPSED_KEY, rightCollapsed ? '1' : '0')
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(RPT_PANELS_EVENT))
  }, [rightCollapsed])

  useEffect(() => {
    const onToggle = (e: Event): void => {
      const side = (e as CustomEvent<'left' | 'right'>).detail
      if (side === 'left') setLeftCollapsed((v) => !v)
      else if (side === 'right') setRightCollapsed((v) => !v)
    }
    window.addEventListener(RPT_TOGGLE_EVENT, onToggle)
    return () => window.removeEventListener(RPT_TOGGLE_EVENT, onToggle)
  }, [])

  const onLeftResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = leftWidth
      setPanelDragging(true)
      const onMove = (ev: MouseEvent): void => {
        const next = Math.min(
          RPT_PANEL_MAX,
          Math.max(RPT_PANEL_MIN, startW + (ev.clientX - startX))
        )
        setLeftWidth(next)
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setPanelDragging(false)
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [leftWidth]
  )

  const onRightResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = rightWidth
      setPanelDragging(true)
      const onMove = (ev: MouseEvent): void => {
        const next = Math.min(
          RPT_PANEL_MAX,
          Math.max(RPT_PANEL_MIN, startW - (ev.clientX - startX))
        )
        setRightWidth(next)
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setPanelDragging(false)
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [rightWidth]
  )

  const openDetail = (id: string): void => {
    setSearchParams({ id })
  }

  const backToList = (): void => {
    setSearchParams({})
  }

  const confirmDelete = (reportId: string, afterDelete?: () => void): void => {
    Modal.confirm({
      centered: true,
      title: '删除审查报告',
      content: '删除后无法恢复，确定删除该审查记录？',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteReport(reportId)
          setListSelectedIds((prev) => prev.filter((id) => id !== reportId))
          message.success('已删除审查报告')
          afterDelete?.()
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败')
          throw e
        }
      }
    })
  }

  const toggleListSelect = (id: string, checked: boolean): void => {
    setListSelectedIds((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)
    )
  }

  const confirmBatchDelete = (): void => {
    const ids = listSelectedIds.filter((id) => filteredHistory.some((r) => r.id === id))
    if (!ids.length) {
      message.warning('请先勾选要删除的记录')
      return
    }
    Modal.confirm({
      centered: true,
      title: `批量删除 ${ids.length} 条记录`,
      content: '删除后无法恢复，确定删除所选审查记录？',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setBatchDeleting(true)
        try {
          let ok = 0
          let fail = 0
          for (const id of ids) {
            try {
              await deleteReport(id)
              ok += 1
            } catch {
              fail += 1
            }
          }
          setListSelectedIds([])
          if (fail === 0) message.success(`已删除 ${ok} 条记录`)
          else message.warning(`删除完成：成功 ${ok}，失败 ${fail}`)
        } finally {
          setBatchDeleting(false)
        }
      }
    })
  }

  const reviewFiles = currentReport?.files ?? []

  const projectRoot = useMemo(() => {
    if (!currentReport) return ''
    const pipe = config?.reviewPipelines?.find((p) => p.id === currentReport.pipelineId)
    return resolvePipelineProjectRoot(
      pipe?.workDir,
      currentReport.repoUrl || pipe?.repoUrl
    )
  }, [config?.reviewPipelines, currentReport])

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    if (!projectRoot || !window.electronAPI?.listLocalFolder) {
      setWorkspaceEntries([])
      setWorkspaceLabel('')
      return
    }
    setWorkspaceLoading(true)
    try {
      const listed = await window.electronAPI.listLocalFolder(projectRoot)
      const normalized = listed.files.map((f) => ({
        ...f,
        path: f.path.replace(/\\/g, '/')
      }))
      setWorkspaceEntries(normalized)
      setWorkspaceLabel(listed.rootLabel)
      if (normalized.some((f) => f.path === '分析报告' || f.path.startsWith('分析报告/'))) {
        setExpandedDirs((prev) =>
          prev.includes('分析报告') ? prev : [...prev, '分析报告']
        )
      }
    } catch (e) {
      setWorkspaceEntries([])
      setWorkspaceLabel('')
      console.warn('[report] 工作区同步失败', e)
    } finally {
      setWorkspaceLoading(false)
    }
  }, [projectRoot])

  useEffect(() => {
    void refreshWorkspace()
  }, [refreshWorkspace, currentReport?.id, currentReport?.status])

  /** 审查进行中轮询同步；窗口聚焦时再同步一次 */
  useEffect(() => {
    if (!projectRoot) return
    const onFocus = (): void => {
      void refreshWorkspace()
    }
    window.addEventListener('focus', onFocus)
    const running = currentReport?.status === 'running'
    const timer = running
      ? window.setInterval(() => void refreshWorkspace(), 2000)
      : undefined
    return () => {
      window.removeEventListener('focus', onFocus)
      if (timer) window.clearInterval(timer)
    }
  }, [projectRoot, currentReport?.status, refreshWorkspace])

  const issueCountOf = useCallback(
    (path: string): { error: number; total: number } => {
      const file = reviewFiles.find((f) => f.filePath === path)
      if (!file) return { error: 0, total: 0 }
      const error = file.issues.filter((i) => i.severity === 'error').length
      return { error, total: error }
    },
    [reviewFiles]
  )

  const workspaceFiles = useMemo(
    () => workspaceEntries.filter((e) => e.type === 'file'),
    [workspaceEntries]
  )

  useEffect(() => {
    if (!detailId) return
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setQuickOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailId])

  const fileTreeData = useMemo(
    () =>
      buildRepoFileTree(workspaceEntries, {
        renderFileTitle: ({ name, path }) => {
          const counts = issueCountOf(path)
          return (
            <span className="rpt-file-tree-label" title={path}>
              <span className="rpt-file-tree-name">{name}</span>
              {counts.error > 0 ? (
                <em className="rpt-file-tree-badge is-error">{counts.error}</em>
              ) : counts.total > 0 ? (
                <em className="rpt-file-tree-badge">{counts.total}</em>
              ) : null}
            </span>
          )
        }
      }),
    [workspaceEntries, issueCountOf]
  )

  const selectedPath =
    activeFile ??
    reviewFiles[0]?.filePath ??
    workspaceEntries.find((e) => e.type === 'file')?.path ??
    null
  const selectedReviewFile =
    reviewFiles.find((f) => f.filePath === selectedPath) ?? null

  const fileIssues = useMemo(() => {
    if (!selectedReviewFile) return [] as ReviewIssue[]
    return selectedReviewFile.issues
      .filter((i) => i.severity === 'error')
      .slice()
      .sort((a, b) => a.line - b.line)
  }, [selectedReviewFile])

  /**
   * 与 IDE 对齐：md/html 始终用 WorkspaceEditor（预览|编辑）。
   * Diff 仅用于「有错误的审查源码」或「点选了具体 issue」。
   */
  const showDiffViewer =
    Boolean(selectedReviewFile) &&
    Boolean(selectedPath) &&
    !isRichDocPath(selectedPath!) &&
    (fileIssues.length > 0 || Boolean(activeIssueId))

  const showWorkspacePreview =
    Boolean(selectedPath) &&
    !showDiffViewer &&
    previewFile?.path === selectedPath

  const loadWorkspaceFile = useCallback(
    async (path: string): Promise<void> => {
      if (!projectRoot) {
        setPreviewFile(null)
        setEditDraft('')
        return
      }
      try {
        const read = await window.electronAPI.readLocalFile({
          rootPath: projectRoot,
          filePath: path
        })
        setPreviewFile({
          path,
          content: read.content,
          language: read.language
        })
        setEditDraft(read.content)
      } catch (e) {
        setPreviewFile(null)
        setEditDraft('')
        message.error(e instanceof Error ? e.message : '读取文件失败')
      }
    },
    [projectRoot]
  )

  useEffect(() => {
    if (!selectedPath) return
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      for (const d of parentDirsOf(selectedPath)) next.add(d)
      return Array.from(next)
    })
  }, [selectedPath])

  /** 默认选中 / 切到需编辑器的文件时自动读盘 */
  useEffect(() => {
    if (!selectedPath || showDiffViewer) return
    if (previewFile?.path === selectedPath) return
    void loadWorkspaceFile(selectedPath)
  }, [selectedPath, showDiffViewer, previewFile?.path, loadWorkspaceFile])

  const selectFile = (path: string): void => {
    setActiveFile(path)
    setFocusLine(undefined)
    setActiveIssueId(null)
    const reviewed = reviewFiles.find((f) => f.filePath === path)
    const errorCount =
      reviewed?.issues.filter((i) => i.severity === 'error').length ?? 0
    const useDiff =
      Boolean(reviewed) && !isRichDocPath(path) && errorCount > 0
    if (useDiff) {
      setPreviewFile(null)
      setEditDraft('')
      return
    }
    void loadWorkspaceFile(path)
  }

  const openQuickHit = (path: string): void => {
    setQuickOpen(false)
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      for (const d of parentDirsOf(path)) next.add(d)
      return Array.from(next)
    })
    selectFile(path)
  }

  const saveDocFile = useCallback(async (): Promise<void> => {
    if (!projectRoot || !previewFile) return
    setDocSaving(true)
    try {
      await window.electronAPI.writeLocalFile({
        rootPath: projectRoot,
        filePath: previewFile.path,
        content: editDraft
      })
      setPreviewFile({ ...previewFile, content: editDraft })
      message.success('已保存')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setDocSaving(false)
    }
  }, [editDraft, previewFile, projectRoot])

  const selectIssue = (issue: ReviewIssue): void => {
    setActiveIssueId(issue.id)
    setActiveFile(issue.filePath)
    setFocusLine(issue.line)
    if (isRichDocPath(issue.filePath)) {
      void loadWorkspaceFile(issue.filePath)
    } else {
      setPreviewFile(null)
      setEditDraft('')
    }
  }

  // —— 列表视图 ——
  if (!detailId) {
    if (history.length === 0) {
      return (
        <div className="page rec-page records-page-empty">
          <header className="records-void-head">
            <div>
              <h1 className="records-void-title">审查记录</h1>
              <p className="records-void-sub">
                本地保存的审查结果会出现在下方列表，支持回看问题、Diff 与删除管理。
              </p>
            </div>
          </header>

          <div className="records-void-board">
            <div className="records-void-skeleton" aria-hidden>
              <div className="records-void-cols">
                <span>仓库</span>
                <span>状态</span>
                <span>问题</span>
                <span>耗时</span>
                <span>时间</span>
              </div>
              <div className="records-void-rows">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="records-void-row" style={{ ['--i' as string]: i }}>
                    <span className="records-void-bar w-lg" />
                    <span className="records-void-pill" />
                    <span className="records-void-bar w-sm" />
                    <span className="records-void-bar w-md" />
                    <span className="records-void-bar w-md" />
                  </div>
                ))}
              </div>
            </div>

            <div className="records-void-overlay">
              <div className="records-void-card">
                <div className="records-void-card-top">
                  <span className="records-void-kicker">Empty archive</span>
                  <div className="records-void-badges" aria-hidden>
                    <span className="records-void-badge is-ok">已完成</span>
                    <span className="records-void-badge">E / W</span>
                    <span className="records-void-badge">Diff</span>
                  </div>
                </div>
                <strong>还没有可回看的报告</strong>
                <p>
                  启动一次流水线后，这里会按时间列出仓库、问题数、耗时和报告入口。
                </p>
                <ul className="records-void-points">
                  <li>按仓库与时间检索历史审查</li>
                  <li>打开报告查看问题与代码 Diff</li>
                  <li>不需要的记录可随时删除</li>
                </ul>
                <div className="records-void-actions">
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => navigate('/review')}
                  >
                    开始第一次审查
                  </Button>
                  <button
                    type="button"
                    className="records-void-link"
                    onClick={() => navigate('/review')}
                  >
                    先去配置流水线
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="page rec-page">
        <header className="rec-topbar">
          <div className="rec-topbar-copy">
            <h1 className="rec-title">审查记录</h1>
            <p className="rec-sub">
              共 {listStats.total} 条 · 已完成 {listStats.completed} · 含错误 {listStats.withError}
            </p>
          </div>
          <div className="rec-topbar-actions">
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={!listSelectedIds.length}
              loading={batchDeleting}
              onClick={confirmBatchDelete}
            >
              批量删除{listSelectedIds.length ? ` (${listSelectedIds.length})` : ''}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/review')}>
              新建审查
            </Button>
          </div>
        </header>

        <div className="rec-toolbar">
          <div className="rec-tabs" role="tablist" aria-label="状态筛选">
            {(
              [
                ['all', `全部 ${listStats.total}`],
                ['completed', `已完成 ${listStats.completed}`],
                ['failed', `失败 ${listStats.failed}`],
                ['cancelled', '已取消'],
                ['running', '进行中']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={listStatus === key}
                className={`rec-tab ${listStatus === key ? 'is-active' : ''}`}
                onClick={() => setListStatus(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="rec-search">
            <input
              type="search"
              className="rec-search-native"
              placeholder="搜索仓库、分支、备注、PR…"
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              aria-label="搜索审查记录"
            />
            {listQuery ? (
              <button
                type="button"
                className="rec-search-clear"
                aria-label="清除搜索"
                onClick={() => setListQuery('')}
              >
                ×
              </button>
            ) : null}
            <SearchOutlined className="rec-search-icon" aria-hidden />
          </label>
        </div>

        <div className="rec-list-wrap">
          <div className="pipe-mine-table rec-table" role="table">
            <div className="pipe-mine-row pipe-mine-row-head" role="row">
              <div className="pipe-mine-col pipe-mine-col-check" role="columnheader">
                <Checkbox
                  checked={
                    filteredHistory.length > 0 &&
                    filteredHistory.every((r) => listSelectedIds.includes(r.id))
                  }
                  indeterminate={
                    listSelectedIds.some((id) => filteredHistory.some((r) => r.id === id)) &&
                    !filteredHistory.every((r) => listSelectedIds.includes(r.id))
                  }
                  onChange={(e) => {
                    setListSelectedIds(
                      e.target.checked ? filteredHistory.map((r) => r.id) : []
                    )
                  }}
                />
              </div>
              <div className="pipe-mine-col pipe-mine-col-name" role="columnheader">
                仓库名称
              </div>
              <div className="pipe-mine-col pipe-mine-col-status" role="columnheader">
                运行状态
              </div>
              <div className="pipe-mine-col pipe-mine-col-stages" role="columnheader">
                运行阶段
              </div>
              <div className="pipe-mine-col pipe-mine-col-trigger" role="columnheader">
                触发信息
              </div>
              <div className="pipe-mine-col pipe-mine-col-time" role="columnheader">
                开始时间
              </div>
              <div className="pipe-mine-col pipe-mine-col-actions" role="columnheader" />
            </div>

            {filteredHistory.length === 0 ? (
              <div className="pipe-mine-empty">
                没有匹配的记录
                {(listQuery || listStatus !== 'all') && (
                  <button
                    type="button"
                    className="rec-empty-clear"
                    onClick={() => {
                      setListQuery('')
                      setListStatus('all')
                    }}
                  >
                    清除筛选
                  </button>
                )}
              </div>
            ) : (
              filteredHistory.map((r, index) => {
                const title = shortRepo(r.repoUrl)
                const counts = countIssues(r)
                const stageNodes = reportStageNodes(r)
                const statusIcon =
                  r.status === 'completed' ? (
                    <CheckCircleFilled className="pipe-mine-status-ok" />
                  ) : r.status === 'failed' || r.status === 'cancelled' ? (
                    <CloseCircleFilled className="pipe-mine-status-fail" />
                  ) : r.status === 'running' || r.status === 'pending' ? (
                    <SyncOutlined spin className="pipe-mine-status-run" />
                  ) : null

                const moreItems: MenuProps['items'] = [
                  {
                    key: 'open',
                    icon: <EyeOutlined />,
                    label: '查看报告',
                    onClick: () => openDetail(r.id)
                  },
                  {
                    key: 'delete',
                    icon: <DeleteOutlined />,
                    danger: true,
                    label: '删除',
                    onClick: () => confirmDelete(r.id)
                  }
                ]

                return (
                  <div key={r.id} className="pipe-mine-row" role="row">
                    <div className="pipe-mine-col pipe-mine-col-check" role="cell">
                      <Checkbox
                        checked={listSelectedIds.includes(r.id)}
                        onChange={(e) => toggleListSelect(r.id, e.target.checked)}
                      />
                    </div>
                    <div className="pipe-mine-col pipe-mine-col-name" role="cell">
                      <button
                        type="button"
                        className="pipe-mine-name-btn"
                        onClick={() => openDetail(r.id)}
                      >
                        <span className="pipe-mine-name">{title}</span>
                        <span className="pipe-mine-name-sub">
                          {r.branch ? `${r.branch}` : '—'}
                          {counts.error ? ` · ${counts.error} 错误` : ''}
                          {r.totalDurationMs != null
                            ? ` · ${formatDuration(r.totalDurationMs)}`
                            : ''}
                        </span>
                      </button>
                    </div>
                    <div className="pipe-mine-col pipe-mine-col-status" role="cell">
                      <span className="pipe-mine-status" title={statusText(r.status)}>
                        <span className="pipe-mine-run-no">#{index + 1}</span>
                        {statusIcon}
                      </span>
                    </div>
                    <div className="pipe-mine-col pipe-mine-col-stages" role="cell">
                      <div className="pipe-mine-stages" aria-hidden>
                        {stageNodes.map((node, i) => (
                          <span key={node.key} className="pipe-mine-stage">
                            {i > 0 ? (
                              <span
                                className={`pipe-mine-stage-line ${
                                  node.done || stageNodes[i - 1]?.done ? 'is-on' : ''
                                }`}
                              />
                            ) : null}
                            <span className="pipe-mine-stage-label">{node.label}</span>
                            <span
                              className={`pipe-mine-stage-dot ${node.done ? 'is-done' : ''}`}
                            />
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="pipe-mine-col pipe-mine-col-trigger" role="cell">
                      <span className="pipe-mine-trigger">
                        <span className="pipe-mine-avatar" aria-hidden>
                          {(title.slice(0, 1) || '审').toUpperCase()}
                        </span>
                        <span title={r.runNote?.trim() || undefined}>
                          {r.runNote?.trim() || '手动触发'}
                        </span>
                      </span>
                    </div>
                    <div className="pipe-mine-col pipe-mine-col-time" role="cell">
                      <span className="pipe-mine-time">
                        {formatDateTime(r.createdAt, '-')}
                      </span>
                    </div>
                    <div className="pipe-mine-col pipe-mine-col-actions" role="cell">
                      <button
                        type="button"
                        className="pipe-mine-action"
                        title="查看报告"
                        aria-label="查看报告"
                        onClick={() => openDetail(r.id)}
                      >
                        <EyeOutlined />
                      </button>
                      <button
                        type="button"
                        className="pipe-mine-action"
                        title="删除"
                        aria-label="删除"
                        onClick={() => confirmDelete(r.id)}
                      >
                        <DeleteOutlined />
                      </button>
                      <Dropdown menu={{ items: moreItems }} trigger={['click']}>
                        <button
                          type="button"
                          className="pipe-mine-action"
                          title="更多"
                          aria-label="更多"
                        >
                          <EllipsisOutlined />
                        </button>
                      </Dropdown>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    )
  }

  // —— 详情视图 ——
  if (loadingDetail || !currentReport || currentReport.id !== detailId) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">Records</p>
            <h1 className="page-title">加载报告中…</h1>
          </div>
          <Button icon={<ArrowLeftOutlined />} onClick={backToList}>
            返回列表
          </Button>
        </div>
      </div>
    )
  }

  const errorCount = currentReport.issues.filter((i) => i.severity === 'error').length

  const activeIssue =
    (activeIssueId
      ? currentReport.issues.find((i) => i.id === activeIssueId)
      : null) ?? null
  const methodChips = (currentReport.methodIds ?? [])
    .map((id) => reviewMethodById(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
  const checkNodes =
    currentReport.flowTimeline?.filter((n) => n.id.startsWith('check:')) ?? []
  const fileErrorCount = selectedReviewFile
    ? selectedReviewFile.issues.filter((i) => i.severity === 'error').length
    : 0
  const fileCount = workspaceEntries.filter((e) => e.type === 'file').length

  const isRunning = currentReport.status === 'running'

  return (
    <div
      className={`page rpt-page is-inspect${panelDragging ? ' is-resizing' : ''}${
        isRunning ? ' is-running' : ''
      }`}
    >
      {isRunning ? (
        <div className="rpt-run-banner" aria-live="polite">
          <span className="rpt-run-banner-label">
            {currentReport.progressLabel || '审查进行中…'}
          </span>
          <div className="rpt-run-banner-track">
            <div
              className="rpt-run-banner-bar"
              style={{ width: `${Math.max(4, currentReport.progress ?? 0)}%` }}
            />
          </div>
          <em className="rpt-run-banner-pct mono">{currentReport.progress ?? 0}%</em>
        </div>
      ) : null}
      <div className="rpt-workspace is-inspect is-split">
        {!leftCollapsed ? (
          <aside
            className="rpt-issues is-inspect rpt-files-rail"
            style={{ width: leftWidth, flexBasis: leftWidth }}
          >
            <div className="rpt-issues-head">
              <div className="rpt-issues-title-row">
                <button
                  type="button"
                  className="rpt-back-inline"
                  onClick={backToList}
                  title="返回审查记录"
                >
                  <ArrowLeftOutlined />
                </button>
                <div
                  className="rpt-issues-title"
                  title={
                    [currentReport.repoUrl, projectRoot || workspaceLabel]
                      .filter(Boolean)
                      .join('\n') || undefined
                  }
                >
                  {shortRepo(currentReport.repoUrl) || workspaceLabel || '工作区'}
                  <em>{fileCount}</em>
                  {workspaceLoading ? (
                    <span className="rpt-issues-extra">同步中…</span>
                  ) : null}
                </div>
              </div>
              <div className="rpt-issues-head-actions">
                <button
                  type="button"
                  className={`rpt-mini-btn${quickOpen ? ' is-active' : ''}`}
                  title="快速打开（⌘P）"
                  aria-label="快速打开"
                  onClick={() => setQuickOpen(true)}
                >
                  <SearchOutlined />
                </button>
                {projectRoot ? (
                  <button
                    type="button"
                    className="rpt-mini-btn"
                    title={`同步工作区：${projectRoot}`}
                    onClick={() => void refreshWorkspace()}
                  >
                    <SyncOutlined spin={workspaceLoading} />
                  </button>
                ) : null}
              </div>
            </div>

            <ExplorerContextMenu
              className="rpt-file-tree-wrap"
              rootPath={projectRoot}
              target={ctxTarget}
              onTargetChange={setCtxTarget}
              onOpenFile={selectFile}
              onRefresh={refreshWorkspace}
              onAfterCreate={({ kind, path }) => {
                setExpandedDirs((prev) =>
                  Array.from(
                    new Set([
                      ...prev,
                      ...parentDirsOf(path),
                      ...(kind === 'dir' ? [path] : [])
                    ])
                  )
                )
              }}
              onAfterRename={({ from, to, isDir }) => {
                if (activeFile === from) {
                  setActiveFile(to)
                  if (!isDir) selectFile(to)
                } else if (previewFile?.path === from) {
                  if (!isDir) selectFile(to)
                  else setPreviewFile(null)
                }
              }}
              onAfterDelete={({ path }) => {
                if (
                  activeFile === path ||
                  activeFile?.startsWith(`${path}/`)
                ) {
                  setActiveFile(null)
                  setPreviewFile(null)
                }
              }}
            >
              {!projectRoot ? (
                <div className="rpt-empty">
                  流水线未配置工作目录，无法打开本地工作区
                </div>
              ) : workspaceEntries.length === 0 ? (
                <div className="rpt-empty">
                  {workspaceLoading
                    ? '正在同步工作区…'
                    : '工作区为空 — 可右键新建文件/文件夹'}
                </div>
              ) : (
                <Tree
                  showIcon
                  blockNode
                  className="repo-explorer-tree rpt-file-tree"
                  treeData={fileTreeData}
                  selectedKeys={selectedPath ? [selectedPath] : []}
                  expandedKeys={expandedDirs}
                  onExpand={(keys) => setExpandedDirs(keys.map(String))}
                  onSelect={(keys, info) => {
                    const key = String(keys[0] ?? info.node.key ?? '')
                    if (!key || !info.node.isLeaf) return
                    selectFile(key)
                  }}
                  onRightClick={({ node }) => {
                    const key = String(node.key ?? '')
                    if (!key) {
                      setCtxTarget(null)
                      return
                    }
                    setCtxTarget({ path: key, isDir: !node.isLeaf })
                  }}
                />
              )}
            </ExplorerContextMenu>

            {selectedReviewFile && fileIssues.length > 0 ? (
              <div className="rpt-file-issues">
                <div className="rpt-file-issues-head">
                  <span>本文件问题</span>
                  <em>{fileIssues.length}</em>
                </div>
                <div className="rpt-file-issues-list">
                  {fileIssues.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      className={`rpt-file-issue ${activeIssueId === issue.id ? 'is-active' : ''} is-${issue.severity}`}
                      onClick={() => selectIssue(issue)}
                    >
                      <span className={`rpt-pill is-${issue.severity}`}>
                        {severityLabel(issue.severity)}
                      </span>
                      <span className="rpt-file-issue-line">L{issue.line}</span>
                      <span className="rpt-file-issue-msg">{issue.message}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}

        {!leftCollapsed ? (
          <div
            className="rpt-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整左侧宽度"
            title="拖拽调整宽度"
            onMouseDown={onLeftResizeStart}
          />
        ) : null}

        <section className="rpt-diff is-inspect">
          <div className="rpt-diff-summary">
            <div className="rpt-diff-summary-identity">
              {statusTag(currentReport.status)}
              <span className={`rpt-error-badge ${errorCount ? 'has-error' : 'is-clean'}`}>
                {errorCount ? `${errorCount} 个错误` : '无错误'}
              </span>
              {methodChips.length > 0
                ? methodChips.map((m) => (
                    <span
                      key={m.id}
                      className="rpt-method-chip"
                      title={m.description}
                    >
                      {m.name}
                    </span>
                  ))
                : null}
            </div>
            {activeIssue ? (
              <div className={`rpt-focus is-inline is-${activeIssue.severity}`}>
                <span className={`rpt-pill is-${activeIssue.severity}`}>
                  {severityLabel(activeIssue.severity)}
                </span>
                <span className="rpt-focus-msg">{activeIssue.message}</span>
                <span className="rpt-focus-loc mono">
                  {activeIssue.filePath}:{activeIssue.line}
                </span>
              </div>
            ) : selectedReviewFile && fileIssues.length > 0 ? (
              <span className="rpt-diff-summary-hint">点选左侧问题可定位到代码行</span>
            ) : null}
          </div>

          {/* Diff 仅审查源码；md/html 与普通浏览走 WorkspaceEditor（与 IDE 同一套） */}
          {showDiffViewer && selectedReviewFile ? (
            <div className="rpt-diff-head">
              <div className="rpt-diff-file mono" title={selectedPath ?? undefined}>
                {selectedPath ?? '—'}
              </div>
              <div className="rpt-diff-head-right">
                {selectedReviewFile.language ? (
                  <Tag>{selectedReviewFile.language}</Tag>
                ) : null}
                <span className="rpt-diff-count">本文件错误 {fileErrorCount}</span>
              </div>
            </div>
          ) : null}

          <div className="rpt-diff-body">
            {showDiffViewer && selectedReviewFile ? (
              <DiffViewer
                key={`${selectedReviewFile.filePath}-${focusLine ?? 'x'}`}
                original={selectedReviewFile.originalContent ?? ''}
                modified={selectedReviewFile.content}
                language={selectedReviewFile.language || 'plaintext'}
                issues={fileIssues}
                focusLine={focusLine}
              />
            ) : showWorkspacePreview && previewFile ? (
              <WorkspaceEditor
                path={previewFile.path}
                value={editDraft}
                language={previewFile.language}
                dirty={editDraft !== previewFile.content}
                onChange={(v) => setEditDraft(v)}
                onSave={() => void saveDocFile()}
                initialDocMode="preview"
                statusLeft={
                  docSaving ? (
                    <span className="repo-status-item">保存中…</span>
                  ) : null
                }
              />
            ) : selectedPath ? (
              <div className="rpt-empty">正在读取工作区文件…</div>
            ) : (
              <div className="rpt-empty">从左侧工作区选择文件</div>
            )}
          </div>
        </section>

        {!rightCollapsed ? (
          <div
            className="rpt-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整右侧宽度"
            title="拖拽调整宽度"
            onMouseDown={onRightResizeStart}
          />
        ) : null}

        {!rightCollapsed ? (
          <aside
            className="rpt-flow-rail"
            aria-label="流程节点"
            style={{ width: rightWidth, flexBasis: rightWidth }}
          >
            <div className="rpt-flow-rail-head">
              <span>{isRunning ? '执行过程' : '流程节点'}</span>
              <span className="rpt-flow-rail-meta mono">
                {checkNodes.length ? `${checkNodes.length} 项检查 · ` : ''}
                {formatDuration(currentReport.totalDurationMs)}
                {isRunning && currentReport.progressLabel
                  ? ` · ${currentReport.progressLabel}`
                  : ''}
              </span>
            </div>
            <div className="rpt-flow-rail-body">
              <FlowTimeline
                nodes={currentReport.flowTimeline ?? []}
                totalDurationMs={currentReport.totalDurationMs}
                compact={!isRunning}
                followRunning={isRunning}
              />
            </div>
          </aside>
        ) : null}
      </div>

      <QuickOpenDialog
        open={quickOpen}
        files={workspaceFiles}
        onClose={() => setQuickOpen(false)}
        onSelect={openQuickHit}
      />
    </div>
  )
}

export default ReportPage
