/**
 * IDE 工作区模式约定（本地文件夹 vs 流水线仓库）。
 * 流水线若配置了 workDir，打开时优先走本地 `{workDir}/{repo}`（local）；
 * 未配置时才用远程缓存 clone（pipeline）。
 */

export type IdeWorkspaceKind = 'none' | 'local' | 'pipeline'

export const resolveIdeWorkspaceKind = (input: {
  workspaceClosed?: boolean
  localRoot?: string
  repoUrl?: string
}): IdeWorkspaceKind => {
  if (input.workspaceClosed) return 'none'
  if (input.localRoot?.trim()) return 'local'
  if (input.repoUrl?.trim()) return 'pipeline'
  return 'none'
}

/**
 * 顶栏/看板 navigate 进入「无工作目录」的流水线 IDE 时，应退出本机文件夹模式。
 * 已配置 workDir 的流水线由 RepoEditorPage 直接打开本地项目根，不适用此清理。
 */
export const shouldLeaveLocalOnPipelineNav = (input: {
  wantsPipeline: boolean
  navKeyChanged: boolean
  hasLocalRoot: boolean
}): boolean =>
  input.wantsPipeline && input.navKeyChanged && input.hasLocalRoot
