import type { ReviewPipeline } from './types'

const defaultCreateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `pipe-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const fingerprint = (p: Pick<ReviewPipeline, 'name' | 'repoUrl'>): string =>
  `${(p.name || '').trim().toLowerCase()}||${(p.repoUrl || '').trim().toLowerCase()}`

/**
 * 规范化流水线列表，保证 ID 幂等：
 * - 已有合法且唯一的 id → 原样保留（反复保存不变）
 * - 空 id → 优先按「名称+仓库」从旧列表找回，否则新建
 * - 重复 id → 首次保留，后续项重新分配（尽量从旧列表按指纹找回）
 * - activePipelineId 必须落在有效 id 上
 */
export const normalizeReviewPipelines = (
  list: ReviewPipeline[] | undefined | null,
  options?: {
    previous?: ReviewPipeline[]
    activePipelineId?: string
    createId?: () => string
  }
): { pipelines: ReviewPipeline[]; activePipelineId: string } => {
  const createId = options?.createId || defaultCreateId
  const incoming = Array.isArray(list) ? list : []
  const previous = Array.isArray(options?.previous) ? options!.previous! : []

  const prevById = new Map<string, ReviewPipeline>()
  const prevByFp = new Map<string, ReviewPipeline>()
  for (const p of previous) {
    const id = (p.id || '').trim()
    if (id && !prevById.has(id)) prevById.set(id, p)
    const fp = fingerprint(p)
    if (fp !== '||' && !prevByFp.has(fp)) prevByFp.set(fp, p)
  }

  const used = new Set<string>()
  const pipelines: ReviewPipeline[] = []

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue
    let id = (raw.id || '').trim()

    if (id && used.has(id)) {
      // 冲突：尝试按指纹找回另一条旧 id，否则新建
      const hit = prevByFp.get(fingerprint(raw))
      const recovered = hit?.id?.trim()
      id = recovered && !used.has(recovered) ? recovered : createId()
    } else if (!id) {
      const hit = prevByFp.get(fingerprint(raw))
      const recovered = hit?.id?.trim()
      id = recovered && !used.has(recovered) ? recovered : createId()
    }

    used.add(id)
    pipelines.push({
      ...raw,
      id,
      name: raw.name || '',
      repoUrl: raw.repoUrl || '',
      methodIds: Array.isArray(raw.methodIds) ? [...raw.methodIds] : [],
      reportFormats: Array.isArray(raw.reportFormats)
        ? [...raw.reportFormats]
        : ['md', 'html'],
      updatedAt: raw.updatedAt || new Date().toISOString()
    })
  }

  const ids = new Set(pipelines.map((p) => p.id))
  let activePipelineId = (options?.activePipelineId || '').trim()
  if (!activePipelineId || !ids.has(activePipelineId)) {
    activePipelineId = pipelines[0]?.id || ''
  }

  return { pipelines, activePipelineId }
}
