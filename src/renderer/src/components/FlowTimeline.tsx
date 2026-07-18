import type { ReviewFlowNode } from '../../../shared/types'

const formatDuration = (ms?: number): string => {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(1)
  return `${m}m ${s}s`
}

interface Props {
  nodes: ReviewFlowNode[]
  totalDurationMs?: number
  compact?: boolean
}

const FlowTimeline = ({ nodes, totalDurationMs, compact }: Props): JSX.Element => {
  if (!nodes?.length) {
    return <div className="empty" style={{ padding: '12px 0' }}>暂无流程节点</div>
  }

  return (
    <div className={`flow-timeline ${compact ? 'compact' : ''}`}>
      <div className="flow-timeline-head">
        <span>流程节点</span>
        <span className="mono">总耗时 {formatDuration(totalDurationMs)}</span>
      </div>
      <ol className="flow-list">
        {nodes.map((node, index) => (
          <li key={`${node.id}-${index}`} className={`flow-node ${node.status}`}>
            <div className="flow-rail">
              <span className="flow-dot" />
              {index < nodes.length - 1 && <span className="flow-line" />}
            </div>
            <div className="flow-body">
              <div className="flow-title-row">
                <span className="flow-name">{node.name}</span>
                <span className={`flow-status ${node.status}`}>{node.status}</span>
                <span className="flow-dur mono">{formatDuration(node.durationMs)}</span>
              </div>
              {node.detail && <div className="flow-detail">{node.detail}</div>}
              {!compact && (node.startedAt || node.endedAt) && (
                <div className="flow-time mono">
                  {node.startedAt
                    ? new Date(node.startedAt).toLocaleTimeString('zh-CN')
                    : ''}
                  {node.endedAt
                    ? ` → ${new Date(node.endedAt).toLocaleTimeString('zh-CN')}`
                    : ''}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

export default FlowTimeline
export { formatDuration }
