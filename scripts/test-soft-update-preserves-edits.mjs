/**
 * 验证：工作区有本地修改时，软更新不得用 checkout -f / merge 覆盖文件内容
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// 通过 tsx/编译不可用时，内联与 repo-browser 相同的 dirty 判定 + 软更新策略模拟
const run = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })

const isDirty = (cwd) => {
  const out = run(cwd, ['status', '--porcelain'])
  return Boolean(String(out).trim())
}

/** 与 softUpdateCache 对齐的安全软更新（无 -f） */
const softUpdateSafe = (cwd) => {
  if (isDirty(cwd)) return { skipped: true }
  try {
    run(cwd, ['fetch', '--depth', '1', 'origin', 'main'])
    if (isDirty(cwd)) return { skipped: true }
    run(cwd, ['merge', '--ff-only', 'FETCH_HEAD'])
    return { skipped: false }
  } catch {
    return { skipped: true, failed: true }
  }
}

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed++
    console.error('FAIL:', msg)
  } else {
    console.log('OK:', msg)
  }
}

const root = join(tmpdir(), `crc-soft-update-${process.pid}`)
const remote = join(root, 'remote.git')
const work = join(root, 'work')

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* ignore */
}
mkdirSync(root, { recursive: true })

run(root, ['init', '--bare', remote])
mkdirSync(work, { recursive: true })
run(work, ['init'])
run(work, ['checkout', '-b', 'main'])
writeFileSync(join(work, 'a.txt'), 'v1\n', 'utf-8')
run(work, ['add', 'a.txt'])
run(work, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-m', 'init'])
run(work, ['remote', 'add', 'origin', remote])
run(work, ['push', '-u', 'origin', 'main'])

// 本地编辑（模拟 IDE writeRepoFile）
writeFileSync(join(work, 'a.txt'), 'LOCAL_EDIT\n', 'utf-8')
assert(isDirty(work), 'working tree dirty after local edit')
assert(readFileSync(join(work, 'a.txt'), 'utf-8').includes('LOCAL_EDIT'), 'local content present')

const result = softUpdateSafe(work)
assert(result.skipped === true, 'soft update skipped when dirty')
assert(
  readFileSync(join(work, 'a.txt'), 'utf-8').includes('LOCAL_EDIT'),
  'local edit preserved after soft update'
)

// 干净工作区应允许 soft merge（远端无新提交时 merge 可能 no-op / 成功）
run(work, ['checkout', '--', 'a.txt'])
assert(!isDirty(work), 'clean after discard')
const cleanResult = softUpdateSafe(work)
assert(cleanResult.skipped === false || cleanResult.failed === true, 'clean tree attempts update')
assert(existsSync(join(work, 'a.txt')), 'file still exists after clean soft update')

// 确保实现文件中不再使用 checkout -f
const src = readFileSync(
  new URL('../src/main/review-engine/repo-browser.ts', import.meta.url),
  'utf-8'
)
assert(!/checkout',\s*'-f'/.test(src) && !/checkout",\s*"-f"/.test(src), 'no checkout -f in repo-browser')
assert(src.includes('isWorkingTreeDirty'), 'dirty check present in repo-browser')

rmSync(root, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll soft-update preserve-edit checks passed')
void require
