import type { ReviewFlowNode, FlowNodeStatus } from '../../shared/types'

/** 格式化耗时展示 */
export const formatDuration = (ms?: number): string => {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(1)
  return `${m}m ${s}s`
}

export class FlowTracker {
  private nodes: ReviewFlowNode[] = []
  private startedAt = new Map<string, number>()
  private pipelineStart = Date.now()

  begin(id: string, name: string, detail?: string): ReviewFlowNode[] {
    const now = Date.now()
    this.startedAt.set(id, now)
    const existing = this.nodes.findIndex((n) => n.id === id)
    const node: ReviewFlowNode = {
      id,
      name,
      status: 'running',
      startedAt: new Date(now).toISOString(),
      detail
    }
    if (existing >= 0) this.nodes[existing] = node
    else this.nodes.push(node)
    return this.snapshot()
  }

  end(
    id: string,
    status: Exclude<FlowNodeStatus, 'pending' | 'running'>,
    detail?: string
  ): ReviewFlowNode[] {
    const now = Date.now()
    const start = this.startedAt.get(id) ?? now
    const idx = this.nodes.findIndex((n) => n.id === id)
    const prev: ReviewFlowNode =
      idx >= 0
        ? this.nodes[idx]
        : { id, name: id, status: 'running', startedAt: new Date(start).toISOString() }
    const node: ReviewFlowNode = {
      ...prev,
      id,
      name: prev.name || id,
      status,
      startedAt: prev.startedAt || new Date(start).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationMs: Math.max(0, now - start),
      detail: detail ?? prev.detail
    }
    if (idx >= 0) this.nodes[idx] = node
    else this.nodes.push(node)
    return this.snapshot()
  }

  skip(id: string, name: string, detail?: string): ReviewFlowNode[] {
    const now = new Date().toISOString()
    const node: ReviewFlowNode = {
      id,
      name,
      status: 'skipped',
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      detail
    }
    const idx = this.nodes.findIndex((n) => n.id === id)
    if (idx >= 0) this.nodes[idx] = node
    else this.nodes.push(node)
    return this.snapshot()
  }

  snapshot(): ReviewFlowNode[] {
    return this.nodes.map((n) => ({ ...n }))
  }

  totalMs(): number {
    return Math.max(0, Date.now() - this.pipelineStart)
  }

  pipelineStartedAt(): number {
    return this.pipelineStart
  }
}
