import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Modal,
  Progress,
  Segmented,
  Select,
  message
} from 'antd'
import type { MenuProps } from 'antd'
import {
  ArrowLeftOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  FileTextOutlined,
  FilterOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { randomUUID } from './id'
import FlowTimeline, { formatDuration } from '../components/FlowTimeline'
import PipeFlowEdges from '../components/PipeFlowEdges'
import {
  patchRecentPipelineMeta,
  removeRecentByPipelineId
} from '../lib/recentIdeProjects'
import { useAppStore } from '../store/useAppStore'
import { formatDateTime } from '../../../shared/datetime'
import { shortRepo as formatShortRepo } from '../../../shared/repo-path'
import {
  FALLBACK_REVIEW_METHOD_CATALOG,
  type ReviewMethodDef
} from '../../../shared/review-methods'
import {
  DEFAULT_BATCH_REVIEW_CONCURRENCY,
  clampBatchReviewConcurrency
} from '../../../shared/batch-concurrency'
import type {
  ExtAppRepoOption,
  ExtAppRepoSourceOption,
  ReportOutputFormat,
  ReviewPipeline,
  ReviewReport
} from '../../../shared/types'
import type { SettingsSection } from './ConfigPage'

const newPipeline = (name: string, repoUrl = ''): ReviewPipeline => ({
  id: randomUUID(),
  name,
  repoUrl,
  methodIds: [],
  llmProviderId: '',
  reportFormats: ['md', 'html'],
  updatedAt: new Date().toISOString()
})

/** 流水线展示名：空仓库时回落「未配置仓库」 */
const shortRepo = (url: string): string => formatShortRepo(url, '未配置仓库')

/** 运行历史时长：优先中文分秒 */
const formatHistoryDuration = (ms?: number): string => {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}毫秒`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}秒`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s ? `${m}分${s}秒` : `${m}分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}小时${rm}分` : `${h}小时`
}

const historyStatusMeta = (
  status: ReviewReport['status']
): { label: string; tone: 'ok' | 'fail' | 'run' | 'idle' } => {
  switch (status) {
    case 'completed':
      return { label: '运行成功', tone: 'ok' }
    case 'failed':
      return { label: '运行失败', tone: 'fail' }
    case 'cancelled':
      return { label: '已取消', tone: 'fail' }
    case 'running':
    case 'pending':
      return { label: status === 'pending' ? '等待中' : '运行中', tone: 'run' }
    default:
      return { label: status, tone: 'idle' }
  }
}

const shortCommit = (sha?: string): string => {
  const s = (sha || '').trim()
  if (!s) return ''
  return s.length > 8 ? s.slice(0, 8) : s
}

const FAVORITE_PIPELINES_KEY = 'cr.favoritePipelineIds'
const LAST_RUN_CONFIG_KEY = 'cr.lastRunConfigByPipeline'
const RUN_NOTE_MAX = 300

type LastRunConfig = {
  branch?: string
  runNote?: string
  autofill?: boolean
}

const readFavoritePipelineIds = (): string[] => {
  try {
    let raw = localStorage.getItem(FAVORITE_PIPELINES_KEY)
    if (!raw) {
      // 兼容旧版 sessionStorage
      raw = sessionStorage.getItem(FAVORITE_PIPELINES_KEY)
      if (raw) {
        localStorage.setItem(FAVORITE_PIPELINES_KEY, raw)
        sessionStorage.removeItem(FAVORITE_PIPELINES_KEY)
      }
    }
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

const readLastRunConfigMap = (): Record<string, LastRunConfig> => {
  try {
    const raw = localStorage.getItem(LAST_RUN_CONFIG_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, LastRunConfig>)
      : {}
  } catch {
    return {}
  }
}

const writeLastRunConfig = (pipelineId: string, cfg: LastRunConfig): void => {
  try {
    const map = readLastRunConfigMap()
    map[pipelineId] = cfg
    localStorage.setItem(LAST_RUN_CONFIG_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

type DashboardProps = {
  onOpenSettings?: (section?: SettingsSection) => void
}

const Dashboard = ({ onOpenSettings }: DashboardProps): JSX.Element => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const loading = useAppStore((s) => s.loading)
  const batchRunning = useAppStore((s) => s.batchRunning)
  const currentReport = useAppStore((s) => s.currentReport)
  const history = useAppStore((s) => s.history)
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const startReview = useAppStore((s) => s.startReview)
  const startBatchReview = useAppStore((s) => s.startBatchReview)
  const cancelReview = useAppStore((s) => s.cancelReview)
  const loadReport = useAppStore((s) => s.loadReport)

  const pipelines = config?.reviewPipelines ?? []
  const activeId = config?.activePipelineId || pipelines[0]?.id
  const active = pipelines.find((p) => p.id === activeId) || pipelines[0]

  /**
   * 进入「新建审查」默认空白页；只有点「新建流水线」或打开已有流水线后才展示看板。
   * 看板开关/页签会写入 sessionStorage，从 IDE/其它页返回时可恢复。
   */
  const [boardVisible, setBoardVisible] = useState(false)
  /** 流程配置 = 编辑布局；最近运行 = 流程图；运行历史 = 本流水线报告列表 */
  const [boardTab, setBoardTab] = useState<'config' | 'run' | 'history'>('config')

  /** 有流水线时的「我的流水线」列表态 */
  const [pipeListTab, setPipeListTab] = useState<'joined' | 'favorites'>('joined')
  const [pipeListView, setPipeListView] = useState<'brief' | 'detail'>('brief')
  const [pipeListQuery, setPipeListQuery] = useState('')
  const [pipeSearchOpen, setPipeSearchOpen] = useState(false)
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readFavoritePipelineIds())
  const [selectedPipeIds, setSelectedPipeIds] = useState<string[]>([])

  const [runConfigOpen, setRunConfigOpen] = useState(false)
  const [runConfigPipeline, setRunConfigPipeline] = useState<ReviewPipeline | null>(
    null
  )
  const [runDraft, setRunDraft] = useState({
    branch: '',
    runNote: '',
    autofill: true
  })
  const [runBranchOptions, setRunBranchOptions] = useState<string[]>([])
  const [runBranchLoading, setRunBranchLoading] = useState(false)

  const [sourceOpen, setSourceOpen] = useState(false)
  const [methodsOpen, setMethodsOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [draftSource, setDraftSource] = useState({
    repoUrl: '',
    branch: '',
    prNumber: '',
    workDir: '',
    providerId: ''
  })
  const [draftMethods, setDraftMethods] = useState<string[]>([])
  const [draftProviderId, setDraftProviderId] = useState('')
  const [draftFormats, setDraftFormats] = useState<ReportOutputFormat[]>(['md', 'html'])
  const [extRepos, setExtRepos] = useState<ExtAppRepoOption[]>([])
  const [extSources, setExtSources] = useState<ExtAppRepoSourceOption[]>([])
  const [extRepoLoading, setExtRepoLoading] = useState(false)
  const [extRepoRefreshing, setExtRepoRefreshing] = useState(false)
  const [extRepoHint, setExtRepoHint] = useState('')
  const extRepoLoadSeq = useRef(0)
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [sourceMode, setSourceMode] = useState<'custom' | 'repo'>('repo')
  const [branchOptions, setBranchOptions] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchHint, setBranchHint] = useState('')
  const [methodCatalog, setMethodCatalog] = useState<ReviewMethodDef[]>(
    FALLBACK_REVIEW_METHOD_CATALOG
  )
  const [nameDraft, setNameDraft] = useState('')
  const boardRef = useRef<HTMLDivElement>(null)

  const loadMethodCatalog = async () => {
    try {
      const list = await window.electronAPI.cloudReviewMethods()
      if (list?.length) setMethodCatalog(list)
    } catch {
      // 离线沿用本地兜底
    }
  }

  useEffect(() => {
    void loadMethodCatalog()
  }, [])

  const extSourceOptions = useMemo(() => {
    if (extSources.length <= 1) {
      return extSources.map((s) => ({
        value: s.providerId,
        label: s.accountLabel
          ? `${s.providerName}（${s.accountLabel}）`
          : s.providerName
      }))
    }
    return [
      { value: 'all', label: `全部平台（${extSources.length}）` },
      ...extSources.map((s) => ({
        value: s.providerId,
        label: s.accountLabel
          ? `${s.providerName}（${s.accountLabel}）`
          : s.providerName
      }))
    ]
  }, [extSources])

  const extRepoSelectOptions = useMemo(() => {
    const filtered =
      sourceFilter === 'all'
        ? extRepos
        : extRepos.filter((r) => r.providerId === sourceFilter)

    const groups = new Map<string, ExtAppRepoOption[]>()
    for (const repo of filtered) {
      const key = repo.providerName || repo.providerId
      const list = groups.get(key) ?? []
      list.push(repo)
      groups.set(key, list)
    }

    return Array.from(groups.entries()).map(([label, list]) => ({
      label,
      options: list.map((repo) => ({
        value: `${repo.providerId}||${repo.url}`,
        label: repo.fullName || repo.name,
        url: repo.url,
        providerId: repo.providerId,
        branch: repo.defaultBranch
      }))
    }))
  }, [extRepos, sourceFilter])

  const flatExtRepoOptions = useMemo(
    () => extRepoSelectOptions.flatMap((g) => g.options),
    [extRepoSelectOptions]
  )

  const providers = (config?.llmProviders ?? []).filter((p) => p.enabled)

  const applyExtAppReposResult = (
    result: Awaited<ReturnType<typeof window.electronAPI.listExternalAppRepos>>
  ): ExtAppRepoOption[] => {
    setExtRepos(result.repos)
    setExtSources(result.sources)
    if (result.sources.length === 1) {
      setSourceFilter(result.sources[0].providerId)
    } else if (
      sourceFilter !== 'all' &&
      !result.sources.some((s) => s.providerId === sourceFilter)
    ) {
      setSourceFilter('all')
    }

    if (!result.sources.length) {
      setExtRepoHint(
        result.errors[0] ||
          '尚未连接任何代码仓库，请先到「设置 → 代码仓库」完成连接'
      )
    } else if (!result.repos.length) {
      setExtRepoHint(
        result.errors.length
          ? result.errors.join('；')
          : '已连接平台暂无仓库，请确认令牌权限包含仓库读取'
      )
    } else {
      const cacheNote = result.fromCache
        ? result.stale
          ? '（缓存，正在同步…）'
          : '（缓存）'
        : ''
      setExtRepoHint(
        `已加载 ${result.repos.length} 个仓库${cacheNote}` +
          (result.errors.length ? `；${result.errors.join('；')}` : '')
      )
    }
    return result.repos
  }

  const loadExtAppRepos = async (options?: {
    forceRefresh?: boolean
    /** 已有列表时不挡 UI，仅后台刷新 */
    silent?: boolean
  }): Promise<ExtAppRepoOption[]> => {
    const seq = ++extRepoLoadSeq.current
    const silent = Boolean(options?.silent)
    const forceRefresh = Boolean(options?.forceRefresh)
    if (silent) setExtRepoRefreshing(true)
    else setExtRepoLoading(true)
    if (!silent) setExtRepoHint('')
    try {
      const result = await window.electronAPI.listExternalAppRepos({
        forceRefresh
      })
      if (seq !== extRepoLoadSeq.current) return result.repos
      const repos = applyExtAppReposResult(result)

      // 命中缓存后后台静默刷新，拿到新仓库
      if (!forceRefresh && result.fromCache) {
        void loadExtAppRepos({ forceRefresh: true, silent: true })
      }
      return repos
    } catch (error) {
      if (seq !== extRepoLoadSeq.current) return []
      if (!silent) {
        setExtRepos([])
        setExtSources([])
        setExtRepoHint(error instanceof Error ? error.message : '加载代码仓库失败')
      }
      return []
    } finally {
      // 各自清自己的 loading，避免后台刷新抢掉序号后首屏 loading 卡死
      if (silent) setExtRepoRefreshing(false)
      else setExtRepoLoading(false)
    }
  }

  const loadExtAppBranches = async (
    providerId: string,
    repoUrl: string
  ): Promise<void> => {
    if (!providerId || !repoUrl.trim()) {
      setBranchOptions([])
      setBranchHint('')
      return
    }
    setBranchLoading(true)
    setBranchHint('')
    try {
      const result = await window.electronAPI.listExternalAppBranches({
        providerId,
        repoUrl
      })
      setBranchOptions(result.branches)
      if (result.branches.length) {
        setDraftSource((s) => {
          const keep =
            s.branch && result.branches.includes(s.branch) ? s.branch : result.branches[0]
          return { ...s, branch: keep }
        })
        setBranchHint(`共 ${result.branches.length} 个分支`)
      } else {
        setBranchHint(result.error || '未查到分支，可手动填写')
      }
    } catch (error) {
      setBranchOptions([])
      setBranchHint(error instanceof Error ? error.message : '加载分支失败')
    } finally {
      setBranchLoading(false)
    }
  }

  const persistPipelines = async (
    nextList: ReviewPipeline[],
    nextActiveId?: string
  ): Promise<void> => {
    if (!config) return
    await saveConfig({
      ...config,
      reviewPipelines: nextList,
      activePipelineId: nextActiveId ?? (nextList[0]?.id || '')
    })
  }

  const updateActive = async (patch: Partial<ReviewPipeline>): Promise<void> => {
    if (!active || !config) return
    const next = pipelines.map((p) =>
      p.id === active.id
        ? { ...p, ...patch, updatedAt: new Date().toISOString() }
        : p
    )
    const recentIdeProjects =
      typeof patch.name === 'string' && patch.name.trim()
        ? patchRecentPipelineMeta(config.recentIdeProjects ?? [], active.id, {
            pipelineName: patch.name.trim()
          })
        : config.recentIdeProjects
    await saveConfig({
      ...config,
      reviewPipelines: next,
      activePipelineId: active.id,
      recentIdeProjects
    })
  }

  const onAddPipeline = async (): Promise<void> => {
    if (!config) return
    const created = newPipeline(`流水线 ${pipelines.length + 1}`)
    if (config.activeLlmProviderId) created.llmProviderId = config.activeLlmProviderId
    await persistPipelines([...pipelines, created], created.id)
    setBoardTab('config')
    setBoardVisible(true)
    message.success('已新建流水线')
  }

  const onCopyPipeline = async (pipelineId: string): Promise<void> => {
    if (!config) return
    const source = pipelines.find((p) => p.id === pipelineId)
    if (!source) {
      message.warning('未找到要复制的流水线')
      return
    }
    const baseName = (source.name || shortRepo(source.repoUrl) || '未命名流水线').trim()
    const copied: ReviewPipeline = {
      ...source,
      id: randomUUID(),
      name: `${baseName} 副本`,
      methodIds: [...(source.methodIds ?? [])],
      reportFormats: [...(source.reportFormats ?? ['md', 'html'])],
      updatedAt: new Date().toISOString()
    }
    const insertAt = pipelines.findIndex((p) => p.id === pipelineId)
    const next =
      insertAt >= 0
        ? [
            ...pipelines.slice(0, insertAt + 1),
            copied,
            ...pipelines.slice(insertAt + 1)
          ]
        : [...pipelines, copied]
    await persistPipelines(next, copied.id)
    message.success('已复制流水线')
  }

  const isPipelineReady = (p?: ReviewPipeline | null): boolean => {
    if (!p || !config) return false
    return Boolean(
      p.repoUrl?.trim() &&
        p.methodIds?.length &&
        (p.llmProviderId || config.activeLlmProviderId) &&
        p.reportFormats?.length
    )
  }

  const onOpenPipeline = async (id: string): Promise<void> => {
    if (!config) return
    await persistPipelines(pipelines, id)
    // 点击流水线默认进入只读页；点「编辑」再进配置页
    setBoardTab('run')
    setBoardVisible(true)
  }

  /** 持久化看板状态（仅记录最近打开的流水线，不再自动恢复看板可见） */
  useEffect(() => {
    if (!active?.id) return
    try {
      sessionStorage.setItem(
        'cr.pipelineBoard',
        JSON.stringify({
          visible: boardVisible,
          tab: boardTab,
          pipelineId: active.id
        })
      )
    } catch {
      // ignore
    }
  }, [boardVisible, boardTab, active?.id])

  /** 侧栏「代码审查」带 home=1：强制回到流水线列表 / 空态 */
  useEffect(() => {
    if (!config) return
    if (searchParams.get('home') !== '1') return
    setBoardVisible(false)
    setSearchParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, config])

  /** 深链 ?board=1 时打开指定流水线看板（如从 IDE 显式带参进入） */
  useEffect(() => {
    if (!config) return
    if (searchParams.get('board') !== '1') return
    const candidate =
      searchParams.get('pipelineId') || activeId || pipelines[0]?.id || ''
    const id = pipelines.some((p) => p.id === candidate)
      ? candidate
      : pipelines[0]?.id || ''
    if (!id) {
      setSearchParams({}, { replace: true })
      return
    }
    void (async () => {
      await persistPipelines(pipelines, id)
      setBoardTab('run')
      setBoardVisible(true)
      setSearchParams({}, { replace: true })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, config])

  const removePipeline = async (pipelineId: string): Promise<void> => {
    if (!config) return
    const next = pipelines.filter((p) => p.id !== pipelineId)
    const nextActive =
      activeId === pipelineId ? next[0]?.id || '' : activeId || next[0]?.id || ''
    const recentIdeProjects = removeRecentByPipelineId(
      config.recentIdeProjects ?? [],
      pipelineId
    )
    await saveConfig({
      ...config,
      reviewPipelines: next,
      activePipelineId: nextActive,
      recentIdeProjects
    })
    if (!next.length) setBoardVisible(false)
    message.success(next.length ? '已删除流水线' : '已清空，可重新新建')
  }

  const onDeletePipeline = (pipelineId?: string): void => {
    const id = pipelineId || active?.id
    if (!id) return
    const target = pipelines.find((p) => p.id === id)
    const label = target?.name || (target?.repoUrl ? shortRepo(target.repoUrl) : '该流水线')
    Modal.confirm({
      centered: true,
      title: '删除流水线',
      content: `删除后无法恢复，确定删除「${label}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await removePipeline(id)
          setSelectedPipeIds((prev) => prev.filter((x) => x !== id))
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败')
          throw e
        }
      }
    })
  }

  const removePipelinesBatch = async (ids: string[]): Promise<void> => {
    if (!config || !ids.length) return
    const idSet = new Set(ids)
    let recentIdeProjects = config.recentIdeProjects ?? []
    for (const id of ids) {
      recentIdeProjects = removeRecentByPipelineId(recentIdeProjects, id)
    }
    const next = pipelines.filter((p) => !idSet.has(p.id))
    const nextActive = idSet.has(activeId || '')
      ? next[0]?.id || ''
      : activeId || next[0]?.id || ''
    await saveConfig({
      ...config,
      reviewPipelines: next,
      activePipelineId: nextActive,
      recentIdeProjects
    })
    setFavoriteIds((prev) => {
      const fav = prev.filter((id) => !idSet.has(id))
      try {
        localStorage.setItem(FAVORITE_PIPELINES_KEY, JSON.stringify(fav))
      } catch {
        /* ignore */
      }
      return fav
    })
    setSelectedPipeIds([])
    if (!next.length) setBoardVisible(false)
    message.success(`已删除 ${ids.length} 条流水线`)
  }

  const onBatchDeletePipelines = (): void => {
    const ids = selectedPipeIds.filter((id) => pipelines.some((p) => p.id === id))
    if (!ids.length) {
      message.warning('请先勾选流水线')
      return
    }
    Modal.confirm({
      centered: true,
      title: '批量删除流水线',
      content: `将删除选中的 ${ids.length} 条流水线，删除后无法恢复。确定继续？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await removePipelinesBatch(ids)
        } catch (e) {
          message.error(e instanceof Error ? e.message : '批量删除失败')
          throw e
        }
      }
    })
  }

  const onBatchRunPipelines = (): void => {
    if (!config) return
    if (batchRunning || loading) {
      message.warning('已有审查任务在执行，请稍候')
      return
    }
    const selected = pipelines.filter((p) => selectedPipeIds.includes(p.id))
    if (!selected.length) {
      message.warning('请先勾选流水线')
      return
    }

    const ready: ReviewPipeline[] = []
    const skipped: string[] = []
    for (const p of selected) {
      const label = p.name || shortRepo(p.repoUrl) || '未命名'
      if (!p.repoUrl?.trim()) {
        skipped.push(`${label}（未配置代码源）`)
        continue
      }
      if (!p.methodIds?.length) {
        skipped.push(`${label}（未选审查方式）`)
        continue
      }
      if (!p.llmProviderId && !config.activeLlmProviderId) {
        skipped.push(`${label}（未选模型）`)
        continue
      }
      if (!p.reportFormats?.length) {
        skipped.push(`${label}（未选报告格式）`)
        continue
      }
      ready.push(p)
    }

    if (!ready.length) {
      message.warning(
        skipped.length
          ? `选中的流水线均未就绪：${skipped.slice(0, 3).join('；')}`
          : '没有可运行的流水线'
      )
      return
    }

    const concurrency = clampBatchReviewConcurrency(
      config.batchReviewConcurrency ?? DEFAULT_BATCH_REVIEW_CONCURRENCY
    )
    Modal.confirm({
      centered: true,
      title: '批量运行流水线',
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>
            将运行 {ready.length} 条流水线，并发上限 {concurrency}
            （可在「设置 → 通用」调整，最大 5）。
          </p>
          {skipped.length ? (
            <p className="page-sub" style={{ margin: 0 }}>
              已跳过 {skipped.length} 条未就绪：
              {skipped.slice(0, 5).join('；')}
              {skipped.length > 5 ? '…' : ''}
            </p>
          ) : null}
        </div>
      ),
      okText: '开始运行',
      cancelText: '取消',
      onOk: async () => {
        try {
          await persistPipelines(pipelines, ready[0]?.id || activeId)
          const payloads = ready.map((pipeline) => ({
            pipelineId: pipeline.id,
            repoUrl: pipeline.repoUrl.trim(),
            prNumber: pipeline.prNumber?.trim() || undefined,
            commitSha: pipeline.commitSha?.trim() || undefined,
            methodIds: pipeline.methodIds,
            llmProviderId: pipeline.llmProviderId || config.activeLlmProviderId,
            reportFormats: pipeline.reportFormats,
            forceRefresh: true
          }))
          const reports = await startBatchReview(payloads)
          const ok = reports.filter((r) => r.status === 'completed').length
          const fail = reports.filter(
            (r) => r.status === 'failed' || r.status === 'cancelled'
          ).length
          message.success(
            `批量运行结束：成功 ${ok}，失败/取消 ${fail}，共 ${payloads.length} 条` +
              (skipped.length ? `（另跳过 ${skipped.length}）` : '')
          )
          navigate('/report')
        } catch (e) {
          message.error(e instanceof Error ? e.message : '批量运行失败')
          throw e
        }
      }
    })
  }

  const openSource = (mode?: 'custom' | 'repo'): void => {
    if (!active) return
    const nextMode: 'custom' | 'repo' =
      mode ??
      (active.sourceKind === 'custom'
        ? 'custom'
        : active.sourceKind === 'repo'
          ? 'repo'
          : 'repo')
    const currentUrl = active.repoUrl || ''
    setDraftSource({
      repoUrl: currentUrl,
      branch: active.branch || '',
      prNumber: active.prNumber || '',
      workDir: active.workDir || '',
      providerId: active.codeRepoProviderId || ''
    })
    setSourceMode(nextMode)
    setSourceOpen(true)
    setSourceFilter('all')
    setBranchOptions([])
    setBranchHint('')
    setExtRepoHint('')
    if (nextMode === 'repo') {
      void loadExtAppRepos().then((repos) => {
        if (!currentUrl) return
        const providerId = active.codeRepoProviderId || ''
        const hit =
          (providerId
            ? repos.find((r) => r.url === currentUrl && r.providerId === providerId)
            : undefined) || repos.find((r) => r.url === currentUrl)
        if (!hit) return
        setDraftSource((s) => ({ ...s, providerId: hit.providerId }))
        void loadExtAppBranches(hit.providerId, currentUrl)
      })
    }
  }

  const openMethods = (): void => {
    if (!active) return
    setDraftMethods(active.methodIds?.length ? [...active.methodIds] : [])
    setMethodsOpen(true)
    void loadMethodCatalog()
  }

  const openModel = (): void => {
    if (!active) return
    setDraftProviderId(
      active.llmProviderId || config?.activeLlmProviderId || providers[0]?.id || ''
    )
    setModelOpen(true)
  }

  const openReport = (): void => {
    if (!active) return
    setDraftFormats(
      active.reportFormats?.length ? [...active.reportFormats] : ['md', 'html']
    )
    setReportOpen(true)
  }

  const assertPipelineReady = async (
    pipeline: ReviewPipeline,
    opts?: { openBoard?: boolean }
  ): Promise<boolean> => {
    if (!config) return false
    const openBoard = opts?.openBoard !== false
    if (!pipeline.repoUrl.trim()) {
      message.warning('请先配置代码源')
      if (openBoard) await onOpenPipeline(pipeline.id)
      return false
    }
    if (!pipeline.methodIds?.length) {
      message.warning('请先选择审查方式')
      if (openBoard) await onOpenPipeline(pipeline.id)
      return false
    }
    if (!pipeline.llmProviderId && !config.activeLlmProviderId) {
      message.warning('请先选择模型')
      if (openBoard) await onOpenPipeline(pipeline.id)
      return false
    }
    if (!pipeline.reportFormats?.length) {
      message.warning('请先选择报告输出格式')
      if (openBoard) await onOpenPipeline(pipeline.id)
      return false
    }
    return true
  }

  const loadRunBranches = async (pipeline: ReviewPipeline): Promise<void> => {
    const providerId = pipeline.codeRepoProviderId || ''
    const repoUrl = pipeline.repoUrl?.trim() || ''
    if (!providerId || !repoUrl) {
      setRunBranchOptions(
        pipeline.branch?.trim() ? [pipeline.branch.trim()] : ['master', 'main']
      )
      return
    }
    setRunBranchLoading(true)
    try {
      const result = await window.electronAPI.listExternalAppBranches({
        providerId,
        repoUrl
      })
      const list = result.branches?.length
        ? result.branches
        : pipeline.branch?.trim()
          ? [pipeline.branch.trim()]
          : ['master', 'main']
      setRunBranchOptions(list)
    } catch {
      setRunBranchOptions(
        pipeline.branch?.trim() ? [pipeline.branch.trim()] : ['master', 'main']
      )
    } finally {
      setRunBranchLoading(false)
    }
  }

  const openRunConfig = async (pipeline: ReviewPipeline): Promise<void> => {
    if (batchRunning) {
      message.warning('批量运行进行中，请稍候')
      return
    }
    if (
      currentReport?.status === 'running' &&
      currentReport.pipelineId === pipeline.id
    ) {
      message.warning('该流水线正在运行，请稍候')
      return
    }
    if (
      currentReport?.status === 'running' &&
      currentReport.pipelineId &&
      currentReport.pipelineId !== pipeline.id
    ) {
      message.warning('其他流水线正在运行，请稍候或先取消后再启动')
      return
    }
    if (!(await assertPipelineReady(pipeline))) return

    const saved = readLastRunConfigMap()[pipeline.id]
    const autofill = saved?.autofill !== false
    const lastReport = history
      .filter((r) => r.pipelineId === pipeline.id)
      .sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )[0]
    const branch =
      (autofill && (saved?.branch || lastReport?.branch)) ||
      pipeline.branch ||
      'master'
    const runNote =
      (autofill && (saved?.runNote || lastReport?.runNote)) || ''

    setRunConfigPipeline(pipeline)
    setRunDraft({
      branch: branch.trim() || 'master',
      runNote: (runNote || '').slice(0, RUN_NOTE_MAX),
      autofill
    })
    setRunConfigOpen(true)
    void loadRunBranches(pipeline)
  }

  const onStartPipeline = async (
    pipeline: ReviewPipeline,
    overrides?: { branch?: string; runNote?: string }
  ): Promise<void> => {
    if (!config) return
    if (!(await assertPipelineReady(pipeline))) return
    const branch = overrides?.branch?.trim() || pipeline.branch?.trim() || undefined
    const runNote = overrides?.runNote?.trim() || undefined
    try {
      await persistPipelines(pipelines, pipeline.id)
      writeLastRunConfig(pipeline.id, {
        branch,
        runNote,
        autofill: runDraft.autofill
      })
      await startReview({
        pipelineId: pipeline.id,
        repoUrl: pipeline.repoUrl.trim(),
        prNumber: pipeline.prNumber?.trim() || undefined,
        commitSha: pipeline.commitSha?.trim() || undefined,
        branch,
        runNote,
        methodIds: pipeline.methodIds,
        llmProviderId: pipeline.llmProviderId || config.activeLlmProviderId,
        reportFormats: pipeline.reportFormats,
        forceRefresh: true
      })
      const reportId = useAppStore.getState().currentReport?.id
      message.success('已启动审查，正在展示执行过程')
      navigate(reportId ? `/report?id=${encodeURIComponent(reportId)}` : '/report')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '审查启动失败')
    }
  }

  const confirmRunConfig = async (): Promise<void> => {
    if (!runConfigPipeline) return
    if (!runDraft.branch.trim()) {
      message.warning('请选择或填写分支')
      return
    }
    const pipeline = runConfigPipeline
    const branch = runDraft.branch.trim()
    const runNote = runDraft.runNote.trim().slice(0, RUN_NOTE_MAX)
    writeLastRunConfig(pipeline.id, {
      branch,
      runNote,
      autofill: runDraft.autofill
    })
    setRunConfigOpen(false)
    setRunConfigPipeline(null)
    await onStartPipeline(pipeline, { branch, runNote })
  }

  const selectedProvider =
    providers.find((p) => p.id === active?.llmProviderId) ||
    providers.find((p) => p.id === config?.activeLlmProviderId)

  const selectedProviderLabel = (() => {
    if (!selectedProvider) return ''
    const title =
      selectedProvider.displayName?.trim() ||
      selectedProvider.name?.trim() ||
      ''
    const model = selectedProvider.model?.trim() || ''
    if (!title) return model
    if (!model || model === title) return title
    return `${title} · ${model}`
  })()

  const methodLabels = (active?.methodIds ?? [])
    .map((id) => methodCatalog.find((m) => m.id === id)?.name || id)
    .slice(0, 6)

  useEffect(() => {
    setNameDraft(active?.name || '')
  }, [active?.id, active?.name])

  const latestReportByPipeline = useMemo(() => {
    const map = new Map<string, (typeof history)[number]>()
    const sorted = [...history].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    for (const report of sorted) {
      const key = report.pipelineId?.trim()
      if (!key || map.has(key)) continue
      map.set(key, report)
    }
    return map
  }, [history])

  /**
   * 当前流水线的运行历史：只认报告上的 pipelineId。
   * 不用 repoUrl 兜底，否则「复制流水线」会把原流水线历史带过来。
   */
  const pipelineRunHistory = useMemo(() => {
    if (!active) return [] as ReviewReport[]
    return history
      .filter((r) => r.pipelineId === active.id)
      .sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
  }, [active, history])

  const toggleFavorite = (pipelineId: string): void => {
    setFavoriteIds((prev) => {
      const next = prev.includes(pipelineId)
        ? prev.filter((id) => id !== pipelineId)
        : [...prev, pipelineId]
      try {
        localStorage.setItem(FAVORITE_PIPELINES_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const filteredHomePipelines = useMemo(() => {
    const q = pipeListQuery.trim().toLowerCase()
    return pipelines.filter((p) => {
      if (pipeListTab === 'favorites' && !favoriteIds.includes(p.id)) return false
      if (!q) return true
      const hay = `${p.name} ${p.repoUrl} ${p.branch || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [pipelines, pipeListTab, favoriteIds, pipeListQuery])

  /** 列表页 / 看板页共用，避免列表点运行时弹窗未挂载导致「没反应」 */
  const runConfigModal = (
    <Modal
      title="运行配置"
      open={runConfigOpen}
      centered
      width={520}
      className="pipe-run-config-modal"
      destroyOnClose
      onCancel={() => {
        setRunConfigOpen(false)
        setRunConfigPipeline(null)
      }}
      footer={
        <div className="pipe-run-config-footer">
          <Checkbox
            checked={runDraft.autofill}
            onChange={(e) => {
              const autofill = e.target.checked
              setRunDraft((s) => ({ ...s, autofill }))
              if (runConfigPipeline) {
                writeLastRunConfig(runConfigPipeline.id, {
                  branch: runDraft.branch,
                  runNote: runDraft.runNote,
                  autofill
                })
              }
              if (autofill && runConfigPipeline) {
                const saved = readLastRunConfigMap()[runConfigPipeline.id]
                const lastReport = history
                  .filter((r) => r.pipelineId === runConfigPipeline.id)
                  .sort(
                    (a, b) =>
                      new Date(b.createdAt).getTime() -
                      new Date(a.createdAt).getTime()
                  )[0]
                setRunDraft((s) => ({
                  ...s,
                  autofill: true,
                  branch:
                    saved?.branch ||
                    lastReport?.branch ||
                    runConfigPipeline.branch ||
                    s.branch ||
                    'master',
                  runNote: (
                    saved?.runNote ||
                    lastReport?.runNote ||
                    ''
                  ).slice(0, RUN_NOTE_MAX)
                }))
              }
            }}
          >
            自动填充上一次运行配置参数
          </Checkbox>
          <div className="pipe-run-config-footer-actions">
            <Button
              onClick={() => {
                setRunConfigOpen(false)
                setRunConfigPipeline(null)
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              loading={loading}
              onClick={() => void confirmRunConfig()}
            >
              运行
            </Button>
          </div>
        </div>
      }
    >
      {runConfigPipeline ? (
        <div className="pipe-run-config">
          <div className="pipe-run-config-label">代码源</div>
          <div className="pipe-run-config-source">
            <div className="pipe-run-config-repo" title={runConfigPipeline.repoUrl}>
              {shortRepo(runConfigPipeline.repoUrl)}
            </div>
            <Select
              className="pipe-run-config-ref-kind"
              value="branch"
              options={[{ value: 'branch', label: '分支' }]}
              style={{ width: 96 }}
            />
            <Select
              className="pipe-run-config-branch"
              showSearch
              allowClear={false}
              loading={runBranchLoading}
              placeholder="选择分支"
              value={runDraft.branch || undefined}
              options={Array.from(
                new Set([
                  ...runBranchOptions,
                  ...(runDraft.branch ? [runDraft.branch] : [])
                ])
              ).map((b) => ({ value: b, label: b }))}
              onChange={(v) => setRunDraft((s) => ({ ...s, branch: v }))}
              style={{ flex: 1, minWidth: 140 }}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <div className="pipe-run-config-branch-extra">
                    <Input
                      size="small"
                      placeholder="或输入分支名后回车"
                      onPressEnter={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim()
                        if (!v) return
                        setRunBranchOptions((prev) =>
                          prev.includes(v) ? prev : [...prev, v]
                        )
                        setRunDraft((s) => ({ ...s, branch: v }))
                        ;(e.target as HTMLInputElement).value = ''
                      }}
                    />
                  </div>
                </>
              )}
            />
          </div>

          <div className="pipe-run-config-label" style={{ marginTop: 16 }}>
            运行备注
          </div>
          <div className="pipe-run-config-note-wrap">
            <Input.TextArea
              value={runDraft.runNote}
              maxLength={RUN_NOTE_MAX}
              rows={4}
              placeholder="输入运行备注"
              onChange={(e) =>
                setRunDraft((s) => ({
                  ...s,
                  runNote: e.target.value.slice(0, RUN_NOTE_MAX)
                }))
              }
            />
            <span className="pipe-run-config-note-count">
              {runDraft.runNote.length}/{RUN_NOTE_MAX}
            </span>
          </div>
        </div>
      ) : null}
    </Modal>
  )

  if (!config) {
    return <div className="page">正在加载…</div>
  }

  if (!boardVisible || !active) {
    const hasPipelines = pipelines.length > 0
    return (
      <div className={`page pipe-page pipe-page-home ${hasPipelines ? 'has-list' : 'is-empty'}`}>
        <div className="pipe-empty">
          {!hasPipelines ? (
            <div className="pipe-hero">
              <div className="pipe-hero-copy">
                <h1 className="pipe-hero-title">
                  从一条流水线
                  <br />
                  开始代码审查
                </h1>
                <p className="pipe-hero-desc">
                  把仓库、审查方式、模型与报告输出收进一条可复用的流水线。配好后随时一键启动，结果会进入审查记录。
                </p>
                <button
                  type="button"
                  className="pipe-hero-create"
                  onClick={() => void onAddPipeline()}
                >
                  <span className="pipe-hero-create-plus">
                    <PlusOutlined />
                  </span>
                  <span className="pipe-hero-create-text">
                    <strong>新建流水线</strong>
                    <em>约 1 分钟完成首次配置</em>
                  </span>
                </button>
              </div>
              <ol className="pipe-hero-rail" aria-label="审查流程">
                <li className="pipe-hero-node">
                  <span className="pipe-hero-node-idx">01</span>
                  <span className="pipe-hero-node-label">代码源</span>
                  <span className="pipe-hero-node-hint">仓库 / 分支 / PR</span>
                </li>
                <li className="pipe-hero-node">
                  <span className="pipe-hero-node-idx">02</span>
                  <span className="pipe-hero-node-label">审查配置</span>
                  <span className="pipe-hero-node-hint">方式 · 模型 · 规则</span>
                </li>
                <li className="pipe-hero-node">
                  <span className="pipe-hero-node-idx">03</span>
                  <span className="pipe-hero-node-label">输出报告</span>
                  <span className="pipe-hero-node-hint">问题清单与 Diff</span>
                </li>
              </ol>
            </div>
          ) : (
            <div className="pipe-mine">
              <div className="pipe-mine-head">
                <h1 className="pipe-mine-title">我的流水线</h1>
                <div className="pipe-mine-toolbar">
                  {pipeSearchOpen ? (
                    <Input
                      allowClear
                      size="small"
                      className="pipe-mine-search"
                      placeholder="搜索流水线"
                      prefix={<SearchOutlined />}
                      value={pipeListQuery}
                      onChange={(e) => setPipeListQuery(e.target.value)}
                      onBlur={() => {
                        if (!pipeListQuery.trim()) setPipeSearchOpen(false)
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      type="button"
                      className="pipe-mine-icon-btn"
                      title="搜索"
                      aria-label="搜索"
                      onClick={() => setPipeSearchOpen(true)}
                    >
                      <SearchOutlined />
                    </button>
                  )}
                  <button
                    type="button"
                    className="pipe-mine-icon-btn"
                    title="详细列表"
                    aria-label="详细列表"
                    onClick={() => setPipeListView('detail')}
                  >
                    <UnorderedListOutlined />
                  </button>
                  <button
                    type="button"
                    className="pipe-mine-icon-btn"
                    title="我的收藏"
                    aria-label="我的收藏"
                    onClick={() =>
                      setPipeListTab((tab) => (tab === 'favorites' ? 'joined' : 'favorites'))
                    }
                  >
                    <FilterOutlined />
                  </button>
                  <Segmented
                    className="pipe-mine-view-seg"
                    value={pipeListView}
                    onChange={(v) => setPipeListView(v as 'brief' | 'detail')}
                    options={[
                      { label: '简略', value: 'brief' },
                      { label: '详细', value: 'detail' }
                    ]}
                  />
                  <Button
                    type="primary"
                    size="middle"
                    icon={<PlusOutlined />}
                    onClick={() => void onAddPipeline()}
                  >
                    新建流水线
                  </Button>
                </div>
              </div>

              <div className="pipe-mine-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={pipeListTab === 'joined'}
                  className={`pipe-mine-tab ${pipeListTab === 'joined' ? 'is-active' : ''}`}
                  onClick={() => setPipeListTab('joined')}
                >
                  我参与的
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={pipeListTab === 'favorites'}
                  className={`pipe-mine-tab ${pipeListTab === 'favorites' ? 'is-active' : ''}`}
                  onClick={() => setPipeListTab('favorites')}
                >
                  我的收藏
                </button>
                {selectedPipeIds.length > 0 ? (
                  <div className="pipe-mine-batch-inline" role="toolbar" aria-label="批量操作">
                    <span className="pipe-mine-batch-sep" aria-hidden />
                    <span className="pipe-mine-batch-count">
                      已选 <em>{selectedPipeIds.length}</em> 条
                    </span>
                    <button
                      type="button"
                      className="pipe-mine-batch-btn is-run"
                      disabled={batchRunning || (loading && !batchRunning)}
                      onClick={onBatchRunPipelines}
                    >
                      <PlayCircleOutlined />
                      {batchRunning ? '批量运行中…' : '批量运行'}
                    </button>
                    <button
                      type="button"
                      className="pipe-mine-batch-btn is-danger"
                      disabled={batchRunning || loading}
                      onClick={onBatchDeletePipelines}
                    >
                      <DeleteOutlined />
                      批量删除
                    </button>
                    <button
                      type="button"
                      className="pipe-mine-batch-btn is-ghost"
                      onClick={() => setSelectedPipeIds([])}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="pipe-mine-table" role="table">
                <div className="pipe-mine-row pipe-mine-row-head" role="row">
                  <div className="pipe-mine-col pipe-mine-col-check" role="columnheader">
                    <Checkbox
                      checked={
                        filteredHomePipelines.length > 0 &&
                        filteredHomePipelines.every((p) => selectedPipeIds.includes(p.id))
                      }
                      indeterminate={
                        selectedPipeIds.length > 0 &&
                        !filteredHomePipelines.every((p) => selectedPipeIds.includes(p.id))
                      }
                      onChange={(e) => {
                        setSelectedPipeIds(
                          e.target.checked ? filteredHomePipelines.map((p) => p.id) : []
                        )
                      }}
                    />
                  </div>
                  <div className="pipe-mine-col pipe-mine-col-name" role="columnheader">
                    流水线名称
                  </div>
                  <div className="pipe-mine-col pipe-mine-col-status" role="columnheader">
                    最近运行状态
                  </div>
                  <div className="pipe-mine-col pipe-mine-col-stages" role="columnheader">
                    最近运行阶段
                  </div>
                  <div className="pipe-mine-col pipe-mine-col-trigger" role="columnheader">
                    触发信息
                  </div>
                  <div className="pipe-mine-col pipe-mine-col-time" role="columnheader">
                    最近运行开始时间
                  </div>
                  <div className="pipe-mine-col pipe-mine-col-actions" role="columnheader" />
                </div>

                {filteredHomePipelines.length === 0 ? (
                  <div className="pipe-mine-empty">
                    {pipeListTab === 'favorites' ? '暂无收藏的流水线' : '没有匹配的流水线'}
                  </div>
                ) : (
                  filteredHomePipelines.map((p, index) => {
                    const title = p.name || shortRepo(p.repoUrl) || '未命名流水线'
                    const report = latestReportByPipeline.get(p.id)
                    const starred = favoriteIds.includes(p.id)
                    const statusIcon =
                      report?.status === 'completed' ? (
                        <CheckCircleFilled className="pipe-mine-status-ok" />
                      ) : report?.status === 'failed' ? (
                        <CloseCircleFilled className="pipe-mine-status-fail" />
                      ) : report?.status === 'running' || report?.status === 'pending' ? (
                        <SyncOutlined spin className="pipe-mine-status-run" />
                      ) : null

                    const stageNodes = report
                      ? [
                          {
                            key: 'pull',
                            label: '拉取',
                            done:
                              report.status === 'completed' ||
                              report.status === 'failed' ||
                              (report.progress ?? 0) >= 30
                          },
                          {
                            key: 'review',
                            label: '审查',
                            done:
                              report.status === 'completed' ||
                              report.status === 'failed' ||
                              (report.progress ?? 0) >= 70
                          },
                          {
                            key: 'report',
                            label: '报告',
                            done: report.status === 'completed'
                          }
                        ]
                      : p.repoUrl
                        ? [
                            { key: 'src', label: '代码源', done: Boolean(p.repoUrl) },
                            {
                              key: 'cfg',
                              label: '配置',
                              done: Boolean(p.methodIds?.length && p.llmProviderId)
                            },
                            {
                              key: 'out',
                              label: '输出',
                              done: Boolean(p.reportFormats?.length)
                            }
                          ]
                        : []

                    const moreItems: MenuProps['items'] = [
                      {
                        key: 'open',
                        icon: <EditOutlined />,
                        label: '基本信息',
                        onClick: () => void onOpenPipeline(p.id)
                      },
                      {
                        key: 'copy',
                        icon: <CopyOutlined />,
                        label: '复制流水线',
                        onClick: () => void onCopyPipeline(p.id)
                      },
                      {
                        key: 'delete',
                        icon: <DeleteOutlined />,
                        danger: true,
                        label: '删除',
                        onClick: () => onDeletePipeline(p.id)
                      }
                    ]

                    return (
                      <div
                        key={p.id}
                        className={`pipe-mine-row ${pipeListView === 'detail' ? 'is-detail' : ''}`}
                        role="row"
                      >
                        <div className="pipe-mine-col pipe-mine-col-check" role="cell">
                          <Checkbox
                            checked={selectedPipeIds.includes(p.id)}
                            onChange={(e) => {
                              setSelectedPipeIds((prev) =>
                                e.target.checked
                                  ? [...prev, p.id]
                                  : prev.filter((id) => id !== p.id)
                              )
                            }}
                          />
                        </div>
                        <div className="pipe-mine-col pipe-mine-col-name" role="cell">
                          <button
                            type="button"
                            className="pipe-mine-name-btn"
                            onClick={() => void onOpenPipeline(p.id)}
                          >
                            <span className="pipe-mine-name">{title}</span>
                            {pipeListView === 'detail' ? (
                              <span className="pipe-mine-name-sub">
                                {p.repoUrl ? shortRepo(p.repoUrl) : '未配置代码源'}
                                {p.branch ? ` · ${p.branch}` : ''}
                              </span>
                            ) : null}
                          </button>
                        </div>
                        <div className="pipe-mine-col pipe-mine-col-status" role="cell">
                          {report ? (
                            <span className="pipe-mine-status">
                              <span className="pipe-mine-run-no">#{index + 1}</span>
                              {statusIcon}
                            </span>
                          ) : (
                            <span className="pipe-mine-dash">-</span>
                          )}
                        </div>
                        <div className="pipe-mine-col pipe-mine-col-stages" role="cell">
                          {stageNodes.length ? (
                            <div className="pipe-mine-stages" aria-hidden>
                              {stageNodes.map((node, i) => (
                                <span key={node.key} className="pipe-mine-stage">
                                  {i > 0 ? (
                                    <span
                                      className={`pipe-mine-stage-line ${node.done || stageNodes[i - 1]?.done ? 'is-on' : ''}`}
                                    />
                                  ) : null}
                                  <span className="pipe-mine-stage-label">{node.label}</span>
                                  <span
                                    className={`pipe-mine-stage-dot ${node.done ? 'is-done' : ''}`}
                                  />
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="pipe-mine-dash">-</span>
                          )}
                        </div>
                        <div className="pipe-mine-col pipe-mine-col-trigger" role="cell">
                          {report ? (
                            <span className="pipe-mine-trigger">
                              <span className="pipe-mine-avatar" aria-hidden>
                                {(title.slice(0, 1) || '审').toUpperCase()}
                              </span>
                              <span>手动触发</span>
                            </span>
                          ) : (
                            <span className="pipe-mine-dash">-</span>
                          )}
                        </div>
                        <div className="pipe-mine-col pipe-mine-col-time" role="cell">
                          {report?.createdAt ? (
                            <span className="pipe-mine-time">
                              {formatDateTime(report.createdAt)}
                            </span>
                          ) : (
                            <span className="pipe-mine-dash">-</span>
                          )}
                        </div>
                        <div className="pipe-mine-col pipe-mine-col-actions" role="cell">
                          <button
                            type="button"
                            className={`pipe-mine-action ${starred ? 'is-starred' : ''}`}
                            title={starred ? '取消收藏' : '收藏'}
                            aria-label={starred ? '取消收藏' : '收藏'}
                            onClick={() => toggleFavorite(p.id)}
                          >
                            {starred ? <StarFilled /> : <StarOutlined />}
                          </button>
                          <button
                            type="button"
                            className="pipe-mine-action pipe-mine-action-run"
                            title={
                              batchRunning
                                ? '批量运行进行中'
                                : currentReport?.status === 'running' &&
                                    currentReport.pipelineId === p.id
                                  ? '该流水线正在运行'
                                  : '启动审查'
                            }
                            aria-label="启动审查"
                            disabled={
                              batchRunning ||
                              (currentReport?.status === 'running' &&
                                currentReport.pipelineId === p.id)
                            }
                            onClick={() => void openRunConfig(p)}
                          >
                            <PlayCircleOutlined />
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
          )}
        </div>
        {runConfigModal}
      </div>
    )
  }

  const pipelineTitle = active.name || shortRepo(active.repoUrl) || '未命名流水线'

  const commitPipelineName = (): void => {
    if (!active) return
    const next = nameDraft.trim()
    if (!next) {
      setNameDraft(active.name || '')
      return
    }
    if (next === active.name) return
    void updateActive({ name: next })
  }
  /** 仅当「当前看板流水线」在跑时才显示取消/进度，避免全局 loading 串台 */
  const activeRunReport =
    currentReport?.status === 'running' &&
    currentReport.pipelineId === active.id
      ? currentReport
      : history.find(
          (r) => r.pipelineId === active.id && r.status === 'running'
        ) ?? null
  const activePipelineRunning = Boolean(activeRunReport)

  /** 配置页 → 只读运行页（右侧「编辑 / 运行」） */
  const goToRunPage = (): void => {
    setBoardTab('run')
  }

  const handleSaveOnly = (): void => {
    commitPipelineName()
    message.success('已保存')
    goToRunPage()
  }

  const handleSaveAndRun = (): void => {
    if (!active) return
    commitPipelineName()
    if (!isPipelineReady(active)) {
      message.warning('请先完成代码源、审查方式、模型与报告配置')
      return
    }
    message.success('已保存')
    goToRunPage()
    void openRunConfig(active)
  }

  const handleRun = (): void => {
    if (!active) return
    if (!isPipelineReady(active)) {
      message.warning('请先点击「编辑」完成流程配置')
      setBoardTab('config')
      return
    }
    void openRunConfig(active)
  }

  const editable = boardTab === 'config'
  const flowRevision = [
    editable ? 'e' : 'r',
    active.repoUrl || '',
    active.branch || '',
    active.prNumber || '',
    (active.methodIds || []).join(','),
    active.llmProviderId || '',
    (active.reportFormats || []).join(','),
    selectedProvider?.model || '',
    methodLabels.join('|')
  ].join('::')

  const flowBoard = (
    <div className="pipe-canvas">
      <div
        ref={boardRef}
        className={`pipe-board pipe-board-edit ${editable ? '' : 'is-readonly'}`}
      >
        <PipeFlowEdges boardRef={boardRef} revision={flowRevision} />

        <section className="pipe-stage">
          <div className="pipe-stage-title">流水线源</div>
          <div className="pipe-stage-body">
            {active.repoUrl ? (
              editable ? (
                <button
                  type="button"
                  className="pipe-source-card pipe-flow-node"
                  data-pipe-stage="0"
                  onClick={() => openSource()}
                >
                  <CodeOutlined className="pipe-source-icon" />
                  <div className="pipe-source-body">
                    <div className="pipe-source-name">{shortRepo(active.repoUrl)}</div>
                    <div className="pipe-source-meta">
                      <span>
                        <BranchesOutlined /> {active.branch || 'master'}
                      </span>
                      {active.prNumber ? <span>PR #{active.prNumber}</span> : null}
                      <span>
                        {active.sourceKind === 'custom' ? '自定义 Git' : '代码仓库'}
                      </span>
                    </div>
                  </div>
                </button>
              ) : (
                <button
                  type="button"
                  className="pipe-source-card is-static is-browseable pipe-flow-node"
                  data-pipe-stage="0"
                  title={
                    active.workDir?.trim()
                      ? '在本地工作区打开项目'
                      : '点击打开项目编辑器'
                  }
                  onClick={() =>
                    navigate(
                      `/review/editor?pipelineId=${encodeURIComponent(active.id)}`
                    )
                  }
                >
                  <CodeOutlined className="pipe-source-icon" />
                  <div className="pipe-source-body">
                    <div className="pipe-source-name">{shortRepo(active.repoUrl)}</div>
                    <div className="pipe-source-meta">
                      <span>
                        <BranchesOutlined /> {active.branch || 'master'}
                      </span>
                      {active.prNumber ? <span>PR #{active.prNumber}</span> : null}
                      <span>Git</span>
                      <span className="pipe-source-browse-hint">查看项目</span>
                    </div>
                  </div>
                </button>
              )
            ) : editable ? (
              <button
                type="button"
                className="pipe-add pipe-flow-node"
                data-pipe-stage="0"
                onClick={() => openSource('repo')}
              >
                + 添加流水线源
              </button>
            ) : (
              <div className="pipe-empty-slot pipe-flow-node" data-pipe-stage="0">
                未配置代码源
              </div>
            )}
            {editable ? (
              <button
                type="button"
                className="pipe-add ghost"
                onClick={() => openSource('repo')}
              >
                + 代码仓库源
              </button>
            ) : null}
          </div>
        </section>

        <section className="pipe-stage">
          <div className="pipe-stage-title">审查</div>
          <div className="pipe-stage-body">
            {methodLabels.length === 0 ? (
              editable ? (
                <button
                  type="button"
                  className="pipe-add pipe-flow-node"
                  data-pipe-stage="1"
                  onClick={openMethods}
                >
                  + 新阶段任务
                </button>
              ) : (
                <div className="pipe-empty-slot pipe-flow-node" data-pipe-stage="1">
                  未配置审查方式
                </div>
              )
            ) : (
              <>
                {methodLabels.map((label) =>
                  editable ? (
                    <button
                      key={label}
                      type="button"
                      className="pipe-pill pipe-flow-node"
                      data-pipe-stage="1"
                      onClick={openMethods}
                    >
                      <span className="pipe-pill-bolt">
                        <ThunderboltOutlined />
                      </span>
                      {label}
                    </button>
                  ) : (
                    <div
                      key={label}
                      className="pipe-pill is-static pipe-flow-node"
                      data-pipe-stage="1"
                    >
                      <span className="pipe-pill-bolt">
                        <ThunderboltOutlined />
                      </span>
                      {label}
                    </div>
                  )
                )}
                {(active.methodIds?.length ?? 0) > methodLabels.length ? (
                  editable ? (
                    <button
                      type="button"
                      className="pipe-pill muted pipe-flow-node"
                      data-pipe-stage="1"
                      onClick={openMethods}
                    >
                      +{active.methodIds.length - methodLabels.length} 项
                    </button>
                  ) : (
                    <div
                      className="pipe-pill muted is-static pipe-flow-node"
                      data-pipe-stage="1"
                    >
                      +{active.methodIds.length - methodLabels.length} 项
                    </div>
                  )
                ) : null}
                {editable ? (
                  <button type="button" className="pipe-add ghost" onClick={openMethods}>
                    + 新阶段任务
                  </button>
                ) : null}
              </>
            )}
          </div>
        </section>

        <section className="pipe-stage">
          <div className="pipe-stage-title">模型</div>
          <div className="pipe-stage-body">
            {selectedProvider ? (
              <>
                {editable ? (
                  <button
                    type="button"
                    className="pipe-pill pipe-flow-node"
                    data-pipe-stage="2"
                    onClick={openModel}
                  >
                    <span className="pipe-pill-bolt">
                      <ThunderboltOutlined />
                    </span>
                    {selectedProviderLabel}
                  </button>
                ) : (
                  <div className="pipe-pill is-static pipe-flow-node" data-pipe-stage="2">
                    <span className="pipe-pill-bolt">
                      <ThunderboltOutlined />
                    </span>
                    {selectedProviderLabel}
                  </div>
                )}
                {editable ? (
                  <button type="button" className="pipe-add ghost" onClick={openModel}>
                    + 新阶段任务
                  </button>
                ) : null}
              </>
            ) : editable ? (
              <button
                type="button"
                className="pipe-add pipe-flow-node"
                data-pipe-stage="2"
                onClick={openModel}
              >
                + 新阶段任务
              </button>
            ) : (
              <div className="pipe-empty-slot pipe-flow-node" data-pipe-stage="2">
                未配置模型
              </div>
            )}
          </div>
        </section>

        <section className="pipe-stage">
          <div className="pipe-stage-title">报告</div>
          <div className="pipe-stage-body">
            {(active.reportFormats ?? []).length ? (
              <>
                {(active.reportFormats ?? []).map((fmt) =>
                  editable ? (
                    <button
                      key={fmt}
                      type="button"
                      className="pipe-pill pipe-flow-node"
                      data-pipe-stage="3"
                      onClick={openReport}
                    >
                      <span className="pipe-pill-bolt">
                        <FileTextOutlined />
                      </span>
                      输出 .{fmt}
                    </button>
                  ) : (
                    <div
                      key={fmt}
                      className="pipe-pill is-static pipe-flow-node"
                      data-pipe-stage="3"
                    >
                      <span className="pipe-pill-bolt">
                        <FileTextOutlined />
                      </span>
                      输出 .{fmt}
                    </div>
                  )
                )}
                {editable ? (
                  <button type="button" className="pipe-add ghost" onClick={openReport}>
                    + 新阶段任务
                  </button>
                ) : null}
              </>
            ) : editable ? (
              <button
                type="button"
                className="pipe-add pipe-flow-node"
                data-pipe-stage="3"
                onClick={openReport}
              >
                + 新阶段任务
              </button>
            ) : (
              <div className="pipe-empty-slot pipe-flow-node" data-pipe-stage="3">
                未配置输出
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )

  return (
    <div className="page pipe-page pipe-workspace">
      {editable ? (
        <header className="pipe-ws-bar">
          <button
            type="button"
            className="pipe-ws-back"
            title="返回"
            onClick={() =>
              isPipelineReady(active) ? setBoardTab('run') : setBoardVisible(false)
            }
          >
            <ArrowLeftOutlined />
          </button>
          <Input
            className="pipe-ws-name-input"
            value={nameDraft}
            placeholder="流水线名称"
            maxLength={64}
            title="编辑流水线名称"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitPipelineName}
            onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
          />
          <div className="pipe-ws-tabs" role="tablist">
            <button
              type="button"
              className="pipe-ws-tab is-disabled"
              title="即将开放"
              onClick={() => message.info('「基本信息」即将开放')}
            >
              基本信息
            </button>
            <button type="button" className="pipe-ws-tab active" role="tab">
              流程配置
            </button>
            <button
              type="button"
              className="pipe-ws-tab is-disabled"
              title="即将开放"
              onClick={() => message.info('「触发设置」即将开放')}
            >
              触发设置
            </button>
            <button
              type="button"
              className="pipe-ws-tab is-disabled"
              title="即将开放"
              onClick={() => message.info('「变量和缓存」即将开放')}
            >
              变量和缓存
            </button>
          </div>
          <div className="pipe-ws-actions">
            <Button onClick={handleSaveOnly}>仅保存</Button>
            <Button type="primary" loading={activePipelineRunning} onClick={handleSaveAndRun}>
              保存并运行
            </Button>
          </div>
        </header>
      ) : (
        <header className="pipe-ws-bar">
          <button
            type="button"
            className="pipe-ws-back"
            title="返回列表"
            onClick={() => setBoardVisible(false)}
          >
            <ArrowLeftOutlined />
          </button>
          <div className="pipe-ws-name" title={pipelineTitle}>
            {pipelineTitle}
          </div>
          <div className="pipe-ws-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={boardTab === 'run'}
              className={`pipe-ws-tab ${boardTab === 'run' ? 'active' : ''}`}
              onClick={() => setBoardTab('run')}
            >
              最近运行
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={boardTab === 'history'}
              className={`pipe-ws-tab ${boardTab === 'history' ? 'active' : ''}`}
              onClick={() => setBoardTab('history')}
            >
              运行历史
            </button>
          </div>
          <div className="pipe-ws-actions">
            <Button onClick={() => setBoardTab('config')}>编辑</Button>
            {activePipelineRunning ? (
              <Button
                danger
                onClick={() => void cancelReview(activeRunReport?.id)}
              >
                取消
              </Button>
            ) : (
              <Button type="primary" onClick={handleRun}>
                运行
              </Button>
            )}
          </div>
        </header>
      )}

      {boardTab !== 'history' && activePipelineRunning ? (
        <div className="pipe-run-thin-progress">
          <Progress
            percent={activeRunReport?.progress ?? 4}
            size="small"
            status="active"
            showInfo={false}
          />
        </div>
      ) : null}

      {boardTab === 'history' ? (
        <div className="pipe-history">
          <div className="pipe-history-table" role="table">
            <div className="pipe-history-row pipe-history-row-head" role="row">
              <div className="pipe-history-col pipe-history-col-no" role="columnheader">
                运行记录
              </div>
              <div className="pipe-history-col pipe-history-col-status" role="columnheader">
                状态
              </div>
              <div className="pipe-history-col pipe-history-col-branch" role="columnheader">
                分支信息
              </div>
              <div className="pipe-history-col pipe-history-col-stages" role="columnheader">
                运行详细
              </div>
              <div className="pipe-history-col pipe-history-col-trigger" role="columnheader">
                触发信息
              </div>
              <div className="pipe-history-col pipe-history-col-dur" role="columnheader">
                运行时长
              </div>
              <div className="pipe-history-col pipe-history-col-time" role="columnheader">
                开始时间
              </div>
              <div className="pipe-history-col pipe-history-col-note" role="columnheader">
                运行备注
              </div>
              <div className="pipe-history-col pipe-history-col-action" role="columnheader">
                操作
              </div>
            </div>

            {pipelineRunHistory.length === 0 ? (
              <div className="pipe-history-empty">暂无运行记录，点击右上角「运行」开始审查</div>
            ) : (
              pipelineRunHistory.map((report, index) => {
                const status = historyStatusMeta(report.status)
                const runNo = pipelineRunHistory.length - index
                const branch =
                  report.branch || active.branch || (report.prNumber ? `PR #${report.prNumber}` : '')
                const commit = shortCommit(report.commitSha)
                const stageNodes = [
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
                const durationMs =
                  report.totalDurationMs ??
                  (report.finishedAt
                    ? Math.max(
                        0,
                        new Date(report.finishedAt).getTime() -
                          new Date(report.createdAt).getTime()
                      )
                    : undefined)

                return (
                  <div key={report.id} className="pipe-history-row" role="row">
                    <div className="pipe-history-col pipe-history-col-no" role="cell">
                      #{runNo}
                    </div>
                    <div className="pipe-history-col pipe-history-col-status" role="cell">
                      <span className={`pipe-history-status is-${status.tone}`}>
                        {status.tone === 'ok' ? (
                          <CheckCircleFilled />
                        ) : status.tone === 'fail' ? (
                          <CloseCircleFilled />
                        ) : status.tone === 'run' ? (
                          <SyncOutlined spin={report.status === 'running'} />
                        ) : (
                          <ClockCircleOutlined />
                        )}
                        {status.label}
                      </span>
                    </div>
                    <div className="pipe-history-col pipe-history-col-branch" role="cell">
                      {branch || commit ? (
                        <span className="pipe-history-branch">
                          {branch ? (
                            <span>
                              <BranchesOutlined /> {branch}
                            </span>
                          ) : null}
                          {commit ? (
                            <button
                              type="button"
                              className="pipe-history-commit"
                              title={report.commitSha}
                              onClick={() => {
                                void navigator.clipboard?.writeText(report.commitSha || '')
                                message.success('已复制 commit')
                              }}
                            >
                              {commit}
                            </button>
                          ) : null}
                        </span>
                      ) : (
                        <span className="pipe-mine-dash">-</span>
                      )}
                    </div>
                    <div className="pipe-history-col pipe-history-col-stages" role="cell">
                      <div className="pipe-mine-stages" aria-hidden>
                        {stageNodes.map((node, i) => (
                          <span key={node.key} className="pipe-mine-stage">
                            {i > 0 ? (
                              <span
                                className={`pipe-mine-stage-line ${node.done || stageNodes[i - 1]?.done ? 'is-on' : ''}`}
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
                    <div className="pipe-history-col pipe-history-col-trigger" role="cell">
                      <span className="pipe-mine-trigger">
                        <span className="pipe-mine-avatar" aria-hidden>
                          {(pipelineTitle.slice(0, 1) || '审').toUpperCase()}
                        </span>
                        <span>手动触发</span>
                      </span>
                    </div>
                    <div className="pipe-history-col pipe-history-col-dur" role="cell">
                      {formatHistoryDuration(durationMs)}
                    </div>
                    <div className="pipe-history-col pipe-history-col-time" role="cell">
                      {formatDateTime(report.createdAt, '-')}
                    </div>
                    <div className="pipe-history-col pipe-history-col-note" role="cell">
                      {report.runNote?.trim() ? (
                        <span className="pipe-history-note" title={report.runNote}>
                          {report.runNote.trim()}
                        </span>
                      ) : (
                        <span className="pipe-mine-dash">-</span>
                      )}
                    </div>
                    <div className="pipe-history-col pipe-history-col-action" role="cell">
                      <button
                        type="button"
                        className="pipe-history-view"
                        onClick={() => {
                          void loadReport(report.id).then(() => {
                            navigate(`/report?id=${encodeURIComponent(report.id)}`)
                          })
                        }}
                      >
                        查看
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      ) : (
        flowBoard
      )}

      <Modal
        title="配置代码源"
        open={sourceOpen}
        rootClassName="pipe-source-modal-root"
        className="pipe-source-modal"
        onCancel={() => setSourceOpen(false)}
        onOk={() => {
          if (!draftSource.repoUrl.trim()) {
            message.warning('请选择或填写仓库')
            return
          }
          if (!draftSource.branch.trim()) {
            message.warning('请填写默认分支')
            return
          }
          if (!draftSource.workDir.trim()) {
            message.warning('请选择工作目录')
            return
          }
          void updateActive({
            repoUrl: draftSource.repoUrl.trim(),
            branch: draftSource.branch.trim(),
            prNumber: draftSource.prNumber.trim() || undefined,
            workDir: draftSource.workDir.trim(),
            sourceKind: sourceMode,
            codeRepoProviderId:
              sourceMode === 'repo' ? draftSource.providerId || '' : '',
            mcpServerId: '',
            name: active.name.startsWith('流水线')
              ? shortRepo(draftSource.repoUrl)
              : active.name || shortRepo(draftSource.repoUrl)
          }).then(() => setSourceOpen(false))
        }}
        okText="保存"
        okButtonProps={{
          disabled:
            sourceMode === 'repo' && !extRepoLoading && extSources.length === 0
        }}
      >
        <div className="pipe-form">
          <div className="pipe-source-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === 'repo'}
              className={`pipe-source-tab${sourceMode === 'repo' ? ' is-active' : ''}`}
              onClick={() => {
                if (sourceMode === 'repo') return
                setSourceMode('repo')
                setSourceFilter('all')
                setBranchOptions([])
                setBranchHint('')
                void loadExtAppRepos().then((repos) => {
                  const url = draftSource.repoUrl
                  if (!url) return
                  const hit = repos.find((r) => r.url === url)
                  if (!hit) return
                  setDraftSource((s) => ({ ...s, providerId: hit.providerId }))
                  void loadExtAppBranches(hit.providerId, url)
                })
              }}
            >
              代码仓库源
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === 'custom'}
              className={`pipe-source-tab${sourceMode === 'custom' ? ' is-active' : ''}`}
              onClick={() => {
                if (sourceMode === 'custom') return
                setSourceMode('custom')
                setSourceFilter('all')
                setBranchOptions([])
                setBranchHint('')
                setDraftSource((s) => ({
                  ...s,
                  providerId: ''
                }))
              }}
            >
              自定义 Git
            </button>
          </div>

          {sourceMode === 'repo' ? (
            <>
              {extRepoLoading && extRepos.length === 0 ? (
                <p className="page-sub" style={{ marginBottom: 8 }}>
                  正在检查已连接的代码仓库…
                </p>
              ) : null}
              {!extRepoLoading && extSources.length === 0 ? (
                <div className="pipe-source-guide">
                  <p className="pipe-source-guide-title">
                    亲，您还没有配置代码仓库哦
                  </p>
                  <p className="page-sub" style={{ marginBottom: 14 }}>
                    可前往「设置 → 代码仓库」连接 GitHub / GitLab
                    等平台后选择仓库，或切换上方「自定义 Git」直接填写地址拉取。
                  </p>
                  <div className="pipe-source-guide-actions">
                    <Button
                      type="primary"
                      onClick={() => {
                        setSourceOpen(false)
                        onOpenSettings?.('externalApps')
                      }}
                    >
                      去配置代码仓库
                    </Button>
                  </div>
                </div>
              ) : !extRepoLoading ? (
                <>
                  <label>
                    选择仓库 <span className="pipe-req">*</span>
                  </label>
                  {extSources.length > 1 ? (
                    <Select
                      value={sourceFilter}
                      options={extSourceOptions}
                      onChange={setSourceFilter}
                      style={{ width: '100%', marginBottom: 8 }}
                      placeholder="按平台筛选"
                    />
                  ) : null}
                  <Select
                    showSearch
                    loading={extRepoLoading}
                    placeholder={
                      extRepoLoading ? '加载仓库中…' : '选择仓库'
                    }
                    options={extRepoSelectOptions}
                    optionFilterProp="label"
                    value={
                      flatExtRepoOptions.find(
                        (o) =>
                          o.url === draftSource.repoUrl &&
                          (!draftSource.providerId ||
                            o.providerId === draftSource.providerId)
                      )?.value
                    }
                    onChange={(key) => {
                      const hit = flatExtRepoOptions.find((o) => o.value === key)
                      const nextUrl = hit?.url || ''
                      const nextProviderId = hit?.providerId || ''
                      setDraftSource((s) => ({
                        ...s,
                        repoUrl: nextUrl,
                        providerId: nextProviderId,
                        branch: hit?.branch || s.branch || ''
                      }))
                      if (nextProviderId && nextUrl) {
                        void loadExtAppBranches(nextProviderId, nextUrl)
                      } else {
                        setBranchOptions([])
                        setBranchHint('')
                      }
                    }}
                    style={{ width: '100%', marginBottom: 8 }}
                  />
                  <div
                    className="pipe-source-repo-meta"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 12,
                      flexWrap: 'wrap'
                    }}
                  >
                    {extRepoHint ? (
                      <p className="page-sub" style={{ margin: 0, flex: 1 }}>
                        {extRepoHint}
                      </p>
                    ) : (
                      <span style={{ flex: 1 }} />
                    )}
                    <Button
                      type="link"
                      size="small"
                      icon={<SyncOutlined spin={extRepoRefreshing} />}
                      loading={extRepoRefreshing}
                      disabled={extRepoLoading}
                      onClick={() => {
                        void loadExtAppRepos({ forceRefresh: true })
                      }}
                      style={{ paddingInline: 0 }}
                    >
                      刷新仓库列表
                    </Button>
                  </div>
                  <label>
                    默认分支 <span className="pipe-req">*</span>
                  </label>
                  {branchOptions.length ? (
                    <Select
                      showSearch
                      loading={branchLoading}
                      placeholder={
                        branchLoading
                          ? '正在查询分支…'
                          : draftSource.repoUrl
                            ? '选择默认分支'
                            : '请先选择仓库'
                      }
                      options={branchOptions.map((b) => ({ value: b, label: b }))}
                      value={
                        branchOptions.includes(draftSource.branch)
                          ? draftSource.branch
                          : undefined
                      }
                      onChange={(branch) =>
                        setDraftSource((s) => ({ ...s, branch }))
                      }
                      style={{ width: '100%', marginBottom: 8 }}
                      notFoundContent={branchHint || '暂无分支'}
                    />
                  ) : (
                    <Input
                      value={draftSource.branch}
                      onChange={(e) =>
                        setDraftSource((s) => ({ ...s, branch: e.target.value }))
                      }
                      placeholder="master / main"
                      style={{ marginBottom: 8 }}
                    />
                  )}
                  {branchHint ? (
                    <p className="page-sub" style={{ marginBottom: 12 }}>
                      {branchHint}
                    </p>
                  ) : null}
                  <label>
                    工作目录 <span className="pipe-req">*</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                    <Input
                      className="mono"
                      value={draftSource.workDir}
                      onChange={(e) =>
                        setDraftSource((s) => ({ ...s, workDir: e.target.value }))
                      }
                      placeholder="请选择本地目录"
                    />
                    <Button
                      icon={<FolderOpenOutlined />}
                      onClick={() => {
                        void window.electronAPI
                          .pickLocalDirectory()
                          .then((path) => {
                            if (path)
                              setDraftSource((s) => ({ ...s, workDir: path }))
                          })
                      }}
                    >
                      浏览
                    </Button>
                  </div>
                  <label style={{ marginTop: 12 }}>PR 号（可选）</label>
                  <Input
                    value={draftSource.prNumber}
                    onChange={(e) =>
                      setDraftSource((s) => ({ ...s, prNumber: e.target.value }))
                    }
                    placeholder="12"
                  />
                </>
              ) : null}
            </>
          ) : (
            <>
              <p className="page-sub" style={{ marginBottom: 12 }}>
                手动填写任意 Git 仓库地址与默认分支；有授权平台时也可切回「代码仓库源」从已连接平台选择。
              </p>
              <label>
                Git 仓库地址 <span className="pipe-req">*</span>
              </label>
              <Input
                className="mono"
                value={draftSource.repoUrl}
                onChange={(e) =>
                  setDraftSource((s) => ({ ...s, repoUrl: e.target.value, providerId: '' }))
                }
                placeholder="https://gitee.com/org/repo.git"
                style={{ marginBottom: 12 }}
              />
              <label>
                默认分支 <span className="pipe-req">*</span>
              </label>
              <Input
                value={draftSource.branch}
                onChange={(e) => setDraftSource((s) => ({ ...s, branch: e.target.value }))}
                placeholder="master / main"
                style={{ marginBottom: 12 }}
              />
              <label>
                工作目录 <span className="pipe-req">*</span>
              </label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <Input
                  className="mono"
                  value={draftSource.workDir}
                  onChange={(e) =>
                    setDraftSource((s) => ({ ...s, workDir: e.target.value }))
                  }
                  placeholder="请选择本地目录"
                />
                <Button
                  icon={<FolderOpenOutlined />}
                  onClick={() => {
                    void window.electronAPI.pickLocalDirectory().then((path) => {
                      if (path) setDraftSource((s) => ({ ...s, workDir: path }))
                    })
                  }}
                >
                  浏览
                </Button>
              </div>
              <label style={{ marginTop: 12 }}>PR 号（可选）</label>
              <Input
                value={draftSource.prNumber}
                onChange={(e) => setDraftSource((s) => ({ ...s, prNumber: e.target.value }))}
                placeholder="12"
              />
            </>
          )}
        </div>
      </Modal>

      <Modal
        title="选择代码审查方式"
        open={methodsOpen}
        width={640}
        onCancel={() => setMethodsOpen(false)}
        onOk={() => {
          void updateActive({ methodIds: draftMethods }).then(() => setMethodsOpen(false))
        }}
        okText="保存"
      >
        <p className="page-sub" style={{ marginBottom: 12 }}>
          选项来自服务端「配置中心 · 审查规则」，可多选；启动后才会调用大模型按这些重点分析。
        </p>
        <Checkbox.Group
          style={{ width: '100%' }}
          value={draftMethods}
          onChange={(vals) => setDraftMethods(vals as string[])}
        >
          <div className="pipe-method-grid">
            {methodCatalog.map((m) => (
              <label key={m.id} className="pipe-method-item">
                <Checkbox value={m.id} />
                <span>
                  <strong>{m.name}</strong>
                  <em>{m.group}</em>
                  <small>{m.description}</small>
                </span>
              </label>
            ))}
          </div>
        </Checkbox.Group>
      </Modal>

      <Modal
        title="选择模型"
        open={modelOpen}
        onCancel={() => setModelOpen(false)}
        onOk={() => {
          void updateActive({ llmProviderId: draftProviderId }).then(() => setModelOpen(false))
        }}
        okText="保存"
      >
        {providers.length === 0 ? (
          <div className="empty">
            还没有可用模型，请先到设置 → 模型 添加并启用。
          </div>
        ) : (
          <Select
            style={{ width: '100%' }}
            value={draftProviderId || undefined}
            options={providers.map((p) => ({
              value: p.id,
              label: `${p.name} · ${p.model}`
            }))}
            onChange={setDraftProviderId}
          />
        )}
      </Modal>

      <Modal
        title="报告输出方式"
        open={reportOpen}
        onCancel={() => setReportOpen(false)}
        onOk={() => {
          if (!draftFormats.length) {
            message.warning('至少选择一种格式')
            return
          }
          void updateActive({ reportFormats: draftFormats }).then(() => setReportOpen(false))
        }}
        okText="保存"
      >
        <Checkbox.Group
          value={draftFormats}
          onChange={(vals) => setDraftFormats(vals as ReportOutputFormat[])}
          options={[
            { label: 'Markdown (.md)', value: 'md' },
            { label: 'HTML (.html)', value: 'html' },
            { label: 'JSON (.json)', value: 'json' }
          ]}
        />
      </Modal>

      {runConfigModal}

    </div>
  )
}

export default Dashboard
