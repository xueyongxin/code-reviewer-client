import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Key,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { Modal, Spin, Tooltip, Tree, message } from 'antd'
import {
  CloseOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  ReloadOutlined,
  SearchOutlined,
  ShrinkOutlined
} from '@ant-design/icons'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { RepoFileEntry } from '../../../shared/types'
import { resolveEditorLanguage } from '../../../shared/language'
import brandMark from '../assets/brand-mark.svg'
import ExplorerContextMenu, {
  createLocalFsAdapter,
  type ExplorerCtxTarget,
  type ExplorerFsAdapter
} from '../components/ExplorerContextMenu'
import FileTypeIcon from '../components/FileTypeIcon'
import QuickOpenDialog from '../components/QuickOpenDialog'
import WorkspaceEditor from '../components/WorkspaceEditor'
import { buildRepoFileTree, formatFileSize } from '../lib/fileTree'
import { parentDirsOf } from '../lib/pathUtils'
import {
  normalizeRecentIdeProjects,
  readLegacyRecentIdeProjects,
  recentProjectDisplay,
  rememberRecentIdeProject,
  removeRecentByPipelineId,
  removeRecentIdeProject,
  type RecentIdeProject
} from '../lib/recentIdeProjects'
import { shouldLeaveLocalOnPipelineNav } from '../lib/ideWorkspace'
import { resolvePipelineProjectRoot } from '../../../shared/repo-path'
import { useAppStore } from '../store/useAppStore'

interface EditorTab {
  path: string
  content: string
  /** 上次保存到磁盘的内容，用于脏检查 */
  savedContent: string
  language?: string
  /** Cursor/VS Code 预览标签：斜体，再次打开其它文件会替换 */
  preview?: boolean
  /** 来自本机打开的文件夹工作区 */
  isLocal?: boolean
}

/** 是否为文件系统绝对路径（未命名另存为工作区外时使用） */
const isFilesystemAbsolute = (p: string): boolean =>
  p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

const RepoEditorPage = (): JSX.Element => {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const pipelineId = searchParams.get('pipelineId') || ''
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const currentReport = useAppStore((s) => s.currentReport)
  const recentMigratedRef = useRef(false)
  const editorNavKeyRef = useRef<string | null>(null)
  const localRootRef = useRef('')

  const pipeline = useMemo(() => {
    const list = config?.reviewPipelines ?? []
    // URL 指定了 pipelineId 时不静默回落到 active，避免打开「别的」仓库
    if (pipelineId) return list.find((p) => p.id === pipelineId)
    return list.find((p) => p.id === config?.activePipelineId)
  }, [config, pipelineId])

  const repoUrl = pipeline?.repoUrl || searchParams.get('repoUrl') || ''
  const branch = pipeline?.branch || searchParams.get('branch') || undefined
  const mcpServerId =
    pipeline?.mcpServerId || searchParams.get('mcpServerId') || undefined

  const [loading, setLoading] = useState(false)
  const [files, setFiles] = useState<RepoFileEntry[]>([])
  const [rootLabel, setRootLabel] = useState('')
  /** 本机打开的文件夹根路径；有值时优先作为 IDE 工作区 */
  const [localRoot, setLocalRoot] = useState('')
  localRootRef.current = localRoot
  /** 用户主动移除项目后，即使流水线仍有仓库也不再展示 */
  const [workspaceClosed, setWorkspaceClosed] = useState(false)
  /** 无工作区时空 Untitled 默认展示欢迎页；新建/输入后进编辑器 */
  const [forceShowEditor, setForceShowEditor] = useState(false)
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([])
  const [quickOpen, setQuickOpen] = useState(false)
  const [openEditorsOpen, setOpenEditorsOpen] = useState(true)
  const [explorerOpen, setExplorerOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [treeSelected, setTreeSelected] = useState<string[]>([])
  const [ctxTarget, setCtxTarget] = useState<ExplorerCtxTarget>(null)
  const [createDraft, setCreateDraft] = useState<{
    kind: 'file' | 'dir'
    parent: string
    name: string
  } | null>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)
  const createIgnoreBlurRef = useRef(false)
  const createBusyRef = useRef(false)
  const shellRef = useRef<HTMLDivElement | null>(null)

  const activeTab = tabs.find((t) => t.path === activePath) || null
  const hasWorkspace =
    !workspaceClosed && Boolean(localRoot || repoUrl?.trim())
  const fileEntries = useMemo(
    () => files.filter((f) => f.type === 'file'),
    [files]
  )

  const applyWorkspaceFiles = (nextFiles: RepoFileEntry[], label: string): void => {
    setFiles(nextFiles)
    setRootLabel(label)
    const topDirs = nextFiles
      .filter((f) => f.type === 'dir' && !f.path.includes('/'))
      .map((f) => f.path)
      .slice(0, 8)
    setExpandedKeys(topDirs)
  }

  /** 本机配置库中的最近打开；展示时用流水线现名覆盖快照名 */
  const recentProjects = useMemo(
    () => normalizeRecentIdeProjects(config?.recentIdeProjects),
    [config?.recentIdeProjects]
  )

  const recentProjectsView = useMemo(() => {
    const pipes = config?.reviewPipelines ?? []
    if (!pipes.length) return recentProjects
    return recentProjects.map((item) => {
      if (item.kind !== 'pipeline' || !item.pipelineId) return item
      const pipe = pipes.find((p) => p.id === item.pipelineId)
      if (!pipe) return item
      return {
        ...item,
        pipelineName: pipe.name || item.pipelineName,
        repoUrl: pipe.repoUrl || item.repoUrl,
        branch: pipe.branch || item.branch,
        mcpServerId: pipe.mcpServerId || item.mcpServerId
      }
    })
  }, [recentProjects, config?.reviewPipelines])

  const persistRecent = useCallback(
    async (next: RecentIdeProject[]): Promise<void> => {
      if (!config) return
      await saveConfig({ ...config, recentIdeProjects: next })
    },
    [config, saveConfig]
  )

  /** 旧 localStorage → 本地配置库 */
  useEffect(() => {
    if (!config || recentMigratedRef.current) return
    recentMigratedRef.current = true
    if ((config.recentIdeProjects?.length ?? 0) > 0) {
      readLegacyRecentIdeProjects()
      return
    }
    const legacy = readLegacyRecentIdeProjects()
    if (!legacy.length) return
    void saveConfig({ ...config, recentIdeProjects: legacy })
  }, [config, saveConfig])

  const rememberLocalProject = useCallback(
    (rootPath: string, label: string) => {
      if (!config) return
      const next = rememberRecentIdeProject(config.recentIdeProjects ?? [], {
        kind: 'local',
        localPath: rootPath,
        projectName: label
      })
      void persistRecent(next)
    },
    [config, persistRecent]
  )

  const rememberPipelineProject = useCallback(
    (label: string) => {
      if (!repoUrl?.trim() || !config) return
      const pipe = pipeline
      const next = rememberRecentIdeProject(config.recentIdeProjects ?? [], {
        kind: 'pipeline',
        pipelineId: pipe?.id || pipelineId || undefined,
        pipelineName: pipe?.name || '流水线',
        projectName: label || pipe?.name || repoUrl.split('/').pop() || '项目',
        repoUrl,
        branch,
        mcpServerId
      })
      void persistRecent(next)
    },
    [config, persistRecent, repoUrl, pipeline, pipelineId, branch, mcpServerId]
  )

  const loadTree = async (forceRefresh = false): Promise<void> => {
    if (forceRefresh) {
      const dirtyCount = tabs.filter((t) => t.content !== t.savedContent).length
      if (dirtyCount > 0) {
        const ok = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            centered: true,
            title: '有未保存的更改',
            content: `刷新将丢弃 ${dirtyCount} 个标签页的未保存修改，是否继续？`,
            okText: '丢弃并刷新',
            okType: 'danger',
            cancelText: '取消',
            onOk: () => resolve(true),
            onCancel: () => resolve(false)
          })
        })
        if (!ok) return
      }
    }

    setLoading(true)
    try {
      if (localRoot) {
        const result = await window.electronAPI.listLocalFolder(localRoot)
        applyWorkspaceFiles(result.files, result.rootLabel)
        rememberLocalProject(result.rootPath, result.rootLabel)
        if (forceRefresh) {
          setTabs((prev) => prev.filter((t) => t.path.startsWith('Untitled-')))
          setActivePath(null)
        }
        return
      }
      if (!repoUrl) return
      const result = await window.electronAPI.listRepoFiles({
        repoUrl,
        branch,
        mcpServerId,
        forceRefresh
      })
      applyWorkspaceFiles(result.files, result.rootLabel)
      rememberPipelineProject(result.rootLabel)
      if (forceRefresh) {
        setTabs([])
        setActivePath(null)
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载项目文件失败')
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  const pipelineProjectRoot = useMemo(
    () => resolvePipelineProjectRoot(pipeline?.workDir, pipeline?.repoUrl || repoUrl),
    [pipeline?.workDir, pipeline?.repoUrl, repoUrl]
  )

  /**
   * 顶栏/看板 navigate 进流水线 IDE：
   * - 已配置工作目录 → 打开本地项目根（见下方 effect）
   * - 未配置 → 退出本机文件夹模式，走远程缓存 clone
   */
  useEffect(() => {
    const wantsPipeline = Boolean(pipelineId || searchParams.get('repoUrl'))
    const keyChanged =
      editorNavKeyRef.current !== null && editorNavKeyRef.current !== location.key
    editorNavKeyRef.current = location.key
    if (pipelineProjectRoot) return
    if (
      !shouldLeaveLocalOnPipelineNav({
        wantsPipeline,
        navKeyChanged: keyChanged,
        hasLocalRoot: Boolean(localRootRef.current)
      })
    ) {
      return
    }
    setLocalRoot('')
    setWorkspaceClosed(false)
    setFiles([])
    setRootLabel('')
    setTabs([])
    setActivePath(null)
    setCreateDraft(null)
  }, [location.key, pipelineId, searchParams, pipelineProjectRoot])

  /** 流水线配置了工作区时：直接打开本地 `{workDir}/{repo}` */
  useEffect(() => {
    if (workspaceClosed || !pipelineProjectRoot) return
    if (localRootRef.current === pipelineProjectRoot && files.length > 0) return

    let cancelled = false
    setLocalRoot(pipelineProjectRoot)
    setWorkspaceClosed(false)
    setForceShowEditor(false)
    setTabs([])
    setActivePath(null)
    setCreateDraft(null)

    void (async () => {
      setLoading(true)
      try {
        const result = await window.electronAPI.listLocalFolder(pipelineProjectRoot)
        if (cancelled) return
        applyWorkspaceFiles(result.files, result.rootLabel)
        rememberLocalProject(result.rootPath, result.rootLabel)
      } catch (e) {
        if (cancelled) return
        setFiles([])
        setRootLabel(pipelineProjectRoot)
        message.warning(
          e instanceof Error
            ? e.message
            : `本地工作区不存在或无法读取：${pipelineProjectRoot}。请先完成一次审查拉取代码。`
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineProjectRoot, workspaceClosed, location.key])

  useEffect(() => {
    if (workspaceClosed || localRoot || !repoUrl) return
    if (pipelineProjectRoot) return
    void loadTree(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrl, branch, mcpServerId, workspaceClosed, localRoot, pipelineProjectRoot])

  /** 审查结束后刷新本地树，让「分析报告」目录出现 */
  useEffect(() => {
    if (currentReport?.status !== 'completed' || !localRoot) return
    if (pipelineProjectRoot && localRoot !== pipelineProjectRoot) return
    void loadTree(false)
    setExpandedKeys((prev) =>
      prev.map(String).includes('分析报告') ? prev : [...prev, '分析报告']
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentReport?.id, currentReport?.status, localRoot, pipelineProjectRoot])

  const treeData = useMemo(() => buildRepoFileTree(files), [files])

  const revealInTree = useCallback((path: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev.map(String))
      for (const d of parentDirsOf(path)) next.add(d)
      return Array.from(next)
    })
  }, [])

  const openFile = useCallback(
    async (path: string, mode: 'preview' | 'pin' = 'preview'): Promise<void> => {
      const entry = files.find((f) => f.path === path)
      if (!entry || entry.type !== 'file') return

      if (entry.tooLarge) {
        message.warning(
          `文件过大（约 ${formatFileSize(entry.size)}），无法在编辑器中预览`
        )
        return
      }

      let alreadyOpen = false
      setTabs((prev) => {
        const existing = prev.find((t) => t.path === path)
        if (!existing) return prev
        alreadyOpen = true
        return prev.map((t) =>
          t.path === path
            ? { ...t, preview: mode === 'preview' ? t.preview : false }
            : t
        )
      })
      if (alreadyOpen) {
        setActivePath(path)
        revealInTree(path)
        return
      }

      setLoadingPath(path)
      setActivePath(path)
      revealInTree(path)
      // 先占位标签，避免加载时闪回欢迎页
      setTabs((prev) => {
        const withoutPreview =
          mode === 'preview' ? prev.filter((t) => !t.preview) : prev
        const withoutSelf = withoutPreview.filter((t) => t.path !== path)
        return [
          ...withoutSelf,
          {
            path,
            content: '',
            savedContent: '',
            language: resolveEditorLanguage(path),
            preview: mode === 'preview',
            isLocal: Boolean(localRoot)
          }
        ]
      })
      try {
        const result = localRoot
          ? await window.electronAPI.readLocalFile({
              rootPath: localRoot,
              filePath: path
            })
          : await window.electronAPI.readRepoFile({
              repoUrl,
              branch,
              mcpServerId,
              filePath: path
            })
        const lang = resolveEditorLanguage(path, result.language)
        setTabs((prev) =>
          prev.map((t) =>
            t.path === path
              ? {
                  ...t,
                  content: result.content,
                  savedContent: result.content,
                  language: lang,
                  preview: mode === 'preview' ? t.preview : false,
                  isLocal: Boolean(localRoot)
                }
              : t
          )
        )
      } catch (e) {
        setTabs((prev) => prev.filter((t) => t.path !== path))
        setActivePath((cur) => (cur === path ? null : cur))
        message.error(e instanceof Error ? e.message : '读取文件失败')
      } finally {
        setLoadingPath((cur) => (cur === path ? null : cur))
      }
    },
    [files, repoUrl, branch, mcpServerId, localRoot, revealInTree]
  )

  const closeTab = useCallback(
    (path: string, e?: ReactMouseEvent) => {
      e?.stopPropagation()
      setTabs((prev) => {
        const target = prev.find((t) => t.path === path)
        if (target && target.content !== target.savedContent) {
          const ok = window.confirm(`「${path.split('/').pop()}」有未保存更改，确定关闭？`)
          if (!ok) return prev
        }
        const idx = prev.findIndex((t) => t.path === path)
        if (idx < 0) return prev
        const next = prev.filter((t) => t.path !== path)
        if (activePath === path) {
          const fallback = next[idx - 1] || next[idx] || next[next.length - 1]
          setActivePath(fallback?.path ?? null)
        }
        return next
      })
    },
    [activePath]
  )

  const closeOtherTabs = useCallback((path: string) => {
    setTabs((prev) =>
      prev.filter((t) => t.path === path).map((t) => ({ ...t, preview: false }))
    )
    setActivePath(path)
  }, [])

  const onEditContent = useCallback((path: string, content: string) => {
    if (content) setForceShowEditor(true)
    setTabs((prev) =>
      prev.map((t) => (t.path === path ? { ...t, content, preview: false } : t))
    )
  }, [])

  const saveActiveFile = useCallback(async (): Promise<void> => {
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return

    const isUntitled = tab.path.startsWith('Untitled-')
    if (!isUntitled && tab.content === tab.savedContent) {
      message.info('没有需要保存的更改')
      return
    }

    try {
      if (isUntitled) {
        const result = await window.electronAPI.saveLocalFileDialog({
          content: tab.content,
          defaultPath: tab.path,
          rootPath: localRoot || undefined
        })
        if (!result) return

        const nextPath =
          result.rootPath && localRoot ? result.filePath : result.absPath

        if (result.rootPath && localRoot) {
          await loadTree(false)
          revealInTree(nextPath)
        }

        const oldPath = tab.path
        setTabs((prev) =>
          prev.map((t) =>
            t.path === oldPath
              ? {
                  ...t,
                  path: nextPath,
                  savedContent: t.content,
                  language: result.language || t.language,
                  preview: false,
                  isLocal: true
                }
              : t
          )
        )
        setActivePath(nextPath)
        message.success('已保存')
        return
      }

      if (tab.isLocal || localRoot || isFilesystemAbsolute(tab.path)) {
        const absolute = isFilesystemAbsolute(tab.path)
        await window.electronAPI.writeLocalFile({
          // 绝对路径（另存为工作区外）不得再带 rootPath，避免 resolveSafe 拼错
          rootPath: absolute ? undefined : localRoot || undefined,
          filePath: tab.path,
          content: tab.content
        })
        setTabs((prev) =>
          prev.map((t) =>
            t.path === tab.path ? { ...t, savedContent: t.content } : t
          )
        )
        message.success('已保存')
      } else {
        if (!repoUrl?.trim()) {
          message.warning('请先选择工作区或者打开项目后再保存')
          return
        }
        await window.electronAPI.writeRepoFile({
          repoUrl,
          branch,
          mcpServerId,
          filePath: tab.path,
          content: tab.content
        })
        setTabs((prev) =>
          prev.map((t) =>
            t.path === tab.path ? { ...t, savedContent: t.content } : t
          )
        )
        message.success('已保存到本地缓存（未推送到远程仓库）')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    }
  }, [
    tabs,
    activePath,
    repoUrl,
    branch,
    mcpServerId,
    localRoot,
    revealInTree
  ])

  const openUntitled = useCallback((): void => {
    setForceShowEditor(true)
    let path = 'Untitled-1'
    setTabs((prev) => {
      const existing = prev.find((t) => t.path.startsWith('Untitled-') && !t.content)
      if (existing && prev.length === 1) {
        path = existing.path
        return prev
      }
      const n = prev.filter((t) => t.path.startsWith('Untitled-')).length + 1
      path = `Untitled-${n}`
      return [
        ...prev,
        {
          path,
          content: '',
          savedContent: '',
          language: 'plaintext',
          preview: false
        }
      ]
    })
    setActivePath(path)
  }, [])

  const openLocalFolder = useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openLocalFolder()
      if (!result) return
      setWorkspaceClosed(false)
      setForceShowEditor(false)
      setLocalRoot(result.rootPath)
      applyWorkspaceFiles(result.files, result.rootLabel)
      rememberLocalProject(result.rootPath, result.rootLabel)
      setTabs([])
      setActivePath(null)
      setCreateDraft(null)
      message.success(`已打开文件夹：${result.rootLabel}`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '打开文件夹失败')
    }
  }, [rememberLocalProject])

  const closeWorkspace = useCallback(() => {
    setWorkspaceClosed(true)
    setForceShowEditor(false)
    setLocalRoot('')
    setFiles([])
    setRootLabel('')
    setExpandedKeys([])
    setTreeSelected([])
    setCreateDraft(null)
    setTabs([
      {
        path: 'Untitled-1',
        content: '',
        savedContent: '',
        language: 'plaintext',
        preview: false
      }
    ])
    setActivePath('Untitled-1')
    message.success('已移除项目')
  }, [])

  const openRecentProject = useCallback(
    async (item: RecentIdeProject): Promise<void> => {
      try {
        if (item.kind === 'local') {
          if (!item.localPath) return
          const listed = await window.electronAPI.listLocalFolder(item.localPath)
          setWorkspaceClosed(false)
          setForceShowEditor(false)
          setLocalRoot(listed.rootPath)
          applyWorkspaceFiles(listed.files, listed.rootLabel)
          rememberLocalProject(listed.rootPath, listed.rootLabel)
          setTabs([])
          setActivePath(null)
          setCreateDraft(null)
          message.success(`已打开：${listed.rootLabel}`)
          return
        }

        setLocalRoot('')
        setWorkspaceClosed(false)
        setForceShowEditor(false)
        setCreateDraft(null)
        if (item.pipelineId && config) {
          const stillExists = (config.reviewPipelines ?? []).some(
            (p) => p.id === item.pipelineId
          )
          if (!stillExists) {
            await persistRecent(
              removeRecentByPipelineId(config.recentIdeProjects ?? [], item.pipelineId)
            )
            message.warning('该流水线已删除，已从最近打开中移除')
            return
          }
          await saveConfig({ ...config, activePipelineId: item.pipelineId })
          navigate(`/review/editor?pipelineId=${encodeURIComponent(item.pipelineId)}`)
        } else if (item.repoUrl) {
          const q = new URLSearchParams()
          q.set('repoUrl', item.repoUrl)
          if (item.branch) q.set('branch', item.branch)
          if (item.mcpServerId) q.set('mcpServerId', item.mcpServerId)
          navigate(`/review/editor?${q.toString()}`)
        }
        if (config) {
          const next = rememberRecentIdeProject(config.recentIdeProjects ?? [], {
            ...item,
            id: item.id
          })
          await persistRecent(next)
        }
      } catch (e) {
        message.error(e instanceof Error ? e.message : '打开项目失败')
      }
    },
    [config, saveConfig, navigate, rememberLocalProject, persistRecent]
  )

  const removeRecent = useCallback(
    (id: string, e?: ReactMouseEvent) => {
      e?.stopPropagation()
      e?.preventDefault()
      if (!config) return
      void persistRecent(removeRecentIdeProject(config.recentIdeProjects ?? [], id))
    },
    [config, persistRecent]
  )

  const getCreateParent = useCallback((): string => {
    const key = treeSelected[0] || activePath || ''
    if (!key || key.startsWith('Untitled-')) return ''
    const entry = files.find((f) => f.path === key)
    if (entry?.type === 'dir') return entry.path
    const parts = key.split('/')
    parts.pop()
    return parts.join('/')
  }, [treeSelected, activePath, files])

  const beginCreate = useCallback(
    (kind: 'file' | 'dir') => {
      if (!localRoot && !repoUrl?.trim()) {
        message.warning('请先选择工作区或者打开项目')
        return
      }
      const parent = getCreateParent()
      if (parent) {
        setExpandedKeys((prev) => {
          const next = new Set(prev.map(String))
          next.add(parent)
          for (const d of parent.split('/').reduce<string[]>((acc, part) => {
            const p = acc.length ? `${acc[acc.length - 1]}/${part}` : part
            acc.push(p)
            return acc
          }, [])) {
            next.add(d)
          }
          return Array.from(next)
        })
      }
      setCreateDraft({
        kind,
        parent,
        name: kind === 'file' ? 'untitled' : '新建文件夹'
      })
      setExplorerOpen(true)
    },
    [localRoot, repoUrl, getCreateParent]
  )

  const cancelCreate = useCallback(() => {
    createIgnoreBlurRef.current = true
    setCreateDraft(null)
  }, [])

  const confirmCreate = useCallback(async () => {
    if (createBusyRef.current) return
    if (!createDraft) return
    const name = createDraft.name.trim().replace(/[\\/]/g, '')
    if (!name) {
      setCreateDraft(null)
      return
    }
    if (name.includes('..')) {
      message.warning('非法名称')
      return
    }
    const fullPath = createDraft.parent ? `${createDraft.parent}/${name}` : name
    if (files.some((f) => f.path === fullPath)) {
      message.warning('已存在同名项')
      return
    }
    createBusyRef.current = true
    try {
      if (createDraft.kind === 'dir') {
        if (localRoot) {
          await window.electronAPI.createLocalDir({
            rootPath: localRoot,
            dirPath: fullPath
          })
        } else {
          await window.electronAPI.createRepoDir({
            repoUrl,
            branch,
            mcpServerId,
            dirPath: fullPath
          })
        }
        setCreateDraft(null)
        await loadTree(false)
        setExpandedKeys((prev) =>
          Array.from(new Set([...prev.map(String), fullPath]))
        )
        setTreeSelected([fullPath])
        message.success('已创建文件夹')
        return
      }

      if (localRoot) {
        await window.electronAPI.writeLocalFile({
          rootPath: localRoot,
          filePath: fullPath,
          content: ''
        })
      } else {
        await window.electronAPI.writeRepoFile({
          repoUrl,
          branch,
          mcpServerId,
          filePath: fullPath,
          content: ''
        })
      }
      setCreateDraft(null)
      await loadTree(false)
      await openFile(fullPath, 'pin')
      message.success('已创建文件')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败')
    } finally {
      createBusyRef.current = false
    }
  }, [
    createDraft,
    files,
    localRoot,
    repoUrl,
    branch,
    mcpServerId,
    openFile
  ])

  useEffect(() => {
    if (!createDraft) return
    const t = window.setTimeout(() => {
      createInputRef.current?.focus()
      createInputRef.current?.select()
    }, 30)
    return () => window.clearTimeout(t)
  }, [createDraft])

  const onTreeClick = (path: string, isLeaf: boolean): void => {
    if (!isLeaf) return
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      void openFile(path, 'pin')
      return
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      void openFile(path, 'preview')
    }, 220)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        if (!hasWorkspace) {
          message.warning('请先选择工作区或者打开项目')
          return
        }
        setQuickOpen(true)
        return
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openUntitled()
        return
      }
      if (meta && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openLocalFolder()
        return
      }
      if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveActiveFile()
        return
      }
      if (meta && e.key.toLowerCase() === 'w') {
        if (!activePath) return
        e.preventDefault()
        closeTab(activePath)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    activePath,
    closeTab,
    saveActiveFile,
    openUntitled,
    openLocalFolder,
    hasWorkspace
  ])

  const onSidebarResizeStart = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    const onMove = (ev: MouseEvent): void => {
      const next = Math.min(480, Math.max(180, startW + (ev.clientX - startX)))
      setSidebarWidth(next)
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const goReview = (): void => {
    const id = pipeline?.id || pipelineId
    navigate(id ? `/review?board=1&pipelineId=${encodeURIComponent(id)}` : '/review')
  }

  const repoShort = hasWorkspace
    ? rootLabel ||
      (localRoot ? localRoot.split(/[/\\]/).pop() : '') ||
      (repoUrl || '').split('/').pop() ||
      'PROJECT'
    : ''
  const showWelcome =
    !forceShowEditor &&
    (!activeTab ||
      (!hasWorkspace &&
        activeTab.path.startsWith('Untitled-') &&
        !activeTab.content))

  /** 无工作区时默认打开未命名编辑页 */
  useEffect(() => {
    if (hasWorkspace) return
    setTabs((prev) => {
      if (prev.length) return prev
      return [
        {
          path: 'Untitled-1',
          content: '',
          savedContent: '',
          language: 'plaintext',
          preview: false
        }
      ]
    })
    setActivePath((cur) => cur || 'Untitled-1')
  }, [hasWorkspace])

  /** 远程仓库仅有 create API，无 rename/delete */
  const explorerFs = useMemo((): ExplorerFsAdapter | undefined => {
    if (localRoot) return createLocalFsAdapter(localRoot)
    if (!repoUrl?.trim()) return undefined
    return {
      createFile: async (relPath) => {
        await window.electronAPI.writeRepoFile({
          repoUrl,
          branch,
          mcpServerId,
          filePath: relPath,
          content: ''
        })
      },
      createDir: async (relPath) => {
        await window.electronAPI.createRepoDir({
          repoUrl,
          branch,
          mcpServerId,
          dirPath: relPath
        })
      }
    }
  }, [localRoot, repoUrl, branch, mcpServerId])

  return (
    <div className="page repo-editor-page">
      <div
        ref={shellRef}
        className="repo-browser-shell is-editor repo-editor-shell"
        style={{ ['--repo-sidebar-w' as string]: `${sidebarWidth}px` }}
      >
        <aside className="repo-browser-nav">
          <div className="repo-side-section">
            <button
              type="button"
              className="repo-side-section-head"
              onClick={() => setOpenEditorsOpen((v) => !v)}
            >
              <span className={`repo-side-chevron ${openEditorsOpen ? 'open' : ''}`} />
              打开编辑器
              <span className="repo-side-count">{tabs.length}</span>
            </button>
            {openEditorsOpen ? (
              <div className="repo-open-editors">
                {tabs.length === 0 ? (
                  <div className="repo-open-editors-empty">
                    无活动编辑器
                  </div>
                ) : (
                  tabs.map((tab) => (
                    <button
                      key={tab.path}
                      type="button"
                      className={`repo-open-editor-item ${
                        tab.path === activePath ? 'active' : ''
                      } ${tab.preview ? 'is-preview' : ''}`}
                      title={tab.path}
                      onClick={() => setActivePath(tab.path)}
                      onDoubleClick={() =>
                        setTabs((prev) =>
                          prev.map((t) =>
                            t.path === tab.path ? { ...t, preview: false } : t
                          )
                        )
                      }
                    >
                      <span className="repo-open-editor-icon">
                        <FileTypeIcon name={tab.path} />
                      </span>
                      <span className="repo-open-editor-name">
                        {tab.content !== tab.savedContent ? '● ' : ''}
                        {tab.path.split(/[/\\]/).pop()}
                      </span>
                      <span
                        className="repo-open-editor-close"
                        role="button"
                        tabIndex={0}
                        title="关闭"
                        onClick={(e) => closeTab(tab.path, e)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') closeTab(tab.path)
                        }}
                      >
                        <CloseOutlined />
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="repo-side-section is-grow">
            <div className="repo-side-section-head">
              <button
                type="button"
                className="repo-side-section-toggle"
                onClick={() => setExplorerOpen((v) => !v)}
              >
                <span className={`repo-side-chevron ${explorerOpen ? 'open' : ''}`} />
                资源管理器
              </button>
              <div className="repo-browser-nav-actions">
                <Tooltip title="快速打开（⌘P）" mouseEnterDelay={0.2}>
                  <span className="repo-side-action-wrap">
                    <button
                      type="button"
                      className={`repo-side-action${quickOpen ? ' is-active' : ''}`}
                      disabled={!hasWorkspace}
                      aria-label="快速打开"
                      onClick={() => setQuickOpen(true)}
                    >
                      <SearchOutlined />
                    </button>
                  </span>
                </Tooltip>
                <Tooltip title="新建文件" mouseEnterDelay={0.2}>
                  <button
                    type="button"
                    className="repo-side-action"
                    onClick={() => beginCreate('file')}
                  >
                    <FileAddOutlined />
                  </button>
                </Tooltip>
                <Tooltip title="新建文件夹" mouseEnterDelay={0.2}>
                  <button
                    type="button"
                    className="repo-side-action"
                    onClick={() => beginCreate('dir')}
                  >
                    <FolderAddOutlined />
                  </button>
                </Tooltip>
                <Tooltip
                  title={
                    !hasWorkspace
                      ? '刷新'
                      : localRoot
                        ? '刷新文件夹'
                        : '同步仓库'
                  }
                  mouseEnterDelay={0.2}
                >
                  <span className="repo-side-action-wrap">
                    <button
                      type="button"
                      className="repo-side-action"
                      disabled={!hasWorkspace}
                      onClick={() => void loadTree(true)}
                    >
                      <ReloadOutlined spin={loading} />
                    </button>
                  </span>
                </Tooltip>
                <Tooltip title="全部折叠" mouseEnterDelay={0.2}>
                  <span className="repo-side-action-wrap">
                    <button
                      type="button"
                      className="repo-side-action"
                      disabled={!hasWorkspace}
                      onClick={() => setExpandedKeys([])}
                    >
                      <ShrinkOutlined />
                    </button>
                  </span>
                </Tooltip>
              </div>
            </div>
            {explorerOpen ? (
              <>
                {hasWorkspace ? (
                  <div className="repo-browser-nav-head">
                    <div className="repo-browser-nav-row">
                      <div
                        className="repo-browser-nav-title"
                        title={localRoot || repoUrl}
                      >
                        {repoShort.toUpperCase()}
                      </div>
                      <Tooltip title="移除项目" mouseEnterDelay={0.2}>
                        <button
                          type="button"
                          className="repo-side-action"
                          onClick={closeWorkspace}
                        >
                          <CloseOutlined />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ) : null}
                <ExplorerContextMenu
                  className="repo-browser-tree"
                  rootPath={localRoot}
                  fs={explorerFs}
                  target={ctxTarget}
                  onTargetChange={setCtxTarget}
                  onOpenFile={(path) => void openFile(path, 'pin')}
                  onRefresh={() => void loadTree(true)}
                  onOpenFolder={() => void openLocalFolder()}
                  onCollapseAll={() => setExpandedKeys([])}
                  onAfterCreate={({ kind, path }) => {
                    setExpandedKeys((prev) =>
                      Array.from(
                        new Set([
                          ...prev.map(String),
                          ...parentDirsOf(path),
                          ...(kind === 'dir' ? [path] : [])
                        ])
                      )
                    )
                    if (kind === 'file') void openFile(path, 'pin')
                  }}
                  onAfterRename={({ from, to, isDir }) => {
                    setTabs((prev) =>
                      prev.map((t) => {
                        if (t.path === from) return { ...t, path: to }
                        if (isDir && t.path.startsWith(`${from}/`)) {
                          return {
                            ...t,
                            path: `${to}${t.path.slice(from.length)}`
                          }
                        }
                        return t
                      })
                    )
                    setActivePath((cur) => {
                      if (cur === from) return to
                      if (isDir && cur?.startsWith(`${from}/`)) {
                        return `${to}${cur.slice(from.length)}`
                      }
                      return cur
                    })
                  }}
                  onAfterDelete={({ path, isDir }) => {
                    setTabs((prev) =>
                      prev.filter((t) => {
                        if (t.path === path) return false
                        if (isDir && t.path.startsWith(`${path}/`)) return false
                        return true
                      })
                    )
                    setActivePath((cur) => {
                      if (!cur) return cur
                      if (cur === path) return null
                      if (isDir && cur.startsWith(`${path}/`)) return null
                      return cur
                    })
                  }}
                >
                  {!hasWorkspace ? (
                    <div className="repo-explorer-empty" />
                  ) : loading ? (
                    <div className="repo-browser-loading">
                      <Spin
                        tip={localRoot ? '正在读取文件夹…' : '正在拉取仓库…'}
                      />
                    </div>
                  ) : (
                    <>
                      {createDraft ? (
                        <div className="repo-create-row">
                          {createDraft.kind === 'file' ? (
                            <FileOutlined className="repo-file-icon" />
                          ) : (
                            <FolderOutlined className="repo-folder-icon" />
                          )}
                          <input
                            ref={createInputRef}
                            className="repo-create-input"
                            value={createDraft.name}
                            spellCheck={false}
                            onChange={(e) =>
                              setCreateDraft((d) =>
                                d ? { ...d, name: e.target.value } : d
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                void confirmCreate()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelCreate()
                              }
                            }}
                            onBlur={() => {
                              if (createIgnoreBlurRef.current) {
                                createIgnoreBlurRef.current = false
                                return
                              }
                              void confirmCreate()
                            }}
                          />
                        </div>
                      ) : null}
                      {treeData.length ? (
                        <Tree
                          showIcon
                          className="repo-explorer-tree"
                          treeData={treeData}
                          selectedKeys={
                            treeSelected.length
                              ? treeSelected
                              : activePath
                                ? [activePath]
                                : []
                          }
                          expandedKeys={expandedKeys}
                          onExpand={(keys) => setExpandedKeys(keys)}
                          onSelect={(keys, info) => {
                            const key = String(
                              keys[0] || info.node.key || ''
                            )
                            if (!key) return
                            setTreeSelected([key])
                            onTreeClick(key, Boolean(info.node.isLeaf))
                          }}
                          onRightClick={({ node }) => {
                            const key = String(node.key ?? '')
                            if (!key) {
                              setCtxTarget(null)
                              return
                            }
                            setCtxTarget({
                              path: key,
                              isDir: !node.isLeaf
                            })
                          }}
                        />
                      ) : null}
                    </>
                  )}
                </ExplorerContextMenu>
              </>
            ) : null}
          </div>
          <div
            className="repo-sidebar-resizer"
            onMouseDown={onSidebarResizeStart}
            role="separator"
            aria-orientation="vertical"
          />
        </aside>

        <main className="repo-browser-panel">
          <div className="repo-browser-editor-chrome">
            <div className="repo-browser-tabs">
              {tabs.length === 0 ? (
                <div className="repo-browser-tab is-idle">Editor</div>
              ) : (
                tabs.map((tab) => (
                  <div
                    key={tab.path}
                    role="tab"
                    tabIndex={0}
                    className={`repo-browser-tab ${
                      tab.path === activePath ? 'is-active' : ''
                    } ${tab.preview ? 'is-preview' : ''} ${
                      tab.content !== tab.savedContent ? 'is-dirty' : ''
                    }`}
                    title={tab.path}
                    onClick={() => setActivePath(tab.path)}
                    onDoubleClick={() =>
                      setTabs((prev) =>
                        prev.map((t) =>
                          t.path === tab.path ? { ...t, preview: false } : t
                        )
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setActivePath(tab.path)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      closeOtherTabs(tab.path)
                    }}
                  >
                    <span className="repo-browser-tab-icon">
                      <FileTypeIcon name={tab.path} />
                    </span>
                    <span className="repo-browser-tab-name">
                      {tab.path.split(/[/\\]/).pop()}
                    </span>
                    <button
                      type="button"
                      className="repo-browser-tab-close"
                      title="关闭"
                      onClick={(e) => closeTab(tab.path, e)}
                    >
                      {tab.content !== tab.savedContent ? (
                        <>
                          <span className="repo-tab-dirty-dot" />
                          <CloseOutlined />
                        </>
                      ) : (
                        <CloseOutlined />
                      )}
                    </button>
                  </div>
                ))
              )}
            </div>

            {activeTab && !showWelcome ? (
              loadingPath === activeTab.path ? (
                <div className="repo-browser-viewer">
                  <div className="repo-browser-loading">
                    <Spin tip="打开文件…" />
                  </div>
                </div>
              ) : (
                <WorkspaceEditor
                  path={activeTab.path}
                  value={activeTab.content}
                  language={activeTab.language}
                  dirty={activeTab.content !== activeTab.savedContent}
                  onChange={(v) => onEditContent(activeTab.path, v)}
                  onSave={() => void saveActiveFile()}
                  onLanguageChange={(lang) => {
                    setTabs((prev) =>
                      prev.map((t) =>
                        t.path === activeTab.path && t.language !== lang
                          ? { ...t, language: lang }
                          : t
                      )
                    )
                  }}
                  statusLeft={
                    <>
                      {branch ? (
                        <span className="repo-status-item">⎇ {branch}</span>
                      ) : null}
                      {!localRoot && repoUrl?.trim() ? (
                        <span
                          className="repo-status-item"
                          title="远程浏览模式：保存仅写入本机临时克隆目录，不会 push 到远端"
                        >
                          本地缓存
                        </span>
                      ) : null}
                    </>
                  }
                />
              )
            ) : (
              <>
                <div className="repo-browser-viewer">
                  <div className="repo-start">
                    <div
                      className={`repo-start-board ${
                        recentProjectsView.length ? 'has-recent' : ''
                      }`}
                    >
                      <section className="repo-start-hero">
                        <div className="repo-start-brand">
                          <img
                            className="repo-start-logo"
                            src={brandMark}
                            alt=""
                            width={40}
                            height={40}
                          />
                          <div className="repo-start-brand-text">
                            <span className="repo-start-product">Code Reviewer</span>
                            <span className="repo-start-eyebrow">Editor</span>
                          </div>
                        </div>
                        <h2 className="repo-start-title">从一处空白开始</h2>
                        <p className="repo-start-desc">
                          {hasWorkspace
                            ? '从资源管理器打开文件，或新建一个草稿继续写。'
                            : '打开本地文件夹作为工作区，或先写草稿稍后再接上代码源。'}
                        </p>
                        <div className="repo-start-actions">
                          <button
                            type="button"
                            className="repo-start-primary"
                            onClick={() => void openLocalFolder()}
                          >
                            打开文件夹
                          </button>
                          <button
                            type="button"
                            className="repo-start-secondary"
                            onClick={openUntitled}
                          >
                            新建文件
                          </button>
                          {hasWorkspace ? (
                            <button
                              type="button"
                              className="repo-start-secondary"
                              onClick={() => setQuickOpen(true)}
                            >
                              快速打开
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="repo-start-secondary"
                              onClick={goReview}
                            >
                              配置代码源
                            </button>
                          )}
                        </div>
                        <div className="repo-start-shortcuts">
                          <span>
                            <kbd>⌘O</kbd> 打开文件夹
                          </span>
                          <span>
                            <kbd>⌘P</kbd> 快速打开
                          </span>
                          <span>
                            <kbd>⌘N</kbd> 新建
                          </span>
                          <span>
                            <kbd>⌘S</kbd> 保存
                          </span>
                          <span>
                            <kbd>⌘W</kbd> 关闭
                          </span>
                        </div>
                      </section>

                      <section className="repo-start-recent">
                        <div className="repo-start-recent-head">
                          <div>
                            <div className="repo-start-recent-title">最近打开</div>
                            <p className="repo-start-recent-hint">
                              {recentProjectsView.length
                                ? '点击继续，或移除不需要的项'
                                : '打开过的本地与流水线项目会出现在这里'}
                            </p>
                          </div>
                          {recentProjectsView.length ? (
                            <span className="repo-start-recent-count">
                              {recentProjectsView.length}
                            </span>
                          ) : null}
                        </div>
                        {recentProjectsView.length ? (
                          <ul className="repo-start-recent-list">
                            {recentProjectsView.map((item) => {
                              const { title, subtitle } = recentProjectDisplay(item)
                              return (
                                <li key={item.id}>
                                  <button
                                    type="button"
                                    className="repo-start-recent-item"
                                    title={`${title}\n${subtitle}`}
                                    onClick={() => void openRecentProject(item)}
                                  >
                                    <span
                                      className={`repo-start-recent-icon is-${item.kind}`}
                                      aria-hidden
                                    >
                                      {item.kind === 'local' ? (
                                        <FolderOpenOutlined />
                                      ) : (
                                        <FolderOutlined />
                                      )}
                                    </span>
                                    <span className="repo-start-recent-text">
                                      <span className="repo-start-recent-name">
                                        {title}
                                      </span>
                                      <span className="repo-start-recent-meta">
                                        <span className="repo-start-recent-kind">
                                          {item.kind === 'local' ? '本地' : '流水线'}
                                        </span>
                                        <span className="repo-start-recent-sub">
                                          {item.kind === 'local'
                                            ? subtitle
                                            : `${item.pipelineName || '流水线'} ${title}`}
                                        </span>
                                      </span>
                                    </span>
                                  </button>
                                  <Tooltip title="从列表移除" mouseEnterDelay={0.2}>
                                    <button
                                      type="button"
                                      className="repo-start-recent-remove"
                                      onClick={(e) => removeRecent(item.id, e)}
                                    >
                                      <CloseOutlined />
                                    </button>
                                  </Tooltip>
                                </li>
                              )
                            })}
                          </ul>
                        ) : (
                          <div className="repo-start-recent-empty">暂无记录</div>
                        )}
                      </section>
                    </div>
                  </div>
                </div>
                <div className="repo-browser-statusbar">
                  <div className="repo-status-left">
                    <span
                      className="repo-status-item"
                      title={localRoot || rootLabel || repoUrl || '未打开工作区'}
                    >
                      {hasWorkspace ? rootLabel || repoShort : '未打开工作区'}
                    </span>
                  </div>
                  <div className="repo-status-right">
                    <span className="repo-status-item">就绪</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      <QuickOpenDialog
        open={quickOpen}
        files={fileEntries}
        onClose={() => setQuickOpen(false)}
        onSelect={(path) => {
          setQuickOpen(false)
          void openFile(path, 'pin')
        }}
      />
    </div>
  )
}

export default RepoEditorPage
