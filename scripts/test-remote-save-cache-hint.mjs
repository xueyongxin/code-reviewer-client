/**
 * C3：远程保存须标明仅本地缓存
 * node scripts/test-remote-save-cache-hint.mjs
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const page = readFileSync(
  join(root, 'src/renderer/src/pages/RepoEditorPage.tsx'),
  'utf8'
)
const browser = readFileSync(
  join(root, 'src/main/review-engine/repo-browser.ts'),
  'utf8'
)

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exit(1)
}

if (!/已保存到本地缓存（未推送到远程仓库）/.test(page)) {
  fail('远程保存成功文案未标明仅本地缓存')
}
if (!/本地缓存/.test(page)) {
  fail('状态栏缺少「本地缓存」提示')
}
if (!/localCacheOnly:\s*true/.test(browser)) {
  fail('writeRepoFile 未返回 localCacheOnly')
}
// 远程分支不应再使用笼统的「已保存」作为 writeRepoFile 成功提示
const remoteSaveBlock = page.slice(
  page.indexOf('writeRepoFile'),
  page.indexOf('writeRepoFile') + 800
)
if (/message\.success\('已保存'\)/.test(remoteSaveBlock)) {
  fail('writeRepoFile 后仍使用笼统「已保存」')
}

console.log('PASS: C3 远程保存本地缓存提示')
