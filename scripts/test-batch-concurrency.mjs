/**
 * 批量并发钳制 + 有界队列行为自测（不依赖 Electron）
 * 运行：node scripts/test-batch-concurrency.mjs
 */

const DEFAULT = 2
const MIN = 1
const MAX = 5

const clamp = (value) => {
  if (value == null) return DEFAULT
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT
  return Math.min(MAX, Math.max(MIN, n))
}

const runPool = async (items, concurrency, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        results[index] = await worker(items[index])
      }
    }
  )
  await Promise.all(runners)
  return results
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

console.log('1) clampBatchReviewConcurrency')
assert('undefined → 2', clamp(undefined) === 2)
assert('null → 2', clamp(null) === 2)
assert('NaN → 2', clamp(Number.NaN) === 2)
assert('0 → 1', clamp(0) === 1)
assert('1 → 1', clamp(1) === 1)
assert('2 → 2', clamp(2) === 2)
assert('5 → 5', clamp(5) === 5)
assert('6 → 5', clamp(6) === 5)
assert('3.9 → 3', clamp(3.9) === 3)
assert('"4" → 4', clamp('4') === 4)

console.log('2) runPool concurrency bound')
{
  let live = 0
  let peak = 0
  const items = [1, 2, 3, 4, 5, 6]
  const concurrency = 2
  await runPool(items, concurrency, async (n) => {
    live += 1
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 30))
    live -= 1
    return n * 10
  })
  assert(`peak concurrency ≤ ${concurrency} (got ${peak})`, peak <= concurrency)
  assert('peak reached concurrency', peak === concurrency)
}

console.log('3) runPool preserves order')
{
  const out = await runPool([1, 2, 3, 4], 2, async (n) => {
    await new Promise((r) => setTimeout(r, 10 * (5 - n)))
    return n
  })
  assert('order preserved', JSON.stringify(out) === JSON.stringify([1, 2, 3, 4]))
}

console.log('4) failure isolation')
{
  const out = await runPool([1, 2, 3], 2, async (n) => {
    if (n === 2) return { status: 'failed', n }
    return { status: 'completed', n }
  })
  assert(
    'others continue',
    out[0].status === 'completed' &&
      out[1].status === 'failed' &&
      out[2].status === 'completed'
  )
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
