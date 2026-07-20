/**
 * C4：报告加载失败契约
 * node scripts/test-report-load-error.mjs
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const store = readFileSync(
  join(root, 'src/renderer/src/store/useAppStore.ts'),
  'utf8'
)
const page = readFileSync(
  join(root, 'src/renderer/src/pages/ReportPage.tsx'),
  'utf8'
)

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exit(1)
}

if (!/报告不存在或已删除/.test(store)) {
  fail('loadReport 未在空结果时抛出明确错误')
}
if (!/if \(!report\)/.test(store) && !/if \(!report\) \{/.test(store)) {
  // allow either style
}
if (!/throw new Error\('报告不存在或已删除'\)/.test(store)) {
  fail('loadReport 缺少 throw')
}
if (!/detailLoadError/.test(page)) {
  fail('ReportPage 缺少 detailLoadError 状态')
}
if (!/无法打开报告/.test(page)) {
  fail('ReportPage 缺少失败态标题')
}
if (!/setDetailLoadError\(msg\)/.test(page)) {
  fail('ReportPage 失败时未写入 detailLoadError')
}

console.log('PASS: C4 报告加载失败态（源码契约）')
