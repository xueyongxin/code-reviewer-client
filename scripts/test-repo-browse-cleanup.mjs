/**
 * 反复验证：缓存目录清理（ENOTEMPTY 场景）+ 密钥脱敏
 */
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sleepSync = (ms) => {
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

const removeDirRobust = (dir) => {
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
        /* ignore */
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

const redactSecrets = (text) =>
  text
    .replace(/\/\/([^/\s:@]+):([^@\s]+)@/g, '//***:***@')
    .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:***@')
    .replace(/oauth2:[^@\s]+@/gi, 'oauth2:***@')

const base = join(tmpdir(), `crc-browse-test-${process.pid}`)
mkdirSync(base, { recursive: true })

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed++
    console.error('FAIL:', msg)
  } else {
    console.log('OK:', msg)
  }
}

const leaked =
  'Command failed: git clone --depth 1 https://oauth2:2465707d6bb1ed7f1f295b8508511206@gitee.com/a/b.git /tmp/x'
const safe = redactSecrets(leaked)
assert(!safe.includes('2465707d'), 'token redacted from error')
assert(safe.includes('***:***@'), 'redaction placeholder present')

for (let i = 0; i < 20; i++) {
  const dir = join(base, `repo-${i}`)
  const hooks = join(dir, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n')
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export {}\n')
  removeDirRobust(dir)
  assert(!existsSync(dir), `removeDirRobust cleared repo-${i}`)
}

const raceDir = join(base, 'race')
mkdirSync(join(raceDir, '.git', 'hooks'), { recursive: true })
writeFileSync(join(raceDir, '.git', 'hooks', 'x'), 'x')
await Promise.all(Array.from({ length: 8 }, async () => removeDirRobust(raceDir)))
assert(!existsSync(raceDir), 'concurrent removeDirRobust cleared race dir')

// staging 替换模拟：先造 workDir，再 staging rename 覆盖
const workDir = join(base, 'work')
const staging = `${workDir}.staging-test`
mkdirSync(join(workDir, 'old'), { recursive: true })
writeFileSync(join(workDir, 'old', 'x'), 'old')
mkdirSync(join(staging, '.git'), { recursive: true })
writeFileSync(join(staging, '.git', 'HEAD'), 'ref: refs/heads/master\n')
writeFileSync(join(staging, 'readme.md'), 'ok\n')
removeDirRobust(workDir)
renameSync(staging, workDir)
assert(existsSync(join(workDir, '.git', 'HEAD')), 'staging rename left usable checkout')
assert(existsSync(join(workDir, 'readme.md')), 'staging content present')
assert(!existsSync(join(workDir, 'old')), 'old workDir removed before rename')

try {
  rmSync(base, { recursive: true, force: true })
} catch {
  /* ignore */
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll browse-cleanup checks passed')
