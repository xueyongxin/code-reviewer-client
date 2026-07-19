/**
 * P8：checkout 锁串行；Chat generation token；工作区切换 helper
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

const repo = readFileSync(
  new URL('../src/main/review-engine/repo-browser.ts', import.meta.url),
  'utf-8'
)
assert(repo.includes('严格串行'), 'ensureCheckout documents serial lock')
assert(
  /previous\s*=\s*checkoutLocks\.get\(lockKey\)/.test(repo),
  'chains onto previous lock'
)

const chat = readFileSync(
  new URL('../src/main/review-engine/chat-service.ts', import.meta.url),
  'utf-8'
)
assert(chat.includes('generationToken'), 'generation token present')
assert(chat.includes('GenerationCancelledError'), 'cancel error type')
assert(chat.includes('activeGeneration?.token === generationToken'), 'token-scoped cleanup')

const ws = readFileSync(
  new URL('../src/renderer/src/lib/ideWorkspace.ts', import.meta.url),
  'utf-8'
)
assert(ws.includes('shouldLeaveLocalOnPipelineNav'), 'workspace helper exported')

const editor = readFileSync(
  new URL('../src/renderer/src/pages/RepoEditorPage.tsx', import.meta.url),
  'utf-8'
)
assert(editor.includes('shouldLeaveLocalOnPipelineNav'), 'editor uses workspace helper')

const page = readFileSync(
  new URL('../src/renderer/src/pages/ChatPage.tsx', import.meta.url),
  'utf-8'
)
assert(page.includes('已停止生成'), 'UI surfaces cancel feedback')

// 串行锁语义模拟
const locks = new Map()
const order = []
const ensure = async (key, label, ms) => {
  const previous = locks.get(key) ?? Promise.resolve()
  let run
  run = previous
    .catch(() => {})
    .then(async () => {
      order.push(`start:${label}`)
      await new Promise((r) => setTimeout(r, ms))
      order.push(`end:${label}`)
      return label
    })
    .finally(() => {
      if (locks.get(key) === run) locks.delete(key)
    })
  locks.set(key, run)
  return run
}

await Promise.all([ensure('r', 'A', 30), ensure('r', 'B', 10), ensure('r', 'C', 5)])
assert(
  order.join(',') === 'start:A,end:A,start:B,end:B,start:C,end:C',
  'lock runs fully serial'
)

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll P8 checks passed')
