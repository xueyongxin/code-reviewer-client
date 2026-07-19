import type { RecentIdeProject } from '../../../shared/types'

export type { RecentIdeProject }

const MAX_ITEMS = 12
const LEGACY_STORAGE_KEY = 'cr.recentIdeProjects'

export const recentProjectLabel = (item: RecentIdeProject): string => {
  if (item.kind === 'local') {
    return item.localPath || item.projectName || '本地项目'
  }
  const pipe = item.pipelineName?.trim() || '未命名流水线'
  const project = item.projectName?.trim() || item.repoUrl || '未命名项目'
  return `${pipe} ${project}`
}

/** 列表展示：主标题 + 副标题 */
export const recentProjectDisplay = (
  item: RecentIdeProject
): { title: string; subtitle: string } => {
  if (item.kind === 'local') {
    const path = item.localPath || ''
    const name =
      item.projectName ||
      path.split(/[/\\]/).filter(Boolean).pop() ||
      '本地项目'
    return { title: name, subtitle: path || '本地文件夹' }
  }
  const pipe = item.pipelineName?.trim() || '未命名流水线'
  const project =
    item.projectName?.trim() ||
    item.repoUrl?.split('/').filter(Boolean).pop() ||
    '未命名项目'
  return { title: project, subtitle: `流水线 ${pipe}` }
}

export const normalizeRecentIdeProjects = (
  list: RecentIdeProject[] | undefined | null
): RecentIdeProject[] => {
  if (!Array.isArray(list)) return []
  return list
    .filter(
      (x) =>
        x &&
        typeof x.id === 'string' &&
        (x.kind === 'local' || x.kind === 'pipeline')
    )
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, MAX_ITEMS)
}

/** 一次性从旧 localStorage 迁移到本地配置库 */
export const readLegacyRecentIdeProjects = (): RecentIdeProject[] => {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return []
    const list = normalizeRecentIdeProjects(JSON.parse(raw) as RecentIdeProject[])
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    return list
  } catch {
    return []
  }
}

export const rememberRecentIdeProject = (
  list: RecentIdeProject[],
  item: Omit<RecentIdeProject, 'openedAt' | 'id'> & { id?: string }
): RecentIdeProject[] => {
  const id =
    item.id ||
    (item.kind === 'local'
      ? `local:${item.localPath || ''}`
      : `pipeline:${item.pipelineId || item.repoUrl || ''}`)
  const nextItem: RecentIdeProject = {
    ...item,
    id,
    openedAt: Date.now()
  }
  const prev = normalizeRecentIdeProjects(list).filter((p) => p.id !== id)
  return [nextItem, ...prev].slice(0, MAX_ITEMS)
}

export const removeRecentIdeProject = (
  list: RecentIdeProject[],
  id: string
): RecentIdeProject[] =>
  normalizeRecentIdeProjects(list).filter((p) => p.id !== id)

/** 删除流水线时同步清理最近打开中的对应项 */
export const removeRecentByPipelineId = (
  list: RecentIdeProject[],
  pipelineId: string
): RecentIdeProject[] => {
  if (!pipelineId) return normalizeRecentIdeProjects(list)
  return normalizeRecentIdeProjects(list).filter(
    (p) => !(p.kind === 'pipeline' && p.pipelineId === pipelineId)
  )
}

/** 流水线改名后同步最近打开列表中的名称 */
export const patchRecentPipelineMeta = (
  list: RecentIdeProject[],
  pipelineId: string,
  patch: { pipelineName?: string; projectName?: string; repoUrl?: string }
): RecentIdeProject[] => {
  if (!pipelineId) return normalizeRecentIdeProjects(list)
  return normalizeRecentIdeProjects(list).map((item) => {
    if (item.kind !== 'pipeline' || item.pipelineId !== pipelineId) return item
    return {
      ...item,
      ...(patch.pipelineName != null ? { pipelineName: patch.pipelineName } : {}),
      ...(patch.projectName != null ? { projectName: patch.projectName } : {}),
      ...(patch.repoUrl != null ? { repoUrl: patch.repoUrl } : {})
    }
  })
}
