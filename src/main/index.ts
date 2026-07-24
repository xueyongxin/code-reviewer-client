import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { initDatabase } from './database/db'
import { getAppConfig, redactConfigForRenderer } from './config/store'
import { configureAutoUpdater } from './updater'
import { mcpRegistry } from './mcp-manager/registry'
import { warmMcpRepoCache } from './review-engine/mcp-repos'
import {
  cloudHandleAuthCallback,
  setBrowserAuthCompleteHandler
} from './cloud/client'
import {
  DESKTOP_PROTOCOL,
  dispatchAuthUrl,
  extractProtocolUrl,
  registerDesktopProtocol,
  setAuthUrlHandler
} from './cloud/deep-link'
import { IPC_CHANNELS } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = extractProtocolUrl(argv)
    if (url) dispatchAuthUrl(url)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  registerDesktopProtocol()
  console.info(`[auth] protocol registered: ${DESKTOP_PROTOCOL}://`)

  app.on('open-url', (event, url) => {
    event.preventDefault()
    dispatchAuthUrl(url)
  })

  const notifyAuthResult = (payload: {
    ok: boolean
    config?: Awaited<ReturnType<typeof cloudHandleAuthCallback>>
    error?: string
  }): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const safe = {
      ...payload,
      config: payload.config ? redactConfigForRenderer(payload.config) : undefined
    }
    mainWindow.webContents.send(IPC_CHANNELS.CLOUD_AUTH_COMPLETE, safe)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    try {
      if (payload.ok) app.focus({ steal: true })
    } catch {
      // older electron
    }
  }

  /** 协议回调与 loopback 可能先后到达：成功后忽略迟到的失败，避免误弹错 */
  let lastAuthOkAt = 0
  const notifyAuthResultSafe = (payload: {
    ok: boolean
    config?: Awaited<ReturnType<typeof cloudHandleAuthCallback>>
    error?: string
  }): void => {
    if (!payload.ok && Date.now() - lastAuthOkAt < 15_000) {
      console.warn('[auth] ignore late auth error after success:', payload.error)
      return
    }
    if (payload.ok) lastAuthOkAt = Date.now()
    notifyAuthResult(payload)
  }

  const bindAuthUrlHandler = (): void => {
    setBrowserAuthCompleteHandler(notifyAuthResultSafe)
    setAuthUrlHandler((url) => {
      void (async () => {
        try {
          const config = await cloudHandleAuthCallback(url)
          notifyAuthResultSafe({ ok: true, config })
        } catch (e) {
          notifyAuthResultSafe({
            ok: false,
            error: e instanceof Error ? e.message : '授权登录失败'
          })
        }
      })()
    })
  }

  const createWindow = (): void => {
    const isMac = process.platform === 'darwin'
    const iconPath = join(__dirname, '../../resources/icon.png')
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: 'Code Reviewer Client',
      backgroundColor: '#ffffff',
      icon: iconPath,
      // macOS：隐藏系统黑标题栏，红绿灯嵌入内容区（与 Cursor 同款）
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 14, y: 12 }
          }
        : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    if (isMac) {
      console.info('[window] titleBarStyle=hiddenInset trafficLights inset')
    }

    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  const restoreMcpConnections = async (): Promise<void> => {
    const config = getAppConfig()
    const results = await mcpRegistry.autoConnectEnabled(config.mcpServers)
    await Promise.all(
      results
        .filter((s) => s.connected)
        .map((s) => warmMcpRepoCache(s.serverId).catch(() => undefined))
    )
  }

  app.whenReady().then(() => {
    app.setName('Code Reviewer Client')
    initDatabase()
    bindAuthUrlHandler()
    registerIpcHandlers(() => mainWindow)
    createWindow()

    const bootConfig = getAppConfig()
    if (bootConfig.updateFeedUrl) {
      configureAutoUpdater(bootConfig.updateFeedUrl)
    }

    const bootUrl = extractProtocolUrl(process.argv)
    if (bootUrl) dispatchAuthUrl(bootUrl)

    void restoreMcpConnections().catch((error) => {
      console.error('[mcp] auto-reconnect failed:', error)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    void mcpRegistry.disconnectAll()
  })
}
