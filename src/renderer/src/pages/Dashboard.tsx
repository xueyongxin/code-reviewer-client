import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input, Modal, Progress, Segmented, Select, message } from 'antd'
import {
  PlusOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
  DeleteOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { randomUUID } from './id'
import FlowTimeline, { formatDuration } from '../components/FlowTimeline'
import { useAppStore } from '../store/useAppStore'
import {
  FALLBACK_REVIEW_METHOD_CATALOG,
  type ReviewMethodDef
} from '../../../shared/review-methods'
import type {
  McpRepoOption,
  McpRepoSourceOption,
  ReportOutputFormat,
  ReviewPipeline
} from '../../../shared/types'

const newPipeline = (name: string, repoUrl = ''): ReviewPipeline => ({
  id: randomUUID(),
  name,
  repoUrl,
  methodIds: [],
  llmProviderId: '',
  reportFormats: ['md', 'html'],
  updatedAt: new Date().toISOString()
})

const shortRepo = (url: string): string => {
  try {
    const cleaned = url.replace(/\.git$/, '')
    const parts = cleaned.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || url || '未配置仓库'
  } catch {
    return url || '未配置仓库'
  }
}

const Dashboard = (): JSX.Element => {
  const navigate = useNavigate()
  const loading = useAppStore((s) => s.loading)
  const currentReport = useAppStore((s) => s.currentReport)
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const startReview = useAppStore((s) => s.startReview)
  const cancelReview = useAppStore((s) => s.cancelReview)

  const pipelines = config?.reviewPipelines ?? []
  const activeId = config?.activePipelineId || pipelines[0]?.id
  const active = pipelines.find((p) => p.id === activeId) || pipelines[0]

  /**
   * 进入「新建审查」默认空白页；只有点「新建流水线」或打开已有流水线后才展示看板。
   * 避免一进页就被上次配置/运行结果占满。
   */
  const [boardVisible, setBoardVisible] = useState(false)

  const [sourceOpen, setSourceOpen] = useState(false)
  const [methodsOpen, setMethodsOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [draftSource, setDraftSource] = useState({
    repoUrl: '',
    branch: '',
    prNumber: '',
    mcpServerId: ''
  })
  const [draftMethods, setDraftMethods] = useState<string[]>([])
  const [draftProviderId, setDraftProviderId] = useState('')
  const [draftFormats, setDraftFormats] = useState<ReportOutputFormat[]>(['md', 'html'])
  const [mcpRepos, setMcpRepos] = useState<McpRepoOption[]>([])
  const [mcpSources, setMcpSources] = useState<McpRepoSourceOption[]>([])
  const [mcpRepoLoading, setMcpRepoLoading] = useState(false)
  const [mcpRepoHint, setMcpRepoHint] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [sourceMode, setSourceMode] = useState<'mcp' | 'custom'>('custom')
  const [branchOptions, setBranchOptions] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchHint, setBranchHint] = useState('')
  const [methodCatalog, setMethodCatalog] = useState<ReviewMethodDef[]>(
    FALLBACK_REVIEW_METHOD_CATALOG
  )

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

  const sourceOptions = useMemo(() => {
    if (mcpSources.length <= 1) {
      return mcpSources.map((s) => ({
        value: s.serverId,
        label: `${s.serverName}${s.connected ? '' : '（未连接）'}`
      }))
    }
    return [
      { value: 'all', label: `全部来源（${mcpSources.length}）` },
      ...mcpSources.map((s) => ({
        value: s.serverId,
        label: `${s.serverName}${s.connected ? '' : '（未连接）'}`
      }))
    ]
  }, [mcpSources])

  const repoSelectOptions = useMemo(() => {
    const filtered =
      sourceFilter === 'all'
        ? mcpRepos
        : mcpRepos.filter((r) => r.serverId === sourceFilter)

    const groups = new Map<string, McpRepoOption[]>()
    for (const repo of filtered) {
      const key = repo.serverName || repo.provider
      const list = groups.get(key) ?? []
      list.push(repo)
      groups.set(key, list)
    }

    return Array.from(groups.entries()).map(([label, list]) => ({
      label,
      options: list.map((repo) => ({
        value: `${repo.serverId}||${repo.url}`,
        label: repo.fullName || repo.name,
        url: repo.url,
        serverId: repo.serverId,
        branch: repo.defaultBranch,
        provider: repo.provider
      }))
    }))
  }, [mcpRepos, sourceFilter])

  const flatRepoOptions = useMemo(
    () => repoSelectOptions.flatMap((g) => g.options),
    [repoSelectOptions]
  )

  const providers = (config?.llmProviders ?? []).filter((p) => p.enabled)
  const configuredGitMcp = useMemo(() => {
    const list = config?.mcpServers ?? []
    return list.some((s) => {
      const blob = [s.name, s.command, ...(s.args ?? []), ...Object.keys(s.env ?? {})]
        .join(' ')
        .toLowerCase()
      return /gitee|github|gitlab|码云|mcp-gitee|server-github|server-gitlab|gitee-mcp/.test(
        blob
      )
    })
  }, [config?.mcpServers])

  const loadMcpRepos = async (forceRefresh = false): Promise<void> => {
    setMcpRepoLoading(true)
    setMcpRepoHint('')
    try {
      const result = await window.electronAPI.listMcpRepos({ forceRefresh })
      setMcpRepos(result.repos)
      setMcpSources(result.sources)
      if (result.sources.length === 1) {
        setSourceFilter(result.sources[0].serverId)
      } else if (
        sourceFilter !== 'all' &&
        !result.sources.some((s) => s.serverId === sourceFilter)
      ) {
        setSourceFilter('all')
      }

      if (!result.sources.length) {
        setMcpRepoHint('')
      } else if (!result.repos.length) {
        setMcpRepoHint(
          result.errors.length
            ? result.errors.join('；')
            : '已配置的 Git MCP 暂无仓库，请确认已连接并配置了 ACCESS_TOKEN'
        )
      } else {
        const cacheNote = result.fromCache ? '（来自缓存，点刷新可更新）' : ''
        setMcpRepoHint(
          `已加载 ${result.repos.length} 个仓库${cacheNote}` +
            (result.errors.length ? `；${result.errors.join('；')}` : '')
        )
      }
    } catch (error) {
      setMcpRepos([])
      setMcpSources([])
      setMcpRepoHint(error instanceof Error ? error.message : '加载 MCP 仓库失败')
    } finally {
      setMcpRepoLoading(false)
    }
  }

  const loadMcpBranches = async (
    serverId: string,
    repoUrl: string,
    forceRefresh = false
  ): Promise<void> => {
    if (!serverId || !repoUrl.trim()) {
      setBranchOptions([])
      setBranchHint('')
      return
    }
    setBranchLoading(true)
    setBranchHint('')
    try {
      const result = await window.electronAPI.listMcpBranches({
        serverId,
        repoUrl,
        forceRefresh
      })
      setBranchOptions(result.branches)
      if (result.branches.length) {
        setDraftSource((s) => {
          const keep =
            s.branch && result.branches.includes(s.branch) ? s.branch : result.branches[0]
          return { ...s, branch: keep }
        })
        setBranchHint(
          `共 ${result.branches.length} 个分支` +
            (result.fromCache ? '（缓存）' : '')
        )
      } else {
        setBranchHint(result.error || '未查到分支')
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
    await persistPipelines(next, active.id)
  }

  const onAddPipeline = async (): Promise<void> => {
    if (!config) return
    const created = newPipeline(`流水线 ${pipelines.length + 1}`)
    if (config.activeLlmProviderId) created.llmProviderId = config.activeLlmProviderId
    await persistPipelines([...pipelines, created], created.id)
    setBoardVisible(true)
    message.success('已新建流水线')
  }

  const onOpenPipeline = async (id: string): Promise<void> => {
    if (!config) return
    await persistPipelines(pipelines, id)
    setBoardVisible(true)
  }

  const onDeletePipeline = async (): Promise<void> => {
    if (!active) return
    const next = pipelines.filter((p) => p.id !== active.id)
    await persistPipelines(next, next[0]?.id || '')
    if (!next.length) setBoardVisible(false)
    message.success(next.length ? '已删除流水线' : '已清空，可重新新建')
  }

  const openSource = (mode: 'mcp' | 'custom' = 'custom'): void => {
    if (!active) return
    setDraftSource({
      repoUrl: active.repoUrl || '',
      branch: active.branch || 'master',
      prNumber: active.prNumber || '',
      mcpServerId: mode === 'custom' ? '' : active.mcpServerId || ''
    })
    setSourceMode(mode === 'mcp' && configuredGitMcp ? 'mcp' : 'custom')
    setSourceOpen(true)
    setSourceFilter('all')
    setBranchOptions([])
    setBranchHint('')
    if (configuredGitMcp) {
      void loadMcpRepos().then(() => {
        if (mode === 'mcp' && active.mcpServerId && active.repoUrl) {
          void loadMcpBranches(active.mcpServerId, active.repoUrl)
        }
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

  const onStart = async (): Promise<void> => {
    if (!active) return
    if (!active.repoUrl.trim()) {
      message.warning('请先配置代码源')
      openSource()
      return
    }
    if (!active.methodIds?.length) {
      message.warning('请先选择审查方式')
      openMethods()
      return
    }
    if (!active.llmProviderId && !config?.activeLlmProviderId) {
      message.warning('请先选择模型')
      openModel()
      return
    }
    if (!active.reportFormats?.length) {
      message.warning('请先选择报告输出格式')
      openReport()
      return
    }
    try {
      await startReview({
        pipelineId: active.id,
        repoUrl: active.repoUrl.trim(),
        prNumber: active.prNumber?.trim() || undefined,
        commitSha: active.commitSha?.trim() || undefined,
        methodIds: active.methodIds,
        llmProviderId: active.llmProviderId || config?.activeLlmProviderId,
        reportFormats: active.reportFormats,
        forceRefresh: true
      })
      message.success('流水线审查完成')
      const reportId = useAppStore.getState().currentReport?.id
      navigate(reportId ? `/report?id=${encodeURIComponent(reportId)}` : '/report')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '审查失败')
    }
  }

  const selectedProvider =
    providers.find((p) => p.id === active?.llmProviderId) ||
    providers.find((p) => p.id === config?.activeLlmProviderId)

  const methodLabels = (active?.methodIds ?? [])
    .map((id) => methodCatalog.find((m) => m.id === id)?.name || id)
    .slice(0, 6)

  const errorCount = currentReport?.issues.filter((i) => i.severity === 'error').length ?? 0
  const warnCount = currentReport?.issues.filter((i) => i.severity === 'warning').length ?? 0

  if (!config) {
    return <div className="page">正在加载…</div>
  }

  if (!boardVisible || !active) {
    return (
      <div className="page pipe-page">
        <div className="pipe-empty">
          <div className="pipe-empty-title">新建审查</div>
          <div className="pipe-empty-desc">
            先新建一条流水线，再配置代码源、审查方式、模型与报告输出；配好后点启动才会开始审查。
          </div>
          <Button
            type="primary"
            size="large"
            icon={<PlusOutlined />}
            onClick={() => void onAddPipeline()}
          >
            新建流水线
          </Button>
          {pipelines.length > 0 ? (
            <div className="pipe-empty-list">
              <div className="pipe-empty-list-title">已有流水线</div>
              <div className="pipe-empty-list-items">
                {pipelines.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="pipe-empty-list-item"
                    onClick={() => void onOpenPipeline(p.id)}
                  >
                    <span className="pipe-empty-list-name">
                      {p.name || shortRepo(p.repoUrl)}
                    </span>
                    <span className="pipe-empty-list-meta">
                      {p.repoUrl ? shortRepo(p.repoUrl) : '未配置代码源'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="page pipe-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Pipeline</p>
          <h1 className="page-title">审查流水线</h1>
          <p className="page-sub">
            先配置代码源 → 审查方式 → 模型 → 报告输出，确认后再点击启动。一个项目一条流水线。
          </p>
        </div>
        <div className="actions">
          <Button onClick={() => setBoardVisible(false)}>返回</Button>
          <Select
            style={{ minWidth: 180 }}
            value={active.id}
            options={pipelines.map((p) => ({
              value: p.id,
              label: p.name || shortRepo(p.repoUrl)
            }))}
            onChange={(id) => void persistPipelines(pipelines, id)}
          />
          <Button icon={<PlusOutlined />} onClick={() => void onAddPipeline()}>
            新建流水线
          </Button>
          <Button danger icon={<DeleteOutlined />} onClick={() => void onDeletePipeline()}>
            删除
          </Button>
          <Button
            type="primary"
            size="large"
            icon={<PlayCircleOutlined />}
            loading={loading}
            onClick={() => void onStart()}
          >
            启动
          </Button>
          {loading && (
            <Button danger onClick={() => void cancelReview()}>
              取消
            </Button>
          )}
        </div>
      </div>

      <div className="pipe-board">
        <div className="pipe-stage">
          <div className="pipe-stage-title">代码源</div>
          <div className="pipe-stage-body">
            {active.repoUrl ? (
              <button
                type="button"
                className="pipe-card"
                onClick={() => openSource(active.mcpServerId ? 'mcp' : 'custom')}
              >
                <div className="pipe-card-main">
                  <ThunderboltOutlined className="pipe-card-bolt" />
                  <div>
                    <div className="pipe-card-name">{shortRepo(active.repoUrl)}</div>
                    <div className="pipe-card-meta">
                      {active.mcpServerId ? 'MCP' : '自定义 Git'} · {active.branch || 'master'}
                      {active.prNumber ? ` · PR #${active.prNumber}` : ''}
                    </div>
                  </div>
                </div>
              </button>
            ) : null}
            <button type="button" className="pipe-add" onClick={() => openSource('custom')}>
              + 自定义 Git
            </button>
            {configuredGitMcp ? (
              <button type="button" className="pipe-add ghost" onClick={() => openSource('mcp')}>
                + 从 MCP 选择
              </button>
            ) : null}
          </div>
        </div>

        <div className="pipe-connector">
          <span className="pipe-plus">+</span>
        </div>

        <div className="pipe-stage">
          <div className="pipe-stage-title">代码审查方式</div>
          <div className="pipe-stage-body">
            {methodLabels.length === 0 ? (
              <button type="button" className="pipe-add" onClick={openMethods}>
                + 选择审查方式
              </button>
            ) : (
              <>
                {methodLabels.map((label) => (
                  <button
                    key={label}
                    type="button"
                    className="pipe-pill"
                    onClick={openMethods}
                  >
                    <span className="pipe-pill-bolt">
                      <ThunderboltOutlined />
                    </span>
                    {label}
                  </button>
                ))}
                {(active.methodIds?.length ?? 0) > methodLabels.length && (
                  <button type="button" className="pipe-pill muted" onClick={openMethods}>
                    +{active.methodIds.length - methodLabels.length} 项
                  </button>
                )}
                <button type="button" className="pipe-add ghost" onClick={openMethods}>
                  + 调整审查方式
                </button>
              </>
            )}
          </div>
        </div>

        <div className="pipe-connector">
          <span className="pipe-plus">+</span>
        </div>

        <div className="pipe-stage">
          <div className="pipe-stage-title">模型配置</div>
          <div className="pipe-stage-body">
            {selectedProvider ? (
              <button type="button" className="pipe-pill" onClick={openModel}>
                <span className="pipe-pill-bolt">
                  <ThunderboltOutlined />
                </span>
                {selectedProvider.name} · {selectedProvider.model}
              </button>
            ) : (
              <button type="button" className="pipe-add" onClick={openModel}>
                + 选择模型
              </button>
            )}
          </div>
        </div>

        <div className="pipe-connector">
          <span className="pipe-plus">+</span>
        </div>

        <div className="pipe-stage">
          <div className="pipe-stage-title">生成报告</div>
          <div className="pipe-stage-body">
            {(active.reportFormats ?? []).length ? (
              <button type="button" className="pipe-pill" onClick={openReport}>
                <span className="pipe-pill-bolt">
                  <ThunderboltOutlined />
                </span>
                输出 {(active.reportFormats ?? []).map((f) => `.${f}`).join(' / ')}
              </button>
            ) : (
              <button type="button" className="pipe-add" onClick={openReport}>
                + 选择输出方式
              </button>
            )}
          </div>
        </div>
      </div>

      {currentReport && (
        <div className="card card-pad" style={{ marginTop: 20 }}>
          <div className="card-head">
            <div className="card-title">最近一次运行</div>
            <Button
              size="small"
              onClick={() =>
                navigate(
                  currentReport.id
                    ? `/report?id=${encodeURIComponent(currentReport.id)}`
                    : '/report'
                )
              }
            >
              查看报告
            </Button>
          </div>
          <Progress
            percent={currentReport.progress}
            status={
              currentReport.status === 'failed'
                ? 'exception'
                : currentReport.status === 'completed'
                  ? 'success'
                  : 'active'
            }
          />
          <p className="page-sub" style={{ marginTop: 8 }}>
            {currentReport.progressLabel}
            {currentReport.totalDurationMs != null
              ? ` · ${formatDuration(currentReport.totalDurationMs)}`
              : ''}
            {` · error ${errorCount} / warning ${warnCount}`}
          </p>
          {currentReport.flowTimeline && (
            <div style={{ marginTop: 12 }}>
              <FlowTimeline nodes={currentReport.flowTimeline} compact />
            </div>
          )}
        </div>
      )}

      <Modal
        title="配置代码源"
        open={sourceOpen}
        onCancel={() => setSourceOpen(false)}
        onOk={() => {
          if (!draftSource.repoUrl.trim()) {
            message.warning('请填写 Git 仓库地址')
            return
          }
          void updateActive({
            repoUrl: draftSource.repoUrl.trim(),
            branch: draftSource.branch.trim() || 'master',
            prNumber: draftSource.prNumber.trim() || undefined,
            mcpServerId:
              sourceMode === 'mcp' ? draftSource.mcpServerId || undefined : undefined,
            name: active.name.startsWith('流水线')
              ? shortRepo(draftSource.repoUrl)
              : active.name || shortRepo(draftSource.repoUrl)
          }).then(() => setSourceOpen(false))
        }}
        okText="保存"
      >
        <div className="pipe-form">
          {configuredGitMcp ? (
            <Segmented
              block
              style={{ marginBottom: 14 }}
              value={sourceMode}
              onChange={(v) => {
                const mode = v as 'mcp' | 'custom'
                setSourceMode(mode)
                if (mode === 'custom') {
                  setDraftSource((s) => ({ ...s, mcpServerId: '' }))
                  setBranchOptions([])
                  setBranchHint('')
                } else if (configuredGitMcp) {
                  void loadMcpRepos()
                }
              }}
              options={[
                { label: '自定义 Git', value: 'custom' },
                { label: '从 MCP 选择', value: 'mcp' }
              ]}
            />
          ) : null}

          {sourceMode === 'mcp' && configuredGitMcp ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6
                }}
              >
                <label style={{ margin: 0 }}>选择仓库</label>
                <Button
                  size="small"
                  loading={mcpRepoLoading}
                  onClick={() => void loadMcpRepos(true)}
                >
                  刷新
                </Button>
              </div>
              {mcpSources.length > 1 ? (
                <Select
                  value={sourceFilter}
                  options={sourceOptions}
                  onChange={setSourceFilter}
                  style={{ width: '100%', marginBottom: 8 }}
                  placeholder="按来源筛选"
                />
              ) : null}
              <Select
                allowClear
                showSearch
                loading={mcpRepoLoading}
                placeholder={mcpRepoLoading ? '加载仓库中…' : '选择仓库'}
                options={repoSelectOptions}
                optionFilterProp="label"
                value={
                  flatRepoOptions.find(
                    (o) =>
                      o.url === draftSource.repoUrl &&
                      (!draftSource.mcpServerId || o.serverId === draftSource.mcpServerId)
                  )?.value
                }
                onChange={(key) => {
                  const hit = flatRepoOptions.find((o) => o.value === key)
                  const nextUrl = hit?.url || ''
                  const nextServerId = hit?.serverId || ''
                  setDraftSource((s) => ({
                    ...s,
                    repoUrl: nextUrl,
                    mcpServerId: nextServerId,
                    branch: hit?.branch || s.branch || 'master'
                  }))
                  if (nextServerId && nextUrl) {
                    void loadMcpBranches(nextServerId, nextUrl)
                  } else {
                    setBranchOptions([])
                    setBranchHint('')
                  }
                }}
                style={{ width: '100%', marginBottom: 8 }}
              />
              {mcpRepoHint ? (
                <p className="page-sub" style={{ marginBottom: 12 }}>
                  {mcpRepoHint}
                </p>
              ) : null}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6
                }}
              >
                <label style={{ margin: 0 }}>分支</label>
                <Button
                  size="small"
                  loading={branchLoading}
                  disabled={!draftSource.repoUrl || !draftSource.mcpServerId}
                  onClick={() =>
                    void loadMcpBranches(
                      draftSource.mcpServerId,
                      draftSource.repoUrl,
                      true
                    )
                  }
                >
                  刷新分支
                </Button>
              </div>
              <Select
                showSearch
                loading={branchLoading}
                placeholder={
                  branchLoading
                    ? '正在查询分支…'
                    : draftSource.repoUrl
                      ? '选择分支'
                      : '请先选择仓库'
                }
                options={branchOptions.map((b) => ({ value: b, label: b }))}
                value={
                  branchOptions.includes(draftSource.branch) ? draftSource.branch : undefined
                }
                onChange={(branch) => setDraftSource((s) => ({ ...s, branch }))}
                style={{ width: '100%', marginBottom: 8 }}
                notFoundContent={branchHint || '暂无分支'}
              />
              {branchHint ? (
                <p className="page-sub" style={{ marginBottom: 12 }}>
                  {branchHint}
                </p>
              ) : null}
              <label>PR 号（可选）</label>
              <Input
                value={draftSource.prNumber}
                onChange={(e) => setDraftSource((s) => ({ ...s, prNumber: e.target.value }))}
                placeholder="12"
              />
            </>
          ) : (
            <>
              <p className="page-sub" style={{ marginBottom: 12 }}>
                无需配置 Git MCP，直接填写仓库地址与分支即可创建流水线。
              </p>
              <label>Git 仓库地址</label>
              <Input
                className="mono"
                value={draftSource.repoUrl}
                onChange={(e) =>
                  setDraftSource((s) => ({ ...s, repoUrl: e.target.value, mcpServerId: '' }))
                }
                placeholder="https://gitee.com/org/repo.git"
                style={{ marginBottom: 12 }}
              />
              <label>分支</label>
              <Input
                value={draftSource.branch}
                onChange={(e) => setDraftSource((s) => ({ ...s, branch: e.target.value }))}
                placeholder="master / main"
                style={{ marginBottom: 12 }}
              />
              <label>PR 号（可选）</label>
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
    </div>
  )
}

export default Dashboard
