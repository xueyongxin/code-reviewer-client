import { dialog } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { languageFromPath } from './code-fetcher'
import type { RepoFileEntry } from '../../shared/types'

const MAX_FILE_BYTES = 1_500_000

/** 允许写入的目录根（打开文件夹等）；绝对路径写盘必须落在其中或单独登记的文件 */
const writableRoots = new Set<string>()
/** 另存为到工作区外时登记的绝对文件路径 */
const writableFiles = new Set<string>()

const registerWritableRoot = (rootPath: string): void => {
  writableRoots.add(resolve(rootPath))
}

const registerWritableFile = (filePath: string): void => {
  writableFiles.add(resolve(filePath))
}

const assertAbsWritable = (absPath: string): void => {
  const abs = resolve(absPath)
  if (writableFiles.has(abs)) return
  for (const root of Array.from(writableRoots)) {
    if (abs === root || abs.startsWith(root + sep)) return
  }
  throw new Error('无权写入该路径')
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  '__pycache__',
  '.idea',
  '.vscode'
])

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'Desktop.ini'])

const walkTree = (root: string, dir: string, acc: RepoFileEntry[]): void => {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    const rel = relative(root, full).replace(/\\/g, '/')
    if (st.isDirectory()) {
      acc.push({ path: rel, type: 'dir' })
      walkTree(root, full, acc)
      continue
    }
    const tooLarge = st.size > MAX_FILE_BYTES
    acc.push({
      path: rel,
      type: 'file',
      size: st.size,
      ...(tooLarge ? { tooLarge: true } : {})
    })
  }
}

const resolveSafe = (rootPath: string, filePath: string): string => {
  const root = resolve(rootPath)
  const trimmed = filePath.trim()
  if (!trimmed || trimmed.includes('..')) throw new Error('非法文件路径')
  if (isAbsolute(trimmed)) throw new Error('非法文件路径')
  const rel = trimmed.replace(/^\/+/, '').replace(/\\/g, '/')
  if (!rel || rel.includes('..')) throw new Error('非法文件路径')
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('非法文件路径')
  return abs
}

export const openLocalFolderDialog = async (): Promise<{
  rootPath: string
  rootLabel: string
  files: RepoFileEntry[]
} | null> => {
  const result = await dialog.showOpenDialog({
    title: '打开文件夹',
    properties: ['openDirectory', 'createDirectory']
  })

  if (result.canceled || !result.filePaths[0]) return null

  const rootPath = resolve(result.filePaths[0])
  const st = statSync(rootPath)
  if (!st.isDirectory()) throw new Error('不是有效文件夹')

  registerWritableRoot(rootPath)
  const files: RepoFileEntry[] = []
  walkTree(rootPath, rootPath, files)

  return {
    rootPath,
    rootLabel: basename(rootPath),
    files
  }
}

/** 仅选择目录路径（不遍历文件树），用于流水线工作目录等配置 */
export const pickLocalDirectory = async (
  title = '选择工作目录'
): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return null
  const rootPath = resolve(result.filePaths[0])
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error('不是有效文件夹')
  }
  return rootPath
}

export const listLocalFolder = async (rootPath: string): Promise<{
  rootPath: string
  rootLabel: string
  files: RepoFileEntry[]
}> => {
  const root = resolve(rootPath)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('文件夹不存在')
  }
  registerWritableRoot(root)
  const files: RepoFileEntry[] = []
  walkTree(root, root, files)
  return {
    rootPath: root,
    rootLabel: basename(root),
    files
  }
}

export const readLocalFile = async (payload: {
  rootPath: string
  filePath: string
}): Promise<{ content: string; language?: string; filePath: string }> => {
  const abs = resolveSafe(payload.rootPath, payload.filePath)
  if (!existsSync(abs)) throw new Error('文件不存在')
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > MAX_FILE_BYTES) {
    const mb = (st.size / (1024 * 1024)).toFixed(1)
    throw new Error(`文件过大（约 ${mb} MB），无法打开`)
  }
  const buf = readFileSync(abs)
  if (buf.includes(0)) throw new Error('二进制文件，无法在编辑器中打开')
  return {
    content: buf.toString('utf-8'),
    language: languageFromPath(payload.filePath),
    filePath: payload.filePath.replace(/\\/g, '/')
  }
}

export const writeLocalFile = async (payload: {
  rootPath?: string
  filePath: string
  content: string
}): Promise<{ ok: boolean; filePath: string }> => {
  if (typeof payload.content !== 'string') throw new Error('内容无效')
  if (Buffer.byteLength(payload.content, 'utf-8') > MAX_FILE_BYTES) {
    throw new Error('文件过大，无法保存')
  }

  const trimmed = payload.filePath.trim()
  if (!trimmed) throw new Error('非法文件路径')

  let abs: string
  if (isAbsolute(trimmed)) {
    abs = resolve(trimmed)
    assertAbsWritable(abs)
  } else if (payload.rootPath) {
    abs = resolveSafe(payload.rootPath, trimmed)
    registerWritableRoot(payload.rootPath)
  } else {
    throw new Error('缺少工作区根路径')
  }

  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, payload.content, 'utf-8')
  return {
    ok: true,
    filePath: (isAbsolute(trimmed) ? abs : trimmed).replace(/\\/g, '/')
  }
}

export const createLocalDir = async (payload: {
  rootPath: string
  dirPath: string
}): Promise<{ ok: boolean; dirPath: string }> => {
  const abs = resolveSafe(payload.rootPath, payload.dirPath)
  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) throw new Error('同名文件已存在')
    return { ok: true, dirPath: payload.dirPath.replace(/\\/g, '/') }
  }
  mkdirSync(abs, { recursive: true })
  return { ok: true, dirPath: payload.dirPath.replace(/\\/g, '/') }
}

export const deleteLocalEntry = async (payload: {
  rootPath: string
  filePath: string
}): Promise<{ ok: boolean }> => {
  const abs = resolveSafe(payload.rootPath, payload.filePath)
  if (!existsSync(abs)) throw new Error('目标不存在')
  rmSync(abs, { recursive: true, force: true })
  return { ok: true }
}

export const renameLocalEntry = async (payload: {
  rootPath: string
  filePath: string
  newName: string
}): Promise<{ ok: boolean; filePath: string }> => {
  const name = payload.newName.trim().replace(/[\\/]/g, '')
  if (!name || name.includes('..')) throw new Error('非法名称')
  const abs = resolveSafe(payload.rootPath, payload.filePath)
  if (!existsSync(abs)) throw new Error('目标不存在')
  const nextAbs = join(dirname(abs), name)
  const root = resolve(payload.rootPath)
  if (nextAbs !== root && !nextAbs.startsWith(root + sep)) {
    throw new Error('非法路径')
  }
  if (existsSync(nextAbs)) throw new Error('同名项已存在')
  renameSync(abs, nextAbs)
  return {
    ok: true,
    filePath: relative(root, nextAbs).replace(/\\/g, '/')
  }
}

export const saveLocalFileDialog = async (payload: {
  content: string
  defaultPath?: string
  rootPath?: string
}): Promise<{
  absPath: string
  filePath: string
  rootPath?: string
  language?: string
} | null> => {
  if (typeof payload.content !== 'string') throw new Error('内容无效')
  if (Buffer.byteLength(payload.content, 'utf-8') > MAX_FILE_BYTES) {
    throw new Error('文件过大，无法保存')
  }

  const defaultName = payload.defaultPath?.trim() || 'Untitled-1'
  const result = await dialog.showSaveDialog({
    title: '保存文件',
    defaultPath: payload.rootPath
      ? join(payload.rootPath, defaultName)
      : defaultName,
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Text', extensions: ['txt', 'md'] },
      { name: 'JavaScript', extensions: ['js', 'jsx', 'mjs'] },
      { name: 'TypeScript', extensions: ['ts', 'tsx'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  })

  if (result.canceled || !result.filePath) return null

  const absPath = resolve(result.filePath)
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, payload.content, 'utf-8')

  const root = payload.rootPath ? resolve(payload.rootPath) : undefined
  let underRoot = false
  let filePath = absPath
  if (root) {
    registerWritableRoot(root)
    const rel = relative(root, absPath)
    underRoot =
      Boolean(rel) &&
      !isAbsolute(rel) &&
      !rel.startsWith('..') &&
      resolve(root, rel) === absPath
    if (underRoot) filePath = rel.replace(/\\/g, '/')
  }
  if (underRoot && root) {
    registerWritableRoot(root)
  } else {
    // 工作区外另存为：登记该文件，后续保存才允许写入
    registerWritableFile(absPath)
  }

  return {
    absPath,
    filePath,
    rootPath: underRoot ? root : undefined,
    language: languageFromPath(basename(absPath))
  }
}
