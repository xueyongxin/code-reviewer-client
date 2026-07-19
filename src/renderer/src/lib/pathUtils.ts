/** 路径工具（渲染进程） */

/** 某路径的全部祖先目录，如 a/b/c → ['a','a/b'] */
export const parentDirsOf = (path: string): string[] => {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const dirs: string[] = []
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join('/'))
  }
  return dirs
}

/** 父目录相对路径；文件取所在目录，目录取自身 */
export const parentDirOf = (path: string, isDir = false): string => {
  const normalized = path.replace(/\\/g, '/')
  if (isDir) return normalized
  const parts = normalized.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

export const baseNameOf = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}
