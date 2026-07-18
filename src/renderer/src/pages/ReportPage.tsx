import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Empty, Table, Tag, message } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import DiffViewer from '../components/DiffViewer'
import FlowTimeline, { formatDuration } from '../components/FlowTimeline'
import { useAppStore } from '../store/useAppStore'
import type { ReviewIssue, ReviewReport } from '../../../shared/types'

const shortRepo = (url: string): string => {
  try {
    const cleaned = url.replace(/\.git$/, '')
    const parts = cleaned.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || url || '—'
  } catch {
    return url || '—'
  }
}

const formatTime = (iso?: string): string => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('zh-CN')
  } catch {
    return iso
  }
}

const statusTag = (status: ReviewReport['status']) => {
  const map: Record<
    ReviewReport['status'],
    { color: string; text: string }
  > = {
    pending: { color: 'default', text: '等待中' },
    running: { color: 'processing', text: '进行中' },
    completed: { color: 'success', text: '已完成' },
    failed: { color: 'error', text: '失败' },
    cancelled: { color: 'warning', text: '已取消' }
  }
  const m = map[status] || { color: 'default', text: status }
  return <Tag color={m.color}>{m.text}</Tag>
}

const ReportPage = (): JSX.Element => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const detailId = searchParams.get('id')

  const currentReport = useAppStore((s) => s.currentReport)
  const history = useAppStore((s) => s.history)
  const loadReport = useAppStore((s) => s.loadReport)
  const postPrComments = useAppStore((s) => s.postPrComments)
  const bootstrap = useAppStore((s) => s.bootstrap)

  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [focusLine, setFocusLine] = useState<number | undefined>(undefined)
  const [sourceFilter, setSourceFilter] = useState<'all' | 'static' | 'llm' | 'custom'>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [posting, setPosting] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)

  useEffect(() => {
    if (!history.length) {
      void bootstrap()
    }
  }, [history.length, bootstrap])

  useEffect(() => {
    if (!detailId) return
    if (currentReport?.id === detailId) return
    setLoadingDetail(true)
    void loadReport(detailId)
      .catch((e) => message.error(e instanceof Error ? e.message : '加载报告失败'))
      .finally(() => setLoadingDetail(false))
  }, [detailId, currentReport?.id, loadReport])

  useEffect(() => {
    setActiveFile(null)
    setFocusLine(undefined)
    setSelectedIds([])
    setSourceFilter('all')
  }, [detailId])

  const openDetail = (id: string): void => {
    setSearchParams({ id })
  }

  const backToList = (): void => {
    setSearchParams({})
  }

  const files = currentReport?.files ?? []
  const selectedPath = activeFile ?? files[0]?.filePath ?? null
  const selectedFile = files.find((f) => f.filePath === selectedPath) ?? files[0]

  const filteredIssues = useMemo(() => {
    if (!currentReport) return [] as ReviewIssue[]
    return currentReport.issues.filter((issue) => {
      if (sourceFilter !== 'all' && issue.source !== sourceFilter) return false
      return true
    })
  }, [currentReport, sourceFilter])

  const fileIssues = useMemo(() => {
    if (!selectedFile) return [] as ReviewIssue[]
    return filteredIssues.filter((issue) => issue.filePath === selectedFile.filePath)
  }, [filteredIssues, selectedFile])

  // —— 列表视图 ——
  if (!detailId) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">Records</p>
            <h1 className="page-title">审查记录</h1>
            <p className="page-sub">本地已完成的审查任务，点击「查看报告」看详情与 Diff。</p>
          </div>
          <div className="actions">
            <Button type="primary" onClick={() => navigate('/review')}>
              去新建审查
            </Button>
          </div>
        </div>

        {history.length === 0 ? (
          <div className="card card-pad">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无审查记录"
            />
          </div>
        ) : (
          <div className="card">
            <Table
              className="records-table"
              rowKey="id"
              dataSource={history}
              scroll={{ x: 780 }}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              columns={[
                {
                  title: '仓库',
                  dataIndex: 'repoUrl',
                  ellipsis: true,
                  render: (url: string) => (
                    <div>
                      <div className="records-repo">{shortRepo(url)}</div>
                      <div className="records-repo-url mono">{url}</div>
                    </div>
                  )
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 100,
                  render: (s: ReviewReport['status']) => statusTag(s)
                },
                {
                  title: '问题',
                  width: 120,
                  render: (_, r) => {
                    const err = r.issues.filter((i) => i.severity === 'error').length
                    const warn = r.issues.filter((i) => i.severity === 'warning').length
                    return (
                      <span>
                        {r.issues.length}（E{err}/W{warn}）
                      </span>
                    )
                  }
                },
                {
                  title: '耗时',
                  width: 100,
                  render: (_, r) => formatDuration(r.totalDurationMs)
                },
                {
                  title: '时间',
                  dataIndex: 'createdAt',
                  width: 170,
                  render: (v: string) => formatTime(v)
                },
                {
                  title: '操作',
                  width: 120,
                  fixed: 'right',
                  render: (_, r) => (
                    <Button type="link" size="small" onClick={() => openDetail(r.id)}>
                      查看报告
                    </Button>
                  )
                }
              ]}
            />
          </div>
        )}
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
  const warnCount = currentReport.issues.filter((i) => i.severity === 'warning').length
  const infoCount = currentReport.issues.filter((i) => i.severity === 'info').length
  const llmCount = currentReport.issues.filter((i) => i.source === 'llm').length

  const toggleIssue = (id: string, checked: boolean): void => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((item) => item !== id)))
  }

  const onPostComments = async (): Promise<void> => {
    if (!selectedIds.length) {
      message.warning('请先勾选要回写的问题')
      return
    }
    setPosting(true)
    try {
      const result = await postPrComments({
        reportId: currentReport.id,
        issueIds: selectedIds
      })
      message.info(`回写完成：成功 ${result.posted}，失败 ${result.failed}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '回写失败')
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Records</p>
          <h1 className="page-title">审查报告</h1>
          <p className="page-sub">
            <span className="mono">{currentReport.repoUrl}</span>
            {currentReport.prNumber ? ` · PR #${currentReport.prNumber}` : ''}
            {currentReport.fromCache ? ' · cache' : ''}
            {currentReport.pullSource ? ` · ${currentReport.pullSource}` : ''}
            {currentReport.totalDurationMs != null
              ? ` · ${formatDuration(currentReport.totalDurationMs)}`
              : ''}
          </p>
        </div>
        <div className="actions">
          <Button icon={<ArrowLeftOutlined />} onClick={backToList}>
            返回列表
          </Button>
          <Button
            disabled={!currentReport.prNumber || !selectedIds.length}
            loading={posting}
            onClick={() => void onPostComments()}
          >
            回写 PR 评论 ({selectedIds.length})
          </Button>
          <Button onClick={() => navigate('/review')}>再审一次</Button>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 14 }}>
        <div className="stat">
          <div className="stat-label">Errors</div>
          <div className="stat-value">{errorCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Warnings</div>
          <div className="stat-value">{warnCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Info</div>
          <div className="stat-value">{infoCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">LLM</div>
          <div className="stat-value">{llmCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">总耗时</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {formatDuration(currentReport.totalDurationMs)}
          </div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <div className="card-title">完整审查流程 · 节点扭转与耗时</div>
        </div>
        <FlowTimeline
          nodes={currentReport.flowTimeline ?? []}
          totalDurationMs={currentReport.totalDurationMs}
        />
      </div>

      <div className="review-layout">
        <div className="card review-files">
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="card-title">Changed files</div>
          </div>
          <div className="file-list">
            {files.map((file) => (
              <button
                key={file.filePath}
                type="button"
                className={`file-item ${selectedFile?.filePath === file.filePath ? 'active' : ''}`}
                onClick={() => {
                  setActiveFile(file.filePath)
                  setFocusLine(undefined)
                }}
              >
                <div className="file-item-name mono">{file.filePath}</div>
                <div className="file-item-meta">{file.issues.length} issues</div>
              </button>
            ))}
            {files.length === 0 && <div className="empty">无文件</div>}
          </div>
        </div>

        <div className="review-main">
          <div className="card diff-card">
            <div className="card-pad diff-card-head">
              <div className="card-title mono">{selectedFile?.filePath ?? '—'}</div>
              <Tag>{selectedFile?.language || 'plaintext'}</Tag>
            </div>
            {selectedFile ? (
              <DiffViewer
                key={selectedFile.filePath}
                original={selectedFile.originalContent ?? ''}
                modified={selectedFile.content}
                language={selectedFile.language || 'plaintext'}
                issues={fileIssues}
                focusLine={focusLine}
              />
            ) : (
              <div className="empty">选择左侧文件查看 Diff</div>
            )}
          </div>

          <div className="card">
            <div
              className="card-pad"
              style={{ paddingBottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}
            >
              <div className="card-title" style={{ marginRight: 'auto' }}>
                Problems · {filteredIssues.length}
              </div>
              <Button size="small" onClick={() => setSelectedIds(filteredIssues.map((i) => i.id))}>
                全选
              </Button>
              <Button size="small" onClick={() => setSelectedIds([])}>
                清空
              </Button>
              {(['all', 'static', 'llm', 'custom'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`chip-tab ${sourceFilter === key ? 'active' : ''}`}
                  onClick={() => setSourceFilter(key)}
                >
                  {key}
                </button>
              ))}
            </div>
            {filteredIssues.length === 0 ? (
              <div className="empty">未发现问题</div>
            ) : (
              <div className="issue-list">
                {filteredIssues.map((issue) => (
                  <div
                    key={issue.id}
                    className="issue-row"
                    onClick={() => {
                      setActiveFile(issue.filePath)
                      setFocusLine(issue.line)
                    }}
                  >
                    <Checkbox
                      checked={selectedIds.includes(issue.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => toggleIssue(issue.id, e.target.checked)}
                    />
                    <div className={`sev ${issue.severity}`}>{issue.severity}</div>
                    <div>
                      <div className="issue-msg">{issue.message}</div>
                      <div className="issue-path">
                        {issue.filePath} · {issue.ruleId} · {issue.source}
                      </div>
                    </div>
                    <div className="issue-line">L{issue.line}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card card-pad">
            <div className="card-head">
              <div className="card-title">Summary</div>
            </div>
            <pre className="md-box">{currentReport.summaryMarkdown || '（无摘要）'}</pre>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ReportPage
