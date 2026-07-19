/**
 * P7：无伪造 thinking；刷新确认脏 tab；终端不拼接路径
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

const chat = readFileSync(
  new URL('../src/main/review-engine/chat-service.ts', import.meta.url),
  'utf-8'
)
assert(!chat.includes('小智思考了约'), 'no fake thinking fallback')
assert(chat.includes('不伪造占位文案'), 'documents real-thinking-only')

const page = readFileSync(
  new URL('../src/renderer/src/pages/ChatPage.tsx', import.meta.url),
  'utf-8'
)
assert(page.includes('小智在努力思考中'), 'typo fixed')
assert(!page.includes('小智在在努力思考中'), 'double 在 removed')

const editor = readFileSync(
  new URL('../src/renderer/src/pages/RepoEditorPage.tsx', import.meta.url),
  'utf-8'
)
assert(editor.includes('有未保存的更改'), 'dirty refresh confirm')
assert(editor.includes('丢弃并刷新'), 'confirm action label')

const ipc = readFileSync(
  new URL('../src/main/ipc-handlers/index.ts', import.meta.url),
  'utf-8'
)
assert(!ipc.includes('cd /d ${dir}'), 'no path interpolation in cmd')
assert(ipc.includes("cwd: dir"), 'windows terminal uses cwd')

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll P7 checks passed')
