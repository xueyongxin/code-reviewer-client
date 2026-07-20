import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
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
import { dirname, join, relative } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { languageFromPath } from './code-fetcher'
import {
  beginGitAuthEnv,
  cleanRepoUrl,
  hasGitAuthForRepo,
  resolveGitAuth
} from './git-auth'

const execFileAsync = promisify(execFile)

/** 同一仓库并发 list/read 共用一次 checkout，避免互相删目录 */
const checkoutLocks = new Map<string, Promise<string>>()

const sleepSync = (ms: number): void => {
  try {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/** macOS 上并发 git/清理时 rmSync 可能 ENOTEMPTY，加重试与旁路删除 */
export const removeDirRobust = (dir: string): void => {
  if (!dir || !existsSync(dir)) return
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
      if (!existsSync(dir)) return
    } catch {
      /* retry */
    }
    try {
      const trash = `${dir}.trash-${process.pid}-${Date.now()}-${attempt}`
      renameSync(dir, trash)
      try {
        rmSync(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
      } catch {
        /* tmp 旁路，不影响主目录 */
      }
      if (!existsSync(dir)) return
    } catch {
      sleepSync(40 * (attempt + 1))
    }
  }
  try {
    execFileSync('rm', ['-rf', '--', dir], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

const isUsableCheckout = (workDir: string): boolean => {
  const gitDir = join(workDir, '.git')
  if (!existsSync(gitDir)) return false
  return existsSync(join(gitDir, 'HEAD'))
}

/** 脱敏 clone URL / 报错中的 token，避免弹窗泄露 */
export const redactSecrets = (text: string): string =>
  text
    .replace(/\/\/([^/\s:@]+):([^@\s]+)@/g, '//***:***@')
    .replace(/\/\/(x-access-token|oauth2):[^@\s]+@/gi, '//$1:***@')
    .replace(/\/\/(ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)@/gi, '//***@')
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '***')

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

/** 可预览的最大文件体积；更大文件仍会出现在树中并标记 tooLarge */
const MAX_FILE_BYTES = 1_500_000

export interface RepoFileEntry {
  path: string
  type: 'file' | 'dir'
  size?: number
  /** 超过预览上限，树中展示但不可打开内容 */
  tooLarge?: boolean
}

const cacheKey = (repoUrl: string, branch?: string): string =>
  createHash('sha1')
    .update(`${repoUrl.trim()}|${(branch || '').trim()}`)
    .digest('hex')
    .slice(0, 16)

const cacheDirFor = (repoUrl: string, branch?: string): string =>
  join(tmpdir(), 'crc-browse', cacheKey(repoUrl, branch))

const ensureCleanRemoteUrl = async (
  workDir: string,
  repoUrl: string,
  env: NodeJS.ProcessEnv
): Promise<void> => {
  try {
    await execFileAsync('git', ['remote', 'set-url', 'origin', cleanRepoUrl(repoUrl)], {
      cwd: workDir,
      timeout: 15_000,
      env
    })
  } catch {
    /* ignore */
  }
}

const formatGitError = (error: unknown, repoUrl: string, mcpServerId?: string): string => {
  const raw = redactSecrets(
    error instanceof Error
      ? `${error.message}${(error as { stderr?: string }).stderr || ''}`
      : String(error)
  )
  const text = raw.toLowerCase()
  const auth = resolveGitAuth(repoUrl, mcpServerId)
  const hostLabel = auth?.providerId || 'git'

  if (/enotempty|directory not empty|ebusy|resource busy|locked/.test(text)) {
    return '拉取仓库失败：本地缓存正忙或清理未完成，请稍后重试。'
  }
  if (
    /authentication failed|could not read username|invalid username or password|403|401|denied|permission|access denied|repository not found/.test(
      text
    )
  ) {
    if (!hasGitAuthForRepo(repoUrl, mcpServerId)) {
      return `无法访问私有仓库（${hostLabel}）。请在「设置 → 代码仓库」连接对应平台并完成鉴权后重试。`
    }
    return `仓库鉴权失败（${hostLabel}）。请检查 Token 是否有效、是否具备该仓库读权限，或仓库地址是否正确。`
  }
  if (/could not resolve host|network|timed out|timeout/.test(text)) {
    return '拉取仓库失败：网络异常或超时，请稍后重试。'
  }
  if (/not found|does not exist|couldn't find remote ref/.test(text)) {
    return '拉取仓库失败：仓库或分支不存在，请检查地址与分支名。'
  }
  if (/already exists and is not an empty directory/.test(text)) {
    return '拉取仓库失败：本地缓存冲突，请点击刷新后重试。'
  }
  const short = raw.replace(/\s+/g, ' ').trim().slice(0, 240)
  return `拉取仓库失败：${short || '未知错误'}`
}

/** 先克隆到 staging，再原子替换，避免半成品目录与并发冲突 */
const cloneIntoWorkDir = async (
  repoUrl: string,
  workDir: string,
  branchName: string,
  mcpServerId?: string
): Promise<void> => {
  const staging = `${workDir}.staging-${process.pid}-${Date.now()}`
  removeDirRobust(staging)
  mkdirSync(dirname(workDir), { recursive: true })
  const cleanUrl = cleanRepoUrl(repoUrl)
  const { env, cleanup } = beginGitAuthEnv(resolveGitAuth(repoUrl, mcpServerId))

  try {
    const args = ['clone', '--depth', '1', '--single-branch']
    if (branchName) args.push('--branch', branchName)
    args.push(cleanUrl, staging)
    await execFileAsync('git', args, {
      timeout: 180_000,
      env
    })
    await ensureCleanRemoteUrl(staging, repoUrl, env)
    removeDirRobust(workDir)
    renameSync(staging, workDir)
  } catch (error) {
    removeDirRobust(staging)
    throw error
  } finally {
    cleanup()
  }
}

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

/** 工作区有未提交改动时，软更新不得强制覆盖 */
const isWorkingTreeDirty = async (workDir: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workDir,
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    return Boolean(stdout.trim())
  } catch {
    return true
  }
}

const softUpdateCache = async (
  workDir: string,
  repoUrl: string,
  branch?: string,
  mcpServerId?: string
): Promise<void> => {
  const branchName = branch?.trim() || ''
  const { env, cleanup } = beginGitAuthEnv(resolveGitAuth(repoUrl, mcpServerId))
  try {
    // 有本地编辑时跳过软更新，避免 checkout/pull 抹掉已保存内容
    if (await isWorkingTreeDirty(workDir)) return

    await ensureCleanRemoteUrl(workDir, repoUrl, env)
    if (branchName) {
      await execFileAsync('git', ['fetch', '--depth', '1', 'origin', branchName], {
        cwd: workDir,
        timeout: 120_000,
        env
      })
      // 再次确认：fetch 期间用户可能已写入
      if (await isWorkingTreeDirty(workDir)) return
      await execFileAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], {
        cwd: workDir,
        timeout: 30_000,
        env
      })
    } else {
      await execFileAsync('git', ['pull', '--ff-only', '--depth', '1'], {
        cwd: workDir,
        timeout: 120_000,
        env
      })
    }
    await ensureCleanRemoteUrl(workDir, repoUrl, env)
  } catch {
    // 软更新失败不阻断浏览，沿用本地缓存
  } finally {
    cleanup()
  }
}

const ensureCheckoutUnlocked = async (
  repoUrl: string,
  branch?: string,
  mcpServerId?: string,
  options?: { forceRefresh?: boolean; softRefresh?: boolean }
): Promise<string> => {
  const forceRefresh = Boolean(options?.forceRefresh)
  const softRefresh = Boolean(options?.softRefresh)
  const workDir = cacheDirFor(repoUrl, branch)
  const branchName = branch?.trim() || ''

  if (forceRefresh) {
    removeDirRobust(workDir)
  }

  if (isUsableCheckout(workDir)) {
    if (softRefresh && !forceRefresh) {
      await softUpdateCache(workDir, repoUrl, branch, mcpServerId)
    }
    return workDir
  }

  // 半成品 / 无 HEAD 的残留目录
  if (existsSync(workDir)) {
    removeDirRobust(workDir)
  }

  try {
    await cloneIntoWorkDir(repoUrl, workDir, branchName, mcpServerId)
  } catch (error) {
    removeDirRobust(workDir)
    if (branchName) {
      try {
        await cloneIntoWorkDir(repoUrl, workDir, '', mcpServerId)
        return workDir
      } catch (fallbackErr) {
        removeDirRobust(workDir)
        throw new Error(formatGitError(fallbackErr, repoUrl, mcpServerId))
      }
    }
    throw new Error(formatGitError(error, repoUrl, mcpServerId))
  }

  return workDir
}

const ensureCheckout = async (
  repoUrl: string,
  branch?: string,
  mcpServerId?: string,
  options?: { forceRefresh?: boolean; softRefresh?: boolean }
): Promise<string> => {
  const lockKey = cacheKey(repoUrl, branch)
  // 严格串行：所有 checkout/soft/force 排队执行，避免并发删目录互相踩
  const previous = checkoutLocks.get(lockKey) ?? Promise.resolve('')

  let run!: Promise<string>
  run = previous
    .catch(() => '')
    .then(() => ensureCheckoutUnlocked(repoUrl, branch, mcpServerId, options))
    .finally(() => {
      if (checkoutLocks.get(lockKey) === run) {
        checkoutLocks.delete(lockKey)
      }
    })

  checkoutLocks.set(lockKey, run)
  return run
}

export const listRepoFiles = async (payload: {
  repoUrl: string
  branch?: string
  mcpServerId?: string
  forceRefresh?: boolean
}): Promise<{ files: RepoFileEntry[]; rootLabel: string }> => {
  const repoUrl = payload.repoUrl?.trim()
  if (!repoUrl) throw new Error('未配置仓库地址')

  const workDir = await ensureCheckout(repoUrl, payload.branch, payload.mcpServerId, {
    forceRefresh: payload.forceRefresh,
    softRefresh: !payload.forceRefresh
  })
  const files: RepoFileEntry[] = []
  walkTree(workDir, workDir, files)

  const parts = repoUrl.replace(/\.git$/i, '').split('/').filter(Boolean)
  const rootLabel = parts.slice(-2).join('/') || repoUrl

  return { files, rootLabel }
}

export const readRepoFile = async (payload: {
  repoUrl: string
  branch?: string
  mcpServerId?: string
  filePath: string
}): Promise<{ content: string; language?: string; filePath: string }> => {
  const repoUrl = payload.repoUrl?.trim()
  const filePath = payload.filePath?.replace(/^\/+/, '').replace(/\\/g, '/')
  if (!repoUrl) throw new Error('未配置仓库地址')
  if (!filePath || filePath.includes('..')) throw new Error('非法文件路径')

  const workDir = await ensureCheckout(repoUrl, payload.branch, payload.mcpServerId)
  const abs = join(workDir, filePath)
  if (!abs.startsWith(workDir) || !existsSync(abs)) {
    throw new Error('文件不存在')
  }
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > MAX_FILE_BYTES) {
    const mb = (st.size / (1024 * 1024)).toFixed(1)
    throw new Error(`文件过大（约 ${mb} MB），无法在编辑器中预览`)
  }

  const buf = readFileSync(abs)
  // 粗略跳过二进制
  if (buf.includes(0)) {
    throw new Error('二进制文件，无法预览')
  }

  return {
    content: buf.toString('utf-8'),
    language: languageFromPath(filePath),
    filePath
  }
}

/**
 * 远程仓写盘仅落本地 temp clone，明确告知调用方。
 */
export const writeRepoFile = async (payload: {
  repoUrl: string
  branch?: string
  mcpServerId?: string
  filePath: string
  content: string
}): Promise<{ ok: boolean; filePath: string; localCacheOnly: true }> => {
  const repoUrl = payload.repoUrl?.trim()
  const filePath = payload.filePath?.replace(/^\/+/, '').replace(/\\/g, '/')
  if (!repoUrl) throw new Error('未配置仓库地址')
  if (!filePath || filePath.includes('..')) throw new Error('非法文件路径')
  if (typeof payload.content !== 'string') throw new Error('内容无效')
  if (Buffer.byteLength(payload.content, 'utf-8') > MAX_FILE_BYTES) {
    throw new Error('文件过大，无法保存')
  }

  const workDir = await ensureCheckout(repoUrl, payload.branch, payload.mcpServerId)
  const abs = join(workDir, filePath)
  if (!abs.startsWith(workDir)) throw new Error('非法文件路径')

  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, payload.content, 'utf-8')
  return { ok: true, filePath, localCacheOnly: true }
}

export const createRepoDir = async (payload: {
  repoUrl: string
  branch?: string
  mcpServerId?: string
  dirPath: string
}): Promise<{ ok: boolean; dirPath: string }> => {
  const repoUrl = payload.repoUrl?.trim()
  const dirPath = payload.dirPath?.replace(/^\/+/, '').replace(/\\/g, '/')
  if (!repoUrl) throw new Error('未配置仓库地址')
  if (!dirPath || dirPath.includes('..')) throw new Error('非法目录路径')

  const workDir = await ensureCheckout(repoUrl, payload.branch, payload.mcpServerId)
  const abs = join(workDir, dirPath)
  if (!abs.startsWith(workDir)) throw new Error('非法目录路径')

  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) throw new Error('同名文件已存在')
    return { ok: true, dirPath }
  }
  mkdirSync(abs, { recursive: true })
  return { ok: true, dirPath }
}
