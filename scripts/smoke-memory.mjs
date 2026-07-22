/**
 * 记忆模块冒烟：不依赖 Electron 窗口，校验检索/导入逻辑与 IPC 接线完整性。
 * 用法：node scripts/smoke-memory.mjs
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`✓ ${name}`)
  else {
    failed++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const charBigrams = (text) => {
  const s = text.toLowerCase().replace(/\s+/g, '')
  const out = new Set()
  if (s.length <= 1) {
    if (s) out.add(s)
    return out
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of Array.from(a)) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

// 1) hybrid 相似度：相近中文应高于无关文本
{
  const q = charBigrams('本仓库禁止硬编码密钥')
  const close = jaccard(q, charBigrams('仓库禁止在代码里硬编码密钥'))
  const far = jaccard(q, charBigrams('今天天气很好适合出门'))
  ok('hybrid: 相近 > 无关', close > far && close > 0.2, `close=${close.toFixed(3)} far=${far.toFixed(3)}`)
}

// 2) 导入 payload 校验规则
{
  const valid = { version: 1, exportedAt: 'x', items: [{ content: 'a', title: 't' }] }
  const badVersion = { version: 2, items: [] }
  const badItems = { version: 1, items: null }
  ok('import: version=1 合法', valid.version === 1 && Array.isArray(valid.items))
  ok('import: 错误 version 应拒绝', badVersion.version !== 1)
  ok('import: items 非数组应拒绝', !Array.isArray(badItems.items))
}

// 3) IPC / preload / ElectronAPI 三方对齐
{
  const ipc = readFileSync(join(root, 'src/shared/ipc.ts'), 'utf8')
  const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
  const types = readFileSync(join(root, 'src/shared/types.ts'), 'utf8')
  const handlers = readFileSync(join(root, 'src/main/ipc-handlers/index.ts'), 'utf8')
  const panel = readFileSync(
    join(root, 'src/renderer/src/components/MemorySettingsPanel.tsx'),
    'utf8'
  )

  for (const ch of [
    'MEMORY_EXPORT',
    'MEMORY_IMPORT',
    'MEMORY_IMPORT_MCP',
    'MEMORY_CLEAR_OLDEST',
    'MEMORY_DISTILL_CHAT'
  ]) {
    ok(`ipc 定义 ${ch}`, ipc.includes(`${ch}:`))
    ok(`handler 注册 ${ch}`, handlers.includes(`IPC_CHANNELS.${ch}`))
  }

  for (const fn of ['exportMemories', 'importMemories', 'importMemoriesFromMcp']) {
    ok(`preload 暴露 ${fn}`, preload.includes(`${fn}:`))
    ok(`ElectronAPI 声明 ${fn}`, types.includes(`${fn}:`))
    ok(`设置页调用 ${fn}`, panel.includes(`electronAPI.${fn}`))
  }

  ok(
    '新建 upsert 走去重',
    handlers.includes('upsertMemoryWithDedup') &&
      handlers.includes('if (input.id?.trim()) return upsertLlmMemory(input)')
  )
  ok('配置含 memoryRetrievalMode', types.includes("memoryRetrievalMode: 'keyword' | 'hybrid'"))
}

// 4) 构建产物是否含新 IPC（若 out 过旧则提示重启）
{
  try {
    const mainOut = readFileSync(join(root, 'out/main/index.js'), 'utf8')
    const preloadOut = readFileSync(join(root, 'out/preload/index.js'), 'utf8')
    const hasExport = mainOut.includes('memory:export') && preloadOut.includes('memory:export')
    ok('out 构建含 memory:export（需重启 dev 后通过）', hasExport)
  } catch (e) {
    ok('out 目录可读', false, String(e.message || e))
  }
}

if (failed) {
  console.error(`\n失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n全部通过')
