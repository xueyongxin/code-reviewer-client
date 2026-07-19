/** 展示用短仓库名：owner/repo */
export const shortRepo = (url: string, fallback = '—'): string => {
  try {
    const cleaned = (url || '').replace(/\.git$/i, '')
    const parts = cleaned.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || url || fallback
  } catch {
    return url || fallback
  }
}

/** 从仓库 URL 解析项目文件夹名，如 …/org/code-reviewer-client.git → code-reviewer-client */
export const deriveRepoFolderName = (repoUrl: string): string => {
  try {
    const cleaned = repoUrl.trim().replace(/\.git$/i, '')
    const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`
    const u = new URL(withProto)
    const parts = u.pathname.split('/').filter(Boolean)
    const last = decodeURIComponent(parts[parts.length - 1] || 'repo')
    const safe = last.replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '')
    return safe || 'repo'
  } catch {
    return 'repo'
  }
}

/** 拼接本地路径（渲染进程无 path 模块时用） */
export const joinLocalPath = (...parts: string[]): string => {
  const filtered = parts.map((p) => p.trim()).filter(Boolean)
  if (!filtered.length) return ''
  const first = filtered[0]
  const sep = first.includes('\\') ? '\\' : '/'
  return filtered
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter(Boolean)
    .join(sep)
}

/**
 * 流水线工作区下的项目根目录：`{workDir}/{repoFolder}`
 * workDir 为配置的父目录；其下再按仓库名存放代码。
 */
export const resolvePipelineProjectRoot = (
  workDir: string | undefined,
  repoUrl: string | undefined
): string => {
  const parent = workDir?.trim()
  const url = repoUrl?.trim()
  if (!parent || !url) return ''
  return joinLocalPath(parent, deriveRepoFolderName(url))
}

/** 项目根下的分析报告目录 */
export const resolveAnalysisReportDir = (projectRoot: string): string =>
  projectRoot ? joinLocalPath(projectRoot, '分析报告') : ''
