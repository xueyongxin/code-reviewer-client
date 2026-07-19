/**
 * 流水线 ID 幂等规范化自测
 * 运行：node scripts/test-pipeline-id-idempotent.mjs
 */

const fingerprint = (p) =>
  `${(p.name || '').trim().toLowerCase()}||${(p.repoUrl || '').trim().toLowerCase()}`

const normalizeReviewPipelines = (list, options = {}) => {
  const createId = options.createId || (() => `gen-${Math.random().toString(16).slice(2, 10)}`)
  const incoming = Array.isArray(list) ? list : []
  const previous = Array.isArray(options.previous) ? options.previous : []

  const prevByFp = new Map()
  for (const p of previous) {
    const fp = fingerprint(p)
    if (fp !== '||' && !prevByFp.has(fp)) prevByFp.set(fp, p)
  }

  const used = new Set()
  const pipelines = []

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue
    let id = (raw.id || '').trim()

    if (id && used.has(id)) {
      const hit = prevByFp.get(fingerprint(raw))
      const recovered = hit?.id?.trim()
      id = recovered && !used.has(recovered) ? recovered : createId()
    } else if (!id) {
      const hit = prevByFp.get(fingerprint(raw))
      const recovered = hit?.id?.trim()
      id = recovered && !used.has(recovered) ? recovered : createId()
    }

    used.add(id)
    pipelines.push({ ...raw, id })
  }

  const ids = new Set(pipelines.map((p) => p.id))
  let activePipelineId = (options.activePipelineId || '').trim()
  if (!activePipelineId || !ids.has(activePipelineId)) {
    activePipelineId = pipelines[0]?.id || ''
  }
  return { pipelines, activePipelineId }
}

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

let seq = 0
const stableCreateId = () => `new-${++seq}`

console.log('1) 已有 id 反复规范化保持不变')
{
  const list = [
    { id: 'a', name: 'p1', repoUrl: 'https://x/a' },
    { id: 'b', name: 'p2', repoUrl: 'https://x/b' }
  ]
  const once = normalizeReviewPipelines(list, {
    previous: list,
    activePipelineId: 'b',
    createId: stableCreateId
  })
  const twice = normalizeReviewPipelines(once.pipelines, {
    previous: once.pipelines,
    activePipelineId: once.activePipelineId,
    createId: stableCreateId
  })
  assert('id 序列不变', once.pipelines.map((p) => p.id).join() === 'a,b')
  assert('二次规范化幂等', twice.pipelines.map((p) => p.id).join() === 'a,b')
  assert('active 保持', twice.activePipelineId === 'b')
}

console.log('2) 空 id 从旧配置按名称+仓库找回')
{
  const previous = [{ id: 'keep-me', name: 'demo', repoUrl: 'https://x/demo' }]
  const incoming = [{ id: '', name: 'demo', repoUrl: 'https://x/demo' }]
  const out = normalizeReviewPipelines(incoming, {
    previous,
    createId: stableCreateId
  })
  assert('找回原 id', out.pipelines[0].id === 'keep-me')
}

console.log('3) 重复 id 去重')
{
  const list = [
    { id: 'dup', name: 'one', repoUrl: 'https://x/1' },
    { id: 'dup', name: 'two', repoUrl: 'https://x/2' }
  ]
  const out = normalizeReviewPipelines(list, {
    previous: list,
    createId: () => 'fixed-unique'
  })
  assert('两条都有 id', out.pipelines.length === 2)
  assert('id 互异', out.pipelines[0].id !== out.pipelines[1].id)
  assert('首条保留 dup', out.pipelines[0].id === 'dup')
  assert('次条换新 id', out.pipelines[1].id === 'fixed-unique')
}

console.log('4) 无效 active 回落到第一条')
{
  const list = [{ id: 'a', name: 'p', repoUrl: 'https://x/a' }]
  const out = normalizeReviewPipelines(list, {
    previous: list,
    activePipelineId: 'missing'
  })
  assert('active 回落', out.activePipelineId === 'a')
}

console.log('5) 复制场景：新 id 不被旧指纹覆盖')
{
  const previous = [{ id: 'orig', name: 'demo', repoUrl: 'https://x/demo' }]
  const incoming = [
    { id: 'orig', name: 'demo', repoUrl: 'https://x/demo' },
    { id: 'copy-1', name: 'demo 副本', repoUrl: 'https://x/demo' }
  ]
  const out = normalizeReviewPipelines(incoming, {
    previous,
    createId: stableCreateId
  })
  assert('原 id 保留', out.pipelines[0].id === 'orig')
  assert('副本 id 保留', out.pipelines[1].id === 'copy-1')
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
