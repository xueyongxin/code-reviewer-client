/**
 * 验证：refreshChatSessions 在当前会话仍有效时不因 preferId 强切；
 * 重新生成路径不会再追加一条 user。
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

/** 与 useAppStore.refreshChatSessions 对齐的选型逻辑 */
const pickNextId = (current, summaries, preferId) => {
  if (current && summaries.some((s) => s.id === current)) return current
  if (preferId != null && summaries.some((s) => s.id === preferId)) return preferId
  return summaries[0]?.id ?? null
}

const list = [{ id: 'A' }, { id: 'B' }, { id: 'S' }]
assert(pickNextId('B', list, 'S') === 'B', 'stay on B when prefer S')
assert(pickNextId('A', list, 'A') === 'A', 'stay on A when prefer A')
assert(pickNextId(null, list, 'S') === 'S', 'adopt prefer when no current')
assert(pickNextId('gone', list, 'S') === 'S', 'adopt prefer when current missing')
assert(pickNextId('gone', list, undefined) === 'A', 'fallback first when no prefer')

const storeSrc = readFileSync(
  new URL('../src/renderer/src/store/useAppStore.ts', import.meta.url),
  'utf-8'
)
assert(
  storeSrc.includes('当前选中仍有效时绝不强切'),
  'store comment documents no-force policy'
)
assert(
  storeSrc.includes('summaries.some((s) => s.id === current)'),
  'store keeps current when valid'
)

const typesSrc = readFileSync(
  new URL('../src/shared/types.ts', import.meta.url),
  'utf-8'
)
assert(typesSrc.includes('regenerate?: boolean'), 'SendChatPayload has regenerate')

const chatSrc = readFileSync(
  new URL('../src/main/review-engine/chat-service.ts', import.meta.url),
  'utf-8'
)
assert(chatSrc.includes('payload.regenerate'), 'chat-service handles regenerate')
assert(chatSrc.includes('deleteTrailingAssistantMessages'), 'deletes trailing assistants')
assert(
  /if \(!payload\.regenerate\) \{[\s\S]*appendChatMessage\(userMessage\)/.test(chatSrc),
  'append user only when not regenerate'
)

const pageSrc = readFileSync(
  new URL('../src/renderer/src/pages/ChatPage.tsx', import.meta.url),
  'utf-8'
)
assert(pageSrc.includes('regenerate: true'), 'UI passes regenerate flag')
assert(!/regenerateLast[\s\S]*await sendContent\(lastUser/.test(pageSrc), 'regenerate not via sendContent')

const dbSrc = readFileSync(
  new URL('../src/main/database/db.ts', import.meta.url),
  'utf-8'
)
assert(dbSrc.includes('deleteTrailingAssistantMessages'), 'db helper exists')

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll chat-session-refresh checks passed')
