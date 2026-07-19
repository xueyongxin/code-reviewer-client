import { useEffect, useState, useRef } from 'react'
import { formatDateTime, formatDuration } from '../../../shared/datetime'
import type { FlowNodeStatus, ReviewFlowNode } from '../../../shared/types'

const STATUS_LABEL: Record<FlowNodeStatus, string> = {
  pending: '等待',
  running: '进行中',
  success: '完成',
  skipped: '跳过',
  failed: '失败'
}

/** 解析节点耗时：优先 durationMs，否则用起止时间推算；进行中用当前时刻 */
const resolveDurationMs = (
  node: ReviewFlowNode,
  nowMs: number
): number | undefined => {
  if (node.status === 'running' && node.startedAt) {
    const start = Date.parse(node.startedAt)
    if (!Number.isNaN(start)) return Math.max(0, nowMs - start)
  }
  if (node.durationMs != null && !Number.isNaN(node.durationMs)) {
    return Math.max(0, node.durationMs)
  }
  if (node.startedAt && node.endedAt) {
    const start = Date.parse(node.startedAt)
    const end = Date.parse(node.endedAt)
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      return Math.max(0, end - start)
    }
  }
  if (node.status === 'skipped') return 0
  return undefined
}

interface Props {
  nodes: ReviewFlowNode[]
  totalDurationMs?: number
  compact?: boolean
  /** 自动滚到当前进行中的节点 */
  followRunning?: boolean
}

const FlowTimeline = ({
  nodes,
  totalDurationMs,
  compact,
  followRunning
}: Props): JSX.Element => {
  const rootRef = useRef<HTMLDivElement>(null)
  const runningKey = nodes?.find((n) => n.status === 'running')?.id
  const hasRunning = Boolean(runningKey)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!hasRunning) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [hasRunning, runningKey])

  useEffect(() => {
    if (!followRunning || !runningKey || !rootRef.current) return
    const el = rootRef.current.querySelector('.flow-node.running')
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [followRunning, runningKey, nodes?.length])

  if (!nodes?.length) {
    return <div className="empty" style={{ padding: '12px 0' }}>暂无流程节点</div>
  }

  const liveTotal = hasRunning
    ? (() => {
        let min = Infinity
        for (const n of nodes) {
          if (!n.startedAt) continue
          const t = Date.parse(n.startedAt)
          if (!Number.isNaN(t)) min = Math.min(min, t)
        }
        return min === Infinity ? totalDurationMs : Math.max(0, nowMs - min)
      })()
    : totalDurationMs

  return (
    <div
      ref={rootRef}
      className={`flow-timeline ${compact ? 'compact' : ''}${followRunning ? ' is-live' : ''}`}
    >
      <div className="flow-timeline-head">
        <span>流程节点</span>
        <span className="mono">总耗时 {formatDuration(liveTotal)}</span>
      </div>
      <ol className="flow-list">
        {nodes.map((node, index) => {
          const isCheck = node.id.startsWith('check:')
          const dur = resolveDurationMs(node, nowMs)
          const startClock = formatDateTime(node.startedAt)
          const endClock =
            node.status === 'running' ? '进行中' : formatDateTime(node.endedAt)
          return (
            <li
              key={`${node.id}-${index}`}
              className={`flow-node ${node.status}${isCheck ? ' is-check' : ''}`}
            >
              <div className="flow-rail">
                <span className="flow-dot" />
                {index < nodes.length - 1 && <span className="flow-line" />}
              </div>
              <div className="flow-body">
                <div className="flow-title-row">
                  <span className="flow-name">{node.name}</span>
                  <span className={`flow-status ${node.status}`}>
                    {STATUS_LABEL[node.status] ?? node.status}
                  </span>
                  <span className="flow-dur mono" title="本步耗时">
                    {formatDuration(dur)}
                  </span>
                </div>
                {node.detail && <div className="flow-detail">{node.detail}</div>}
                {startClock ? (
                  <div className="flow-time mono" title="本步执行时间">
                    {startClock}
                    {endClock ? ` → ${endClock}` : ''}
                    {dur != null ? ` · ${formatDuration(dur)}` : ''}
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default FlowTimeline
export { formatDuration }
