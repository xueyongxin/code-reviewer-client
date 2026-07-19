/**
 * 验证：删流水线清 recent；无效 pipelineId 不静默回落
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

const removeRecentByPipelineId = (list, pipelineId) =>
  list.filter((p) => !(p.kind === 'pipeline' && p.pipelineId === pipelineId))

const resolveValidId = (candidate, pipelines) =>
  pipelines.some((p) => p.id === candidate) ? candidate : pipelines[0]?.id || ''

const recent = [
  { id: 'pipeline:a', kind: 'pipeline', pipelineId: 'a' },
  { id: 'pipeline:b', kind: 'pipeline', pipelineId: 'b' },
  { id: 'local:1', kind: 'local', localPath: '/tmp/x' }
]
const after = removeRecentByPipelineId(recent, 'a')
assert(after.length === 2, 'removed pipeline a from recent')
assert(!after.some((x) => x.pipelineId === 'a'), 'no leftover a')
assert(after.some((x) => x.kind === 'local'), 'local kept')

const pipes = [{ id: 'p1' }, { id: 'p2' }]
assert(resolveValidId('p2', pipes) === 'p2', 'valid id kept')
assert(resolveValidId('ghost', pipes) === 'p1', 'ghost falls back to first')
assert(resolveValidId('ghost', []) === '', 'empty list yields empty')

const lib = readFileSync(
  new URL('../src/renderer/src/lib/recentIdeProjects.ts', import.meta.url),
  'utf-8'
)
assert(lib.includes('removeRecentByPipelineId'), 'lib exports cleanup helper')

const dash = readFileSync(
  new URL('../src/renderer/src/pages/Dashboard.tsx', import.meta.url),
  'utf-8'
)
assert(dash.includes('removeRecentByPipelineId'), 'Dashboard cleans recent on delete')
assert(dash.includes('pipelines.some((p) => p.id === candidate)'), 'Dashboard validates id')

const editor = readFileSync(
  new URL('../src/renderer/src/pages/RepoEditorPage.tsx', import.meta.url),
  'utf-8'
)
assert(
  editor.includes('不静默回落到 active'),
  'editor documents no silent fallback'
)
assert(
  /if \(pipelineId\) return list\.find/.test(editor),
  'editor respects explicit pipelineId'
)

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf-8')
assert(app.includes('pipelines.some((p) => p.id === candidate)'), 'App validates pipeline id')

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll pipeline-recent cleanup checks passed')
