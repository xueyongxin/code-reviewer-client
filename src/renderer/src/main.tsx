import React from 'react'
import ReactDOM from 'react-dom/client'
import { message, App as AntApp } from 'antd'
import App from './App'
import { AppearanceProvider } from './prefs/AppearanceProvider'
import { applyResolvedTheme, readThemeMode, resolveTheme } from './prefs/appearance'
import './monaco-env'
import './styles.css'

const ua = navigator.userAgent
document.body.classList.add(
  /Mac/i.test(ua) ? 'platform-mac' : /Windows/i.test(ua) ? 'platform-win' : 'platform-linux'
)

// 首屏前同步主题，避免闪白
applyResolvedTheme(resolveTheme(readThemeMode()))

message.config({
  top: 56,
  duration: 2.2,
  maxCount: 3
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <AntApp>
        <App />
      </AntApp>
    </AppearanceProvider>
  </React.StrictMode>
)
