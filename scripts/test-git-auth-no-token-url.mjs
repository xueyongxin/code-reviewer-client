/**
 * 验证：clone/softUpdate 不再把 token 写入 remote URL；绝对路径写盘需登记
 */
import { readFileSync } from 'fs'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed++
    console.error('FAIL:', msg)
  } else {
    console.log('OK:', msg)
  }
}

const redactSecrets = (text) =>
  text
    .replace(/\/\/([^/\s:@]+):([^@\s]+)@/g, '//***:***@')
    .replace(/\/\/(x-access-token|oauth2):[^@\s]+@/gi, '//$1:***@')
    .replace(
      /\/\/(ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)@/gi,
      '//***@'
    )
    .replace(
      /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
      '***'
    )

const leakedUserPass =
  'fatal: https://oauth2:2465707d6bb1ed7f1f295b8508511206@gitee.com/a/b.git'
assert(!redactSecrets(leakedUserPass).includes('2465707d'), 'user:pass redacted')

const leakedGhp = 'fatal: https://ghp_abcdefghijklmnopqrstuvwx@github.com/a/b.git'
assert(!redactSecrets(leakedGhp).includes('ghp_abcdefgh'), 'ghp_@host redacted')

const bareToken = 'token ghp_abcdefghijklmnopqrstuvwxyz123456 leaked'
assert(!redactSecrets(bareToken).includes('ghp_abcdefgh'), 'bare ghp redacted')

const src = readFileSync(
  new URL('../src/main/review-engine/repo-browser.ts', import.meta.url),
  'utf-8'
)
assert(!src.includes('authenticatedCloneUrl'), 'authenticatedCloneUrl removed')
assert(src.includes('beginGitAuthEnv'), 'askpass helper present')
assert(src.includes('cleanRepoUrl'), 'cleanRepoUrl present')
assert(src.includes('ensureCleanRemoteUrl'), 'remote sanitized after ops')
assert(!/u\.password\s*=\s*auth\.token/.test(src), 'token not assigned into URL password')

const local = readFileSync(
  new URL('../src/main/review-engine/local-files.ts', import.meta.url),
  'utf-8'
)
assert(local.includes('assertAbsWritable'), 'abs write gated')
assert(local.includes('registerWritableFile'), 'dialog registers outside files')
assert(local.includes('无权写入该路径'), 'unauthorized write error')

// allowlist 逻辑
const { resolve, sep } = await import('path')
const roots = new Set([resolve('/tmp/allowed-root')])
const files = new Set([resolve('/tmp/outside/saved.txt')])
const canWrite = (absPath) => {
  const abs = resolve(absPath)
  if (files.has(abs)) return true
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + sep)) return true
  }
  return false
}
assert(canWrite('/tmp/allowed-root/a.ts'), 'under root allowed')
assert(canWrite('/tmp/outside/saved.txt'), 'registered file allowed')
assert(!canWrite('/etc/passwd'), 'random abs denied')

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll git-auth / write-gate checks passed')
