import { app, shell } from 'electron'
import type { AppConfig, UpdateCheckResult } from '../shared/types'

export const checkAppUpdates = async (config: AppConfig): Promise<UpdateCheckResult> => {
  const currentVersion = app.getVersion()
  const feed = config.updateFeedUrl?.trim()
  if (!feed) {
    return {
      updateAvailable: false,
      currentVersion,
      message:
        '未配置更新源（Settings → Update Feed URL）。可填 GitHub API：https://api.github.com/repos/owner/repo/releases/latest'
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

      const updateAvailable = latest !== currentVersion
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

    const response = await fetch(feed)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as { version?: string; url?: string }
    const latest = (data.version || '').replace(/^v/i, '')
    if (!latest) {
      return { updateAvailable: false, currentVersion, message: 'Feed 缺少 version 字段' }
    }
    const updateAvailable = latest !== currentVersion
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
