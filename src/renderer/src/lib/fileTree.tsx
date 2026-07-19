import type { ReactNode } from 'react'
import type { DataNode } from 'antd/es/tree'
import {
  FolderOpenOutlined,
  FolderOutlined
} from '@ant-design/icons'
import type { RepoFileEntry } from '../../../shared/types'
import { FileTypeIcon } from '../components/FileTypeIcon'

export const formatFileSize = (bytes?: number): string => {
  if (bytes == null || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type BuildOptions = {
  /** 自定义文件标题（默认文件名；可加角标等） */
  renderFileTitle?: (entry: {
    name: string
    path: string
    tooLarge?: boolean
    size?: number
  }) => ReactNode
}

type TreeNode = DataNode & {
  childrenMap?: Map<string, TreeNode>
  name?: string
}

/**
 * 由 RepoFileEntry 列表构建 Ant Design Tree 数据（目录优先、名称排序）
 */
const HIDDEN_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'Desktop.ini'])

const isHiddenEntry = (path: string): boolean => {
  const base = path.replace(/\\/g, '/').split('/').pop() || ''
  return HIDDEN_BASENAMES.has(base)
}

export const buildRepoFileTree = (
  entries: RepoFileEntry[],
  options: BuildOptions = {}
): DataNode[] => {
  const root: TreeNode = {
    key: '',
    title: '',
    children: [],
    childrenMap: new Map()
  }
  const meta = new Map<string, RepoFileEntry>()
  for (const f of entries) {
    const norm = f.path.replace(/\\/g, '/')
    if (isHiddenEntry(norm)) continue
    meta.set(norm, f)
  }

  const ensure = (
    parent: TreeNode,
    name: string,
    fullPath: string,
    isDir: boolean,
    entry?: RepoFileEntry
  ): TreeNode => {
    if (!parent.childrenMap) parent.childrenMap = new Map()
    let child = parent.childrenMap.get(name)
    if (!child) {
      const tooLarge = Boolean(entry?.tooLarge)
      const sizeHint = tooLarge ? formatFileSize(entry?.size) : ''
      const defaultTitle = (
        <span
          className={`repo-tree-label${tooLarge ? ' is-too-large' : ''}`}
          title={
            tooLarge
              ? `${fullPath}（过大，约 ${sizeHint}，无法预览）`
              : fullPath
          }
        >
          {name}
          {tooLarge ? (
            <span className="repo-tree-size-tag">过大 {sizeHint}</span>
          ) : null}
        </span>
      )
      child = {
        key: fullPath,
        name,
        title: isDir
          ? (
              <span className="repo-tree-label" title={fullPath}>
                {name}
              </span>
            )
          : options.renderFileTitle
            ? options.renderFileTitle({
                name,
                path: fullPath,
                tooLarge,
                size: entry?.size
              })
            : defaultTitle,
        isLeaf: !isDir,
        icon: ({ expanded }: { expanded?: boolean }) =>
          isDir ? (
            expanded ? (
              <FolderOpenOutlined className="repo-folder-icon is-open" />
            ) : (
              <FolderOutlined className="repo-folder-icon" />
            )
          ) : (
            <FileTypeIcon name={name} />
          ),
        children: isDir ? [] : undefined,
        childrenMap: isDir ? new Map() : undefined
      }
      parent.childrenMap.set(name, child)
      parent.children = Array.from(parent.childrenMap.values())
    }
    return child
  }

  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, '/')
    if (isHiddenEntry(path)) continue
    const parts = path.split('/').filter(Boolean)
    let cur = root
    parts.forEach((part, idx) => {
      const full = parts.slice(0, idx + 1).join('/')
      const isLast = idx === parts.length - 1
      const isDir = !isLast || entry.type === 'dir'
      cur = ensure(cur, part, full, isDir, isLast ? entry : meta.get(full))
    })
  }

  const sortNodes = (nodes: DataNode[] | undefined): DataNode[] => {
    if (!nodes) return []
    return [...nodes]
      .map((n) => ({
        ...n,
        children: n.children ? sortNodes(n.children) : n.children
      }))
      .sort((a, b) => {
        const ad = a.isLeaf ? 1 : 0
        const bd = b.isLeaf ? 1 : 0
        if (ad !== bd) return ad - bd
        return String((a as TreeNode).name || a.key).localeCompare(
          String((b as TreeNode).name || b.key)
        )
      })
  }

  return sortNodes(root.children)
}
