/**
 * 校验瘦身后的安装包：无前端双份依赖 + 打包版核心功能冒烟
 * 用法：npm run pack && npm run verify:pack
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const appPath = join(
  root,
  'release/mac-arm64/Code Reviewer Client.app/Contents/MacOS/Code Reviewer Client'
)
const asarPath = join(
  root,
  'release/mac-arm64/Code Reviewer Client.app/Contents/Resources/app.asar'
)

const FORBIDDEN = [
  'monaco-editor',
  'antd',
  '@ant-design',
  'react',
  'react-dom',
  'react-router-dom',
  'react-markdown',
  'remark-gfm',
  'zustand'
]
const REQUIRED = ['better-sqlite3', 'electron-store', 'js-yaml', '@modelcontextprotocol']

let passed = 0
const ok = (msg) => {
  passed += 1
  console.log(`  ✓ ${msg}`)
}
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(appPath) || !existsSync(asarPath)) {
  fail('未找到打包产物，请先执行 npm run pack')
}

console.log('\n[1] 体积与 asar 内容')
const appDir = join(root, 'release/mac-arm64/Code Reviewer Client.app')
const sizeMb = Number(
  execFileSync('du', ['-sm', appDir], { encoding: 'utf8' }).split('\t')[0]
)
console.log(`  · App 体积: ${sizeMb} MB`)
if (sizeMb >= 380) fail(`体积仍偏大（${sizeMb}MB），预期约 <320MB`)
ok(`体积 ${sizeMb}MB < 380MB`)

const extractDir = join(tmpdir(), `cr-asar-verify-${Date.now()}`)
mkdirSync(extractDir, { recursive: true })
try {
  execFileSync('npx', ['--yes', 'asar', 'extract', asarPath, extractDir], {
    stdio: 'pipe',
    cwd: root
  })
} catch (e) {
  fail(`asar 解压失败: ${e instanceof Error ? e.message : e}`)
}

const nm = join(extractDir, 'node_modules')
for (const name of FORBIDDEN) {
  if (existsSync(join(nm, name))) fail(`asar 仍包含前端依赖: ${name}`)
}
ok('asar 不含 monaco/antd/react 等前端库')

for (const name of REQUIRED) {
  const path = name.startsWith('@')
    ? join(nm, ...name.split('/'))
    : join(nm, name)
  // @modelcontextprotocol -> @modelcontextprotocol/sdk
  const check =
    name === '@modelcontextprotocol'
      ? join(nm, '@modelcontextprotocol', 'sdk')
      : path
  if (!existsSync(check)) fail(`asar 缺少主进程依赖: ${name}`)
}
ok('asar 含 better-sqlite3 / electron-store / js-yaml / mcp sdk')

if (!existsSync(join(extractDir, 'out', 'main', 'index.js'))) {
  fail('asar 缺少 out/main/index.js')
}
if (!existsSync(join(extractDir, 'out', 'renderer', 'index.html'))) {
  fail('asar 缺少 out/renderer/index.html')
}
ok('asar 含 out/main 与 out/renderer')

rmSync(extractDir, { recursive: true, force: true })

const clickNav = async (page, label) => {
  const item = page.locator('.app-sider-item', { hasText: label }).first()
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await page.waitForTimeout(700)
}

const runSmokeOnce = async (passIndex) => {
  console.log(`\n[2.${passIndex}] 打包版功能冒烟`)
  const userData = join(tmpdir(), `cr-pack-smoke-${Date.now()}-${passIndex}`)
  mkdirSync(userData, { recursive: true })
  const shotDir = join(root, 'test-artifacts', 'verify-pack')
  mkdirSync(shotDir, { recursive: true })

  const app = await electron.launch({
    executablePath: appPath,
    args: [`--user-data-dir=${userData}`],
    timeout: 60000
  })

  try {
    const page = await app.firstWindow({ timeout: 60000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    await clickNav(page, '对话')
    await page.waitForSelector('.chat-composer-input, .chat-welcome', { timeout: 20000 })
    ok(`P${passIndex} 对话页加载`)

    const input = page.locator('.chat-composer-input')
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.fill('/')
    await page.waitForTimeout(400)
    if (!(await page.locator('.chat-cmd-menu').count())) throw new Error('命令菜单未出现')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    await input.fill('/help')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    if (!(await page.locator('.chat-assistant-content', { hasText: '可用命令' }).count())) {
      throw new Error('/help 无回复')
    }
    ok(`P${passIndex} /help 命令`)

    await clickNav(page, '新建审查')
    await page.waitForTimeout(500)
    if (!(await page.getByText('新建流水线').count()) && !(await page.getByText('新建审查').count())) {
      throw new Error('新建审查页未打开')
    }
    ok(`P${passIndex} 新建审查页`)

    await clickNav(page, '审查记录')
    await page.waitForTimeout(600)
    ok(`P${passIndex} 审查记录页`)

    await clickNav(page, '对话')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.chat-composer-input, .chat-welcome', { timeout: 15000 })
    ok(`P${passIndex} 回到对话页`)

    const ipc = await page.evaluate(async () => {
      const api = window.electronAPI
      if (!api) return { ok: false, reason: 'no-api' }
      const cfg = await api.getConfig()
      const sessions = await api.listChatSessions()
      const history = await api.getReportHistory?.()
      const mcp = await api.listMcpStatus?.()
      const created = await api.createChatSession()
      const full = await api.getChatSession(created.id)
      await api.deleteChatSession(created.id)
      const gone = await api.getChatSession(created.id)
      return {
        ok: Boolean(
          cfg &&
            Array.isArray(sessions) &&
            created?.id &&
            full?.id === created.id &&
            !gone
        ),
        hasHistory: Array.isArray(history),
        hasMcp: Array.isArray(mcp),
        providers: cfg?.llmProviders?.length ?? 0
      }
    })
    if (!ipc.ok) throw new Error(`IPC/SQLite 失败: ${JSON.stringify(ipc)}`)
    ok(`P${passIndex} IPC 配置/历史/MCP/会话 CRUD`)

    await page.screenshot({
      path: join(shotDir, `pass-${passIndex}.png`),
      fullPage: true
    })
  } catch (e) {
    try {
      const page = app.windows()[0]
      if (page) {
        await page.screenshot({
          path: join(shotDir, `fail-pass-${passIndex}.png`),
          fullPage: true
        })
      }
    } catch {
      // ignore
    }
    await app.close()
    throw e
  }

  await app.close()
}

// 连续 3 轮独立进程冒烟，避免偶发误判
for (let p = 1; p <= 3; p++) {
  try {
    await runSmokeOnce(p)
  } catch (e) {
    fail(`冒烟第 ${p} 轮: ${e instanceof Error ? e.message : e}`)
  }
}

writeFileSync(
  join(root, 'test-artifacts', 'verify-pack', 'summary.txt'),
  `verify-pack ok\nsizeMb=${sizeMb}\npassed=${passed}\n`,
  'utf8'
)
console.log(`\n全部通过：${passed} 项（App ${sizeMb}MB）\n`)
