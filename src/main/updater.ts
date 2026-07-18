import { app, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppConfig, UpdateCheckResult } from '../shared/types'

let configuredFeed = ''

const semverNewer = (latest: string, current: string): boolean => {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/** 配置通用更新源（配置中心 updateFeedUrl，目录下需有 latest*.yml） */
export const configureAutoUpdater = (feedUrl: string): void => {
  const feed = feedUrl.trim().replace(/\/$/, '')
  if (!feed || feed === configuredFeed) return
  configuredFeed = feed
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  } catch (e) {
    console.warn('[updater] setFeedURL failed', e)
  }
}

/**
 * 检查更新：
 * 1) 若 feed 为 GitHub releases API → 打开网页（兼容旧配置）
 * 2) 否则走 electron-updater generic（需 builder 发布 yml）
 * 3) 再回退到 JSON {version,url}
 */
export const checkAppUpdates = async (config: AppConfig): Promise<UpdateCheckResult> => {
  const currentVersion = app.getVersion()
  const feed = config.updateFeedUrl?.trim()
  if (!feed) {
    return {
      updateAvailable: false,
      currentVersion,
      message:
        '未配置更新源。请在管理后台配置中心填写「客户端更新源」，或本地 Settings → Update Feed URL。'
    }
  }

  try {
    if (feed.includes('api.github.com') && feed.includes('/releases')) {
      const response = await fetch(feed, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'code-reviewer-client'
        }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as {
        tag_name?: string
        name?: string
        html_url?: string
      }
      const latest = (data.tag_name || data.name || '').replace(/^v/i, '')
      if (!latest) {
        return { updateAvailable: false, currentVersion, message: '无法解析最新版本号' }
      }
      const updateAvailable = semverNewer(latest, currentVersion)
      if (updateAvailable && data.html_url) {
        await shell.openExternal(data.html_url)
      }
      return {
        updateAvailable,
        currentVersion,
        latestVersion: latest,
        message: updateAvailable
          ? `发现新版本 ${latest}（当前 ${currentVersion}），已打开发布页`
          : `已是最新版本 ${currentVersion}`
      }
    }

    // electron-updater generic
    configureAutoUpdater(feed)
    try {
      const result = await autoUpdater.checkForUpdates()
      const latest = result?.updateInfo?.version?.replace(/^v/i, '') || ''
      if (latest && semverNewer(latest, currentVersion)) {
        const choice = await dialog.showMessageBox({
          type: 'info',
          buttons: ['下载并安装', '稍后'],
          defaultId: 0,
          cancelId: 1,
          title: '发现新版本',
          message: `发现新版本 ${latest}`,
          detail: `当前版本 ${currentVersion}。下载完成后将提示重启安装。`
        })
        if (choice.response === 0) {
          await autoUpdater.downloadUpdate()
          const install = await dialog.showMessageBox({
            type: 'info',
            buttons: ['立即重启安装', '稍后'],
            defaultId: 0,
            cancelId: 1,
            title: '下载完成',
            message: '更新已下载，是否立即重启安装？'
          })
          if (install.response === 0) {
            autoUpdater.quitAndInstall()
          }
        }
        return {
          updateAvailable: true,
          currentVersion,
          latestVersion: latest,
          message: `发现新版本 ${latest}`
        }
      }
      if (latest) {
        return {
          updateAvailable: false,
          currentVersion,
          latestVersion: latest,
          message: `已是最新版本 ${currentVersion}`
        }
      }
    } catch (e) {
      console.warn('[updater] electron-updater check failed, fallback JSON', e)
    }

    const response = await fetch(feed)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as { version?: string; url?: string }
    const latest = (data.version || '').replace(/^v/i, '')
    if (!latest) {
      return { updateAvailable: false, currentVersion, message: 'Feed 缺少 version 字段' }
    }
    const updateAvailable = semverNewer(latest, currentVersion)
    if (updateAvailable && data.url) {
      await shell.openExternal(data.url)
    }
    return {
      updateAvailable,
      currentVersion,
      latestVersion: latest,
      message: updateAvailable
        ? `发现新版本 ${latest}${data.url ? '，已打开下载页' : ''}`
        : `已是最新版本 ${currentVersion}`
    }
  } catch (error) {
    return {
      updateAvailable: false,
      currentVersion,
      message: `检查更新失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}
