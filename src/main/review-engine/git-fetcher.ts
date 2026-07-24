import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'fs'
import { join, relative, resolve } from 'path'
import { tmpdir } from 'os'
import { createHash, randomUUID } from 'crypto'
import { deriveRepoFolderName } from '../../shared/repo-path'
import type { ReviewFileResult } from '../../shared/types'
import { languageFromPath } from './code-fetcher'
import {
  beginGitAuthEnv,
  cleanRepoUrl,
  hasGitAuthForRepo,
  resolveGitAuth
} from './git-auth'

const redactSecrets = (text: string): string =>
  text
    .replace(/\/\/([^/\s:@]+):([^@\s]+)@/g, '//***:***@')
    .replace(/\/\/(x-access-token|oauth2):[^@\s]+@/gi, '//$1:***@')
    .replace(
      /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
      '***'
    )

const execFileAsync = promisify(execFile)

const TEXT_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.css',
  '.scss',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.vue',
  '.txt'
])

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
  '分析报告'
])

const walkFiles = (root: string, dir: string, acc: string[]): void => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkFiles(root, full, acc)
      continue
    }
    const ext = name.includes('.') ? `.${name.split('.').pop()}` : ''
    if (!TEXT_EXTS.has(ext.toLowerCase())) continue
    if (st.size > 200_000) continue
    acc.push(full)
  }
}

const isDirEmpty = (dir: string): boolean => {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return true
  }
}

const throwCloneError = (
  error: unknown,
  repoUrl: string,
  mcpServerId?: string
): never => {
  const raw = redactSecrets(
    error instanceof Error
      ? `${error.message}${(error as { stderr?: string }).stderr || ''}`
      : String(error)
  )
  if (
    /authentication failed|401|403|could not read username|permission|denied/i.test(
      raw
    )
  ) {
    if (!hasGitAuthForRepo(repoUrl, mcpServerId)) {
      throw new Error(
        'Git 克隆失败：私有仓库需要鉴权。请在「设置 → 代码仓库」连接对应平台。'
      )
    }
    throw new Error(
      'Git 克隆失败：鉴权无效。请检查代码仓库 Token 是否有效且具备仓库读权限。'
    )
  }
  throw new Error(`Git 克隆失败：${raw.slice(0, 240)}`)
}

const updateExistingRepo = async (
  workDir: string,
  branch: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<void> => {
  await execFileAsync('git', ['fetch', '--depth', '1', 'origin'], {
    cwd: workDir,
    timeout: 120_000,
    env
  })
  if (branch?.trim()) {
    const b = branch.trim()
    try {
      await execFileAsync('git', ['checkout', '-B', b, `origin/${b}`], {
        cwd: workDir,
        timeout: 60_000,
        env
      })
    } catch {
      await execFileAsync('git', ['checkout', b], {
        cwd: workDir,
        timeout: 60_000,
        env
      })
    }
  } else {
    await execFileAsync('git', ['pull', '--ff-only'], {
      cwd: workDir,
      timeout: 120_000,
      env
    })
  }
}

export const fetchViaGitClone = async (
  repoUrl: string,
  options?: {
    mcpServerId?: string
    branch?: string
    workDir?: string
  }
): Promise<{
  files: ReviewFileResult[]
  commitSha?: string
  workDir: string
  /** true：临时目录，审查结束后可清理 */
  ephemeral: boolean
}> => {
  const mcpServerId = options?.mcpServerId
  const branch = options?.branch?.trim() || ''
  const preferred = options?.workDir?.trim()
  const ephemeral = !preferred
  const hash = createHash('sha1').update(repoUrl).digest('hex').slice(0, 10)
  // 用户工作目录 = 父目录；其下再建「仓库名」文件夹存放项目代码
  const parentDir = preferred
    ? resolve(preferred)
    : join(tmpdir(), `crc-git-${hash}-${randomUUID().slice(0, 8)}`)
  const repoFolder = deriveRepoFolderName(repoUrl)
  const workDir = preferred ? join(parentDir, repoFolder) : parentDir

  mkdirSync(parentDir, { recursive: true })

  const cleanUrl = cleanRepoUrl(repoUrl)
  const auth = resolveGitAuth(repoUrl, mcpServerId)
  const { env, cleanup } = beginGitAuthEnv(auth)
  const hasGit = existsSync(join(workDir, '.git'))

  try {
    if (hasGit) {
      await updateExistingRepo(workDir, branch || undefined, env)
    } else if (existsSync(workDir) && !isDirEmpty(workDir)) {
      throw new Error(
        `项目目录已存在且非空：${workDir}。请清空该文件夹，或换一个工作目录`
      )
    } else {
      const args = ['clone', '--depth', '1', '--single-branch']
      if (branch) args.push('-b', branch)
      args.push(cleanUrl, workDir)
      await execFileAsync('git', args, { timeout: 120_000, env })
    }
  } catch (error) {
    if (ephemeral) {
      rmSync(parentDir, { recursive: true, force: true })
    }
    if (error instanceof Error && /项目目录已存在/.test(error.message)) {
      throw error
    }
    throwCloneError(error, repoUrl, mcpServerId)
  } finally {
    cleanup()
  }

  let commitSha = ''
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir
    })
    commitSha = stdout.trim()
  } catch {
    // ignore
  }

  const absFiles: string[] = []
  walkFiles(workDir, workDir, absFiles)

  const files: ReviewFileResult[] = absFiles.slice(0, 40).map((abs) => {
    const filePath = relative(workDir, abs).replace(/\\/g, '/')
    const content = readFileSync(abs, 'utf-8')
    return {
      filePath,
      content,
      originalContent: '',
      language: languageFromPath(filePath),
      issues: []
    }
  })

  if (!files.length) {
    if (ephemeral) {
      rmSync(workDir, { recursive: true, force: true })
    }
    throw new Error('仓库克隆成功，但未找到可审查的文本文件')
  }

  if (!existsSync(workDir)) {
    throw new Error('克隆目录丢失')
  }

  return { files, commitSha, workDir, ephemeral }
}

export const cleanupGitWorkDir = (workDir?: string): void => {
  if (!workDir || !existsSync(workDir)) return
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
