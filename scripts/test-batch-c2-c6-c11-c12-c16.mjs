/**
 * C2/C6/C11/C12/C16 源码契约
 *   node scripts/test-batch-c2-c6-c11-c12-c16.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const report = read('src/renderer/src/pages/ReportPage.tsx')
const dash = read('src/renderer/src/pages/Dashboard.tsx')
const menu = read('src/renderer/src/components/UserAccountMenu.tsx')

const checks = [
  ['C2 PR 回写入口', () => /onPostPrComments/.test(report) && /回写 PR/.test(report) && /postPrComments/.test(report)],
  ['C6 按 pipelineId', () => /latestReportByPipeline/.test(dash) && /latestReportByPipeline\.get\(p\.id\)/.test(dash) && !/latestReportByRepo/.test(dash)],
  ['C11 localStorage 收藏', () => /localStorage\.setItem\(FAVORITE_PIPELINES_KEY/.test(dash)],
  ['C12 列表切详情', () => /setPipeListView\('detail'\)/.test(dash)],
  ['C12 筛选切收藏', () => /setPipeListTab\(\(tab\) => \(tab === 'favorites' \? 'joined' : 'favorites'\)\)/.test(dash)],
  ['C16 检查更新', () => /checkForUpdates/.test(menu) && /检查更新/.test(menu)],
]

let failed = 0
for (const [name, fn] of checks) {
  if (!fn()) {
    console.error('FAIL:', name)
    failed++
  } else {
    console.log('OK:', name)
  }
}
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nPASS: C2/C6/C11/C12/C16')
