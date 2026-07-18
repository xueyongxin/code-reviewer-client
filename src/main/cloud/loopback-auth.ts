import http from 'http'
import type { AddressInfo } from 'net'

export type LoopbackAuthHandlers = {
  expectedState: string
  onCode: (code: string, state: string) => Promise<void>
  onError?: (message: string) => void
}

type ActiveServer = {
  server: http.Server
  port: number
  close: () => void
}

let active: ActiveServer | null = null

const successHtml = (ok: boolean, detail: string): string => {
  const title = ok ? '桌面端已登录' : '授权失败'
  const accent = ok ? '#16a34a' : '#dc2626'
  const accentDeep = ok ? '#15803d' : '#b91c1c'
  const soft = ok ? 'rgba(22, 163, 74, 0.14)' : 'rgba(220, 38, 38, 0.12)'
  const iconPath = ok
    ? '<path d="M20 6.5L9.5 17 4 11.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Code Reviewer</title>
  <style>
    :root {
      --bg: #f4faf6;
      --text: #14261b;
      --muted: #6b8575;
      --accent: ${accent};
      --accent-deep: ${accentDeep};
      --soft: ${soft};
      --line: rgba(15, 80, 40, 0.1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
      color: var(--text);
      font-family: "SF Pro Display", "PingFang SC", "Hiragino Sans GB",
        "Noto Sans SC", -apple-system, BlinkMacSystemFont, sans-serif;
      background:
        radial-gradient(920px 520px at 12% -8%, rgba(22, 163, 74, 0.18), transparent 56%),
        radial-gradient(760px 480px at 100% 0%, rgba(255, 255, 255, 0.95), transparent 50%),
        radial-gradient(640px 420px at 70% 110%, rgba(21, 128, 61, 0.08), transparent 55%),
        var(--bg);
    }
    .stage {
      width: min(420px, 100%);
      text-align: center;
      animation: rise 0.55s cubic-bezier(0.32, 0.72, 0, 1) both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .brand-mark {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      background: linear-gradient(145deg, #16a34a 0%, #15803d 100%);
      box-shadow: 0 6px 14px rgba(22, 163, 74, 0.28);
    }
    .panel {
      position: relative;
      padding: 40px 32px 34px;
      border-radius: 22px;
      background: rgba(255, 255, 255, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.85);
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.9) inset,
        0 18px 48px rgba(20, 60, 35, 0.08);
      backdrop-filter: blur(12px);
      overflow: hidden;
    }
    .panel::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 3px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      opacity: 0.85;
    }
    .icon-wrap {
      position: relative;
      width: 72px;
      height: 72px;
      margin: 0 auto 20px;
    }
    .icon-ring {
      position: absolute;
      inset: -8px;
      border-radius: 50%;
      background: var(--soft);
      animation: pulse 1.6s ease-out both;
    }
    @keyframes pulse {
      0% { transform: scale(0.7); opacity: 0; }
      40% { opacity: 1; }
      100% { transform: scale(1.15); opacity: 0; }
    }
    .icon {
      position: relative;
      width: 72px;
      height: 72px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, var(--accent) 0%, var(--accent-deep) 100%);
      box-shadow: 0 14px 32px ${ok ? 'rgba(22, 163, 74, 0.32)' : 'rgba(220, 38, 38, 0.28)'};
      animation: pop 0.5s cubic-bezier(0.34, 1.4, 0.64, 1) 0.08s both;
    }
    @keyframes pop {
      from { transform: scale(0.6); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    .icon svg {
      width: 34px;
      height: 34px;
      animation: draw 0.45s ease 0.28s both;
    }
    @keyframes draw {
      from { opacity: 0; transform: scale(0.7); }
      to { opacity: 1; transform: scale(1); }
    }
    h1 {
      margin: 0;
      font-size: clamp(1.7rem, 4vw, 2rem);
      line-height: 1.15;
      letter-spacing: -0.035em;
      font-weight: 650;
    }
    .detail {
      margin: 12px auto 0;
      max-width: 300px;
      font-size: 14px;
      line-height: 1.55;
      color: var(--muted);
      letter-spacing: -0.01em;
    }
    .hint {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
      font-size: 12.5px;
      color: var(--muted);
    }
    .hint strong {
      color: var(--text);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span>Code Reviewer</span>
    </div>
    <div class="panel">
      <div class="icon-wrap">
        <div class="icon-ring" aria-hidden="true"></div>
        <div class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${iconPath}</svg>
        </div>
      </div>
      <h1>${title}</h1>
      <p class="detail">${detail}</p>
      <p class="hint">${
        ok
          ? '授权已同步到桌面端，可直接关闭此页继续使用 <strong>Code Reviewer Client</strong>。'
          : '请回到桌面端重新点击登录后再试。'
      }</p>
    </div>
  </div>
</body>
</html>`
}

export const stopLoopbackAuthServer = (): void => {
  if (!active) return
  try {
    active.close()
  } catch {
    // ignore
  }
  active = null
}

/** 启动本机回环回调，供浏览器登录成功后可靠唤起桌面端 */
export const startLoopbackAuthServer = async (
  handlers: LoopbackAuthHandlers
): Promise<{ port: number }> => {
  stopLoopbackAuthServer()

  const server = http.createServer((req, res) => {
    const allowOrigin = '*'
    res.setHeader('Access-Control-Allow-Origin', allowOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      const url = new URL(req.url || '/', `http://127.0.0.1`)
      if (url.pathname !== '/callback' && url.pathname !== '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }

      const code = url.searchParams.get('code') || ''
      const state = url.searchParams.get('state') || ''

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(successHtml(false, '回调缺少 code 或 state，请从桌面端重新登录。'))
        return
      }

      if (state !== handlers.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(successHtml(false, '授权状态不匹配，请从桌面端重新点击登录。'))
        handlers.onError?.('授权状态不匹配')
        return
      }

      void handlers
        .onCode(code, state)
        .then(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(
              successHtml(
                true,
                '可以关闭此浏览器标签页，继续回到 Code Reviewer Client。'
              )
            )
          }
          // 先写完响应再关服务，避免连接被提前掐断
          setTimeout(() => stopLoopbackAuthServer(), 800)
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : '登录失败'
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(successHtml(false, msg))
          }
          handlers.onError?.(msg)
        })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '回调处理失败'
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(successHtml(false, msg))
      handlers.onError?.(msg)
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(addr.port)
    })
  })

  active = {
    server,
    port,
    close: () => {
      server.close()
    }
  }

  // 5 分钟未回调则自动关闭
  setTimeout(() => {
    if (active?.port === port) stopLoopbackAuthServer()
  }, 5 * 60 * 1000)

  return { port }
}
