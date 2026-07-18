import { resolve } from 'path'
import { app } from 'electron'

export const DESKTOP_PROTOCOL = 'codereviewer'

type AuthUrlHandler = (url: string) => void

let authUrlHandler: AuthUrlHandler | null = null
let pendingAuthUrl: string | null = null

export const registerDesktopProtocol = (): void => {
  // 开发态：把当前 Electron + 入口脚本注册为协议处理程序
  if (process.defaultApp) {
    const entry = process.argv.find(
      (a, i) => i > 0 && !a.startsWith('-') && !a.startsWith(`${DESKTOP_PROTOCOL}://`)
    )
    if (entry) {
      const ok = app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL, process.execPath, [
        resolve(entry)
      ])
      console.info(`[auth] setAsDefaultProtocolClient(dev)=${ok} entry=${resolve(entry)}`)
      return
    }
  }
  const ok = app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL)
  console.info(`[auth] setAsDefaultProtocolClient(prod)=${ok}`)
}

export const extractProtocolUrl = (argv: string[]): string | null => {
  const hit = argv.find((a) => a.startsWith(`${DESKTOP_PROTOCOL}://`))
  return hit || null
}

export const setAuthUrlHandler = (handler: AuthUrlHandler): void => {
  authUrlHandler = handler
  if (pendingAuthUrl) {
    const url = pendingAuthUrl
    pendingAuthUrl = null
    handler(url)
  }
}

export const dispatchAuthUrl = (url: string): void => {
  if (!url.startsWith(`${DESKTOP_PROTOCOL}://`)) return
  if (authUrlHandler) {
    authUrlHandler(url)
  } else {
    pendingAuthUrl = url
  }
}
