/**
 * C1：拉码失败不得回退演示数据
 * node scripts/test-no-demo-fallback.mjs
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fetcher = readFileSync(
  join(root, 'src/main/review-engine/code-fetcher.ts'),
  'utf8'
)
const orch = readFileSync(
  join(root, 'src/main/review-engine/orchestrator.ts'),
  'utf8'
)

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exit(1)
}

if (/source:\s*'demo'/.test(fetcher)) {
  fail("code-fetcher 仍返回 source: 'demo'")
}
if (/usedDemo:\s*true/.test(fetcher)) {
  fail('code-fetcher 仍设置 usedDemo: true')
}
if (!/拉码失败，已终止审查/.test(fetcher)) {
  fail('code-fetcher 缺少失败终止错误文案')
}
if (!/throw new Error\(/.test(fetcher)) {
  fail('code-fetcher 失败路径未 throw')
}
if (/演示回退/.test(orch)) {
  fail('orchestrator 流程文案仍含「演示回退」')
}
if (/fetched\.usedDemo/.test(orch)) {
  fail('orchestrator 仍依赖 usedDemo 分支')
}

console.log('PASS: C1 拉码失败不再回退演示数据（源码契约）')
