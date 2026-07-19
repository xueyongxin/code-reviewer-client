import { useCallback, useMemo, type ReactNode } from 'react'
import { Dropdown, Input, Modal, message } from 'antd'
import type { MenuProps } from 'antd'
import { joinLocalPath } from '../../../shared/repo-path'
import { copyText } from '../lib/clipboard'
import { baseNameOf, parentDirOf } from '../lib/pathUtils'

export type ExplorerCtxTarget = { path: string; isDir: boolean } | null

/** 可替换的本地/远程文件操作（默认走 local IPC；rename/remove 可选） */
export type ExplorerFsAdapter = {
  createFile: (relPath: string) => Promise<void>
  createDir: (relPath: string) => Promise<void>
  rename?: (
    relPath: string,
    newName: string
  ) => Promise<{ filePath: string }>
  remove?: (relPath: string) => Promise<void>
}

export const createLocalFsAdapter = (rootPath: string): ExplorerFsAdapter => ({
  createFile: async (relPath) => {
    await window.electronAPI.writeLocalFile({
      rootPath,
      filePath: relPath,
      content: ''
    })
  },
  createDir: async (relPath) => {
    await window.electronAPI.createLocalDir({
      rootPath,
      dirPath: relPath
    })
  },
  rename: async (relPath, newName) =>
    window.electronAPI.renameLocalEntry({
      rootPath,
      filePath: relPath,
      newName
    }),
  remove: async (relPath) => {
    await window.electronAPI.deleteLocalEntry({
      rootPath,
      filePath: relPath
    })
  }
})

const askName = (title: string, initial: string): Promise<string | null> =>
  new Promise((resolve) => {
    let draft = initial
    Modal.confirm({
      centered: true,
      title,
      content: (
        <Input
          defaultValue={initial}
          autoFocus
          onChange={(e) => {
            draft = e.target.value
          }}
          onPressEnter={(e) => {
            e.preventDefault()
            const el = document.querySelector(
              '.ant-modal-confirm-btns .ant-btn-primary'
            ) as HTMLButtonElement | null
            el?.click()
          }}
        />
      ),
      okText: '确定',
      cancelText: '取消',
      onOk: () => {
        const name = draft.trim().replace(/[\\/]/g, '')
        resolve(name || null)
      },
      onCancel: () => resolve(null)
    })
  })

type Props = {
  /** 工作区绝对根路径；空则禁用文件操作 */
  rootPath: string
  target: ExplorerCtxTarget
  onTargetChange: (t: ExplorerCtxTarget) => void
  onOpenFile?: (relPath: string) => void
  onRefresh: () => void | Promise<void>
  onAfterCreate?: (info: { kind: 'file' | 'dir'; path: string }) => void
  onAfterRename?: (info: {
    from: string
    to: string
    isDir: boolean
  }) => void
  onAfterDelete?: (info: { path: string; isDir: boolean }) => void
  /** 未传则 rootPath 非空时用本地 IPC */
  fs?: ExplorerFsAdapter
  /** IDE：打开文件夹 */
  onOpenFolder?: () => void
  /** IDE：全部折叠 */
  onCollapseAll?: () => void
  children: ReactNode
  className?: string
}

/**
 * 工作区文件树右键菜单（以报告页能力为准：打开/新建/访达/终端/复制/重命名/删除/刷新）
 */
const ExplorerContextMenu = ({
  rootPath,
  target,
  onTargetChange,
  onOpenFile,
  onRefresh,
  onAfterCreate,
  onAfterRename,
  onAfterDelete,
  fs,
  onOpenFolder,
  onCollapseAll,
  children,
  className
}: Props): JSX.Element => {
  const hasRoot = Boolean(rootPath?.trim())
  const adapter = useMemo(
    () => fs || (hasRoot ? createLocalFsAdapter(rootPath) : null),
    [fs, hasRoot, rootPath]
  )
  const canCreate = Boolean(adapter)
  const canRename = Boolean(adapter?.rename)
  const canRemove = Boolean(adapter?.remove)

  const absOf = useCallback(
    (rel: string): string =>
      hasRoot ? (rel ? joinLocalPath(rootPath, rel) : rootPath) : rel,
    [hasRoot, rootPath]
  )

  const createParent = useCallback((): string => {
    if (!target) return ''
    return parentDirOf(target.path, target.isDir)
  }, [target])

  const onCreateEntry = useCallback(
    async (kind: 'file' | 'dir') => {
      if (!adapter) {
        message.warning('未配置工作区')
        return
      }
      const parent = createParent()
      const name = await askName(
        kind === 'file' ? '新建文件' : '新建文件夹',
        kind === 'file' ? 'untitled.txt' : '新建文件夹'
      )
      if (!name) return
      if (name.includes('..')) {
        message.warning('非法名称')
        return
      }
      const fullPath = parent ? `${parent}/${name}` : name
      try {
        if (kind === 'dir') {
          await adapter.createDir(fullPath)
          message.success('已创建文件夹')
        } else {
          await adapter.createFile(fullPath)
          message.success('已创建文件')
        }
        onAfterCreate?.({ kind, path: fullPath })
        await onRefresh()
        if (kind === 'file') onOpenFile?.(fullPath)
      } catch (e) {
        message.error(e instanceof Error ? e.message : '创建失败')
      }
    },
    [adapter, createParent, onAfterCreate, onOpenFile, onRefresh]
  )

  const onRenameEntry = useCallback(async () => {
    if (!adapter?.rename || !target?.path) return
    const base = baseNameOf(target.path)
    const name = await askName('重命名', base)
    if (!name || name === base) return
    try {
      const result = await adapter.rename(target.path, name)
      onAfterRename?.({
        from: target.path,
        to: result.filePath,
        isDir: target.isDir
      })
      message.success('已重命名')
      await onRefresh()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '重命名失败')
    }
  }, [adapter, onAfterRename, onRefresh, target])

  const onDeleteEntry = useCallback(() => {
    if (!adapter?.remove || !target?.path) return
    const label = target.path
    const isDir = target.isDir
    Modal.confirm({
      centered: true,
      title: isDir ? '删除文件夹' : '删除文件',
      content: `确定删除「${label}」？此操作不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await adapter.remove?.(label)
          onAfterDelete?.({ path: label, isDir })
          message.success('已删除')
          await onRefresh()
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败')
          throw e
        }
      }
    })
  }, [adapter, onAfterDelete, onRefresh, target])

  const menu = useMemo<MenuProps>(() => {
    const targetAbs = target ? absOf(target.path) : rootPath
    const terminalAbs =
      target && !target.isDir
        ? absOf(createParent() || '')
        : targetAbs

    const items: MenuProps['items'] = []

    if (target && !target.isDir && onOpenFile) {
      items.push({
        key: 'open',
        label: '打开',
        onClick: () => onOpenFile(target.path)
      })
      items.push({ type: 'divider' })
    }

    items.push(
      {
        key: 'new-file',
        label: '新建文件...',
        disabled: !canCreate,
        onClick: () => void onCreateEntry('file')
      },
      {
        key: 'new-folder',
        label: '新建文件夹...',
        disabled: !canCreate,
        onClick: () => void onCreateEntry('dir')
      }
    )

    if (onOpenFolder) {
      items.push({
        key: 'open-folder',
        label: '打开文件夹...',
        onClick: () => onOpenFolder()
      })
    }

    items.push(
      { type: 'divider' },
      {
        key: 'reveal',
        label: '在访达中显示',
        disabled: !hasRoot,
        onClick: () => {
          void window.electronAPI
            .revealInFolder(targetAbs)
            .catch((e: unknown) =>
              message.error(e instanceof Error ? e.message : '打开失败')
            )
        }
      },
      {
        key: 'terminal',
        label: '在终端中打开',
        disabled: !hasRoot,
        onClick: () => {
          void window.electronAPI
            .openInTerminal(terminalAbs || rootPath)
            .catch((e: unknown) =>
              message.error(e instanceof Error ? e.message : '打开失败')
            )
        }
      },
      { type: 'divider' },
      {
        key: 'copy-path',
        label: '复制路径',
        disabled: !hasRoot,
        onClick: () => void copyText(targetAbs, '已复制路径')
      },
      {
        key: 'copy-rel',
        label: '复制相对路径',
        disabled: !target,
        onClick: () => {
          if (!target) return
          void copyText(target.path, '已复制相对路径')
        }
      }
    )

    if (target) {
      items.push(
        { type: 'divider' },
        {
          key: 'rename',
          label: '重命名...',
          disabled: !canRename,
          onClick: () => void onRenameEntry()
        },
        {
          key: 'delete',
          label: '删除',
          danger: true,
          disabled: !canRemove,
          onClick: () => onDeleteEntry()
        }
      )
    }

    items.push(
      { type: 'divider' },
      {
        key: 'refresh',
        label: '刷新',
        onClick: () => void onRefresh()
      }
    )

    if (onCollapseAll) {
      items.push({
        key: 'collapse',
        label: '全部折叠',
        onClick: () => onCollapseAll()
      })
    }

    return { items }
  }, [
    absOf,
    canCreate,
    canRemove,
    canRename,
    createParent,
    hasRoot,
    onCollapseAll,
    onCreateEntry,
    onDeleteEntry,
    onOpenFile,
    onOpenFolder,
    onRefresh,
    onRenameEntry,
    rootPath,
    target
  ])

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={menu}
      overlayClassName="repo-explorer-ctx"
    >
      <div
        className={className}
        onContextMenu={(e) => {
          const onNode = (e.target as HTMLElement).closest(
            '.ant-tree-treenode'
          )
          if (!onNode) onTargetChange(null)
        }}
      >
        {children}
      </div>
    </Dropdown>
  )
}

export default ExplorerContextMenu
