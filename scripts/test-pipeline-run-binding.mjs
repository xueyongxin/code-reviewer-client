/**
 * C5：看板取消/运行按 pipelineId 绑定
 * node scripts/test-pipeline-run-binding.mjs
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dash = readFileSync(
  join(root, 'src/renderer/src/pages/Dashboard.tsx'),
  'utf8'
)
const store = readFileSync(
  join(root, 'src/renderer/src/store/useAppStore.ts'),
  'utf8'
)

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exit(1)
}

if (!/activePipelineRunning/.test(dash)) {
  fail('Dashboard 缺少 activePipelineRunning')
}
if (!/activeRunReport/.test(dash)) {
  fail('Dashboard 缺少 activeRunReport')
}
if (/relatedReport/.test(dash)) {
  fail('Dashboard 仍引用 relatedReport（应按 pipelineId）')
}
if (!/cancelReview\(activeRunReport\?\.id\)/.test(dash)) {
  fail('取消未绑定当前流水线报告 id')
}
if (
  /\{loading \? \(\s*<Button danger onClick=\{\(\) => void cancelReview\(\)\}/.test(
    dash
  )
) {
  fail('看板仍用全局 loading 控制取消按钮')
}
if (!/其他流水线正在运行/.test(dash)) {
  fail('启动其他流水线时缺少互斥提示')
}
if (!/cancelReview: async \(reportId\)/.test(store)) {
  fail('store.cancelReview 未接受 reportId')
}

// 逻辑：仅同 pipelineId 视为本流水线在跑
const isActiveRunning = (current, activeId) =>
  Boolean(
    current?.status === 'running' && current.pipelineId === activeId
  )
if (isActiveRunning({ status: 'running', pipelineId: 'A' }, 'B')) {
  fail('跨流水线误判为运行中')
}
if (!isActiveRunning({ status: 'running', pipelineId: 'A' }, 'A')) {
  fail('同流水线应判定为运行中')
}

console.log('PASS: C5 流水线运行/取消按 pipelineId 绑定')
