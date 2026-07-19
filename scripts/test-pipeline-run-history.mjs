/**
 * 运行历史过滤 + 复制流水线隔离自测
 * 运行：node scripts/test-pipeline-run-history.mjs
 */

/** 与 Dashboard.pipelineRunHistory 一致：只认 pipelineId */
const filterPipelineHistory = (history, pipelineId) =>
  history
    .filter((r) => r.pipelineId === pipelineId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

/** 模拟复制：新 id，配置相同，不继承报告 */
const copyPipeline = (source) => ({
  ...source,
  id: `${source.id}-copy`,
  name: `${source.name} 副本`,
  methodIds: [...(source.methodIds || [])],
  reportFormats: [...(source.reportFormats || [])],
  updatedAt: new Date().toISOString()
})

let passed = 0
let failed = 0
const assert = (name, cond) => {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

const original = {
  id: 'pipe-A',
  name: 'demo',
  repoUrl: 'https://github.com/acme/demo.git',
  methodIds: ['security'],
  reportFormats: ['md']
}

const history = [
  {
    id: 'r1',
    pipelineId: 'pipe-A',
    repoUrl: original.repoUrl,
    createdAt: '2026-07-19T10:00:00.000Z',
    status: 'completed'
  },
  {
    id: 'r2',
    pipelineId: 'pipe-A',
    repoUrl: original.repoUrl,
    createdAt: '2026-07-19T11:00:00.000Z',
    status: 'failed'
  },
  {
    id: 'r-legacy',
    // 旧数据无 pipelineId
    repoUrl: original.repoUrl,
    createdAt: '2026-07-18T09:00:00.000Z',
    status: 'completed'
  },
  {
    id: 'r-other',
    pipelineId: 'pipe-B',
    repoUrl: 'https://github.com/acme/other.git',
    createdAt: '2026-07-19T12:00:00.000Z',
    status: 'completed'
  }
]

console.log('1) 原流水线只看到自己的报告')
{
  const list = filterPipelineHistory(history, original.id)
  assert('数量为 2', list.length === 2)
  assert('不含其他流水线', list.every((r) => r.pipelineId === 'pipe-A'))
  assert('不含无 pipelineId 旧数据', !list.some((r) => r.id === 'r-legacy'))
  assert('按时间倒序', list[0].id === 'r2' && list[1].id === 'r1')
}

console.log('2) 复制流水线历史为空（同仓库也不带）')
{
  const copied = copyPipeline(original)
  assert('新 id 不同', copied.id !== original.id)
  assert('仓库相同', copied.repoUrl === original.repoUrl)
  const list = filterPipelineHistory(history, copied.id)
  assert('副本历史为空', list.length === 0)
}

console.log('3) 副本跑出新报告后只出现在副本')
{
  const copied = copyPipeline(original)
  const withNew = [
    ...history,
    {
      id: 'r-copy-1',
      pipelineId: copied.id,
      repoUrl: copied.repoUrl,
      createdAt: '2026-07-19T13:00:00.000Z',
      status: 'completed'
    }
  ]
  const forCopy = filterPipelineHistory(withNew, copied.id)
  const forOrig = filterPipelineHistory(withNew, original.id)
  assert('副本仅 1 条', forCopy.length === 1 && forCopy[0].id === 'r-copy-1')
  assert('原流水线仍是 2 条', forOrig.length === 2)
  assert('互不污染', !forOrig.some((r) => r.id === 'r-copy-1'))
}

console.log('4) 旧逻辑（按 repoUrl）会错误带历史 — 确认已废弃')
{
  const badFilter = (hist, repoUrl, pipelineId) =>
    hist.filter((r) => {
      if (r.pipelineId && r.pipelineId === pipelineId) return true
      if (!r.pipelineId && r.repoUrl === repoUrl) return true
      return false
    })
  const copied = copyPipeline(original)
  // 若仍用旧逻辑 + 无 pipelineId 的报告，会把 legacy 算进副本
  const polluted = badFilter(history, copied.repoUrl, copied.id)
  assert(
    '旧逻辑会污染副本（对照）',
    polluted.some((r) => r.id === 'r-legacy')
  )
  const fixed = filterPipelineHistory(history, copied.id)
  assert('新逻辑不污染', fixed.length === 0)
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
