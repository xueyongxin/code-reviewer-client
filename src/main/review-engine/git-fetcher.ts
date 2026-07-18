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
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { createHash, randomUUID } from 'crypto'
import type { ReviewFileResult } from '../../shared/types'
import { languageFromPath } from './code-fetcher'

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
  '__pycache__'
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

export const fetchViaGitClone = async (
  repoUrl: string
): Promise<{ files: ReviewFileResult[]; commitSha?: string; workDir: string }> => {
  const hash = createHash('sha1').update(repoUrl).digest('hex').slice(0, 10)
  const workDir = join(tmpdir(), `crc-git-${hash}-${randomUUID().slice(0, 8)}`)
  mkdirSync(workDir, { recursive: true })

  try {
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--single-branch', repoUrl, workDir],
      { timeout: 120_000 }
    )
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true })
    throw new Error(
      `Git 克隆失败：${error instanceof Error ? error.message : String(error)}`
    )
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
    rmSync(workDir, { recursive: true, force: true })
    throw new Error('仓库克隆成功，但未找到可审查的文本文件')
  }

  return { files, commitSha, workDir }
}

export const cleanupGitWorkDir = (workDir?: string): void => {
  if (!workDir || !existsSync(workDir)) return
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
