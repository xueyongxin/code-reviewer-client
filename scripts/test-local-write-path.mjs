/**
 * 验证：绝对路径保存不得拼进 rootPath；相对路径必须落在 root 内
 */
import { isAbsolute, relative, resolve, sep } from 'path'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed++
    console.error('FAIL:', msg)
  } else {
    console.log('OK:', msg)
  }
}

const resolveSafe = (rootPath, filePath) => {
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

const resolveWriteAbs = (rootPath, filePath) => {
  const trimmed = filePath.trim()
  if (isAbsolute(trimmed)) return resolve(trimmed)
  if (rootPath) return resolveSafe(rootPath, trimmed)
  throw new Error('缺少工作区根路径')
}

const root = join(tmpdir(), `crc-write-path-${process.pid}`)
const outside = join(tmpdir(), `crc-write-out-${process.pid}`, 'saved.txt')
mkdirSync(root, { recursive: true })
mkdirSync(join(outside, '..'), { recursive: true })

// 相对路径落入 root
const relAbs = resolveWriteAbs(root, 'src/a.ts')
assert(relAbs.startsWith(root + sep), 'relative path under root')
mkdirSync(dirname(relAbs), { recursive: true })
writeFileSync(relAbs, 'in-root', 'utf-8')
assert(readFileSync(relAbs, 'utf-8') === 'in-root', 'wrote relative under root')

// 绝对路径不拼进 root（旧 bug：resolveSafe 会剥 / 再拼）
const absTarget = resolveWriteAbs(root, outside)
assert(absTarget === resolve(outside), 'absolute path unchanged')
assert(!absTarget.startsWith(root + sep), 'absolute not under root')
writeFileSync(absTarget, 'OUTSIDE', 'utf-8')
assert(readFileSync(outside, 'utf-8') === 'OUTSIDE', 'wrote outside correctly')

// 旧错误行为模拟：剥绝对路径当相对
const buggy = resolve(root, outside.replace(/^\/+/, ''))
assert(buggy !== resolve(outside), 'buggy join differs from absolute')
assert(buggy.startsWith(root), 'buggy path wrongly under root')

// escape
let threw = false
try {
  resolveSafe(root, '../escape.txt')
} catch {
  threw = true
}
assert(threw, 'reject .. escape')

threw = false
try {
  resolveSafe(root, outside)
} catch {
  threw = true
}
assert(threw, 'resolveSafe rejects absolute')

// 源码断言：RepoEditor 对绝对路径不传 rootPath
const page = readFileSync(
  new URL('../src/renderer/src/pages/RepoEditorPage.tsx', import.meta.url),
  'utf-8'
)
assert(page.includes('isFilesystemAbsolute'), 'renderer has abs helper')
assert(page.includes('rootPath: absolute ? undefined'), 'renderer omits root for abs')
assert(page.includes('editorNavKeyRef'), 'nav key clears localRoot')

const local = readFileSync(
  new URL('../src/main/review-engine/local-files.ts', import.meta.url),
  'utf-8'
)
assert(local.includes('isAbsolute(trimmed)'), 'writeLocalFile handles absolute')
assert(local.includes('缺少工作区根路径'), 'relative without root rejected')

rmSync(root, { recursive: true, force: true })
try {
  rmSync(join(outside, '..'), { recursive: true, force: true })
} catch {
  /* ignore */
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll local-write-path checks passed')
void existsSync
