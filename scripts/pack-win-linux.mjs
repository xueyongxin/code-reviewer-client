/**
 * 在 macOS 上交叉打包 Windows / Linux（注入 better-sqlite3 预编译二进制）
 * 用法：node scripts/pack-win-linux.mjs
 */
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const bsql = join(root, 'node_modules/better-sqlite3')
const releaseNode = join(bsql, 'build/Release/better_sqlite3.node')
const cache = join(tmpdir(), 'bsql-prebuilds')
const proxy = process.env.GH_PROXY || 'https://ghproxy.net/'
const base =
  'https://github.com/WiseLibs/better-sqlite3/releases/download/v11.8.1'
const winUrl = `${proxy}${base}/better-sqlite3-v11.8.1-electron-v119-win32-x64.tar.gz`
const linuxUrl = `${proxy}${base}/better-sqlite3-v11.8.1-electron-v119-linux-x64.tar.gz`

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
}

const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`)
  execSync(cmd, { cwd: root, stdio: 'inherit', env, ...opts })
}

const download = (url, dest) => {
  console.log(`下载: ${url}`)
  execFileSync('curl', ['-L', '--connect-timeout', '30', '--max-time', '300', '-o', dest, url], {
    stdio: 'inherit'
  })
}

mkdirSync(cache, { recursive: true })
mkdirSync(join(bsql, 'build/Release'), { recursive: true })

// 备份本机二进制，结束时还原
const darwinBackup = join(cache, 'better_sqlite3.darwin.node')
if (existsSync(releaseNode) && !existsSync(darwinBackup)) {
  copyFileSync(releaseNode, darwinBackup)
}

const ensureTar = (name, url) => {
  const tar = join(cache, name)
  if (!existsSync(tar) || execFileSync('stat', ['-f%z', tar], { encoding: 'utf8' }).trim() === '0') {
    download(url, tar)
  }
  return tar
}

const inject = (tarPath, label) => {
  const dir = join(cache, label)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xzf', tarPath, '-C', dir], { stdio: 'inherit' })
  const node = join(dir, 'build/Release/better_sqlite3.node')
  if (!existsSync(node)) throw new Error(`${label} prebuild 缺少 better_sqlite3.node`)
  copyFileSync(node, releaseNode)
  console.log(`已注入 ${label} better_sqlite3.node`)
}

try {
  run('npm run build')

  const winTar = ensureTar('win.tar.gz', winUrl)
  inject(winTar, 'win')
  // portable 不依赖 Wine；nsis 在无 Wine 时可能失败，失败则仅保留 portable
  try {
    run('npx electron-builder --win portable nsis --x64 -c.npmRebuild=false')
  } catch {
    console.warn('NSIS 可能因缺少 Wine 失败，改打 portable…')
    run('npx electron-builder --win portable --x64 -c.npmRebuild=false')
  }

  const linuxTar = ensureTar('linux.tar.gz', linuxUrl)
  inject(linuxTar, 'linux')
  run('npx electron-builder --linux AppImage --x64 -c.npmRebuild=false')
} finally {
  if (existsSync(darwinBackup)) {
    copyFileSync(darwinBackup, releaseNode)
    console.log('已还原本机 darwin better_sqlite3.node')
  }
  // 本机开发需要 electron-rebuild
  try {
    run('npx electron-rebuild -f -w better-sqlite3')
  } catch (e) {
    console.warn('还原后 rebuild 失败，请手动执行 npm run postinstall', e)
  }
}

console.log('\n产物目录: release/')
run('ls -lah release')
