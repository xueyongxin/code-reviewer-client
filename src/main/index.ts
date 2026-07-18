import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { initDatabase } from './database/db'
import { getAppConfig } from './config/store'
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
    mainWindow.webContents.send(IPC_CHANNELS.CLOUD_AUTH_COMPLETE, payload)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    try {
      if (payload.ok) app.focus({ steal: true })
    } catch {
      // older electron
    }
  }

  const bindAuthUrlHandler = (): void => {
    setBrowserAuthCompleteHandler(notifyAuthResult)
    setAuthUrlHandler((url) => {
      void (async () => {
        try {
          const config = await cloudHandleAuthCallback(url)
          notifyAuthResult({ ok: true, config })
        } catch (e) {
          notifyAuthResult({
            ok: false,
            error: e instanceof Error ? e.message : '授权登录失败'
          })
        }
      })()
    })
  }

  const createWindow = (): void => {
    const isMac = process.platform === 'darwin'
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: 'Code Reviewer Client',
      backgroundColor: '#ffffff',
      // macOS：隐藏系统黑标题栏，红绿灯嵌入内容区（与 Cursor 同款）
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 14, y: 6 }
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
