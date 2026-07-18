import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import {
  applyResolvedTheme,
  readLocale,
  readThemeMode,
  resolveTheme,
  writeLocale,
  writeThemeMode,
  type AppLocale,
  type ResolvedTheme,
  type ThemeMode
} from './appearance'
import { translate, type MessageKey } from '../i18n/messages'

type AppearanceContextValue = {
  themeMode: ThemeMode
  resolvedTheme: ResolvedTheme
  locale: AppLocale
  setThemeMode: (mode: ThemeMode) => void
  setLocale: (locale: AppLocale) => void
  t: (key: MessageKey) => string
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

const lightTokens = {
  colorPrimary: '#16a34a',
  colorInfo: '#0284c7',
  colorSuccess: '#16a34a',
  colorWarning: '#d97706',
  colorError: '#dc2626',
  colorBgBase: '#f4faf6',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBorder: 'rgba(15,80,40,0.16)',
  colorBorderSecondary: 'rgba(15,80,40,0.1)',
  colorText: '#14261b',
  colorTextSecondary: '#3d5a48',
  borderRadius: 8,
  fontFamily: '"Instrument Sans", "PingFang SC", "Hiragino Sans GB", sans-serif',
  controlHeight: 36
}

const darkTokens = {
  ...lightTokens,
  colorBgBase: '#0f1612',
  colorBgContainer: '#161e19',
  colorBgElevated: '#1c2620',
  colorBorder: 'rgba(160, 200, 170, 0.16)',
  colorBorderSecondary: 'rgba(160, 200, 170, 0.1)',
  colorText: '#e7f0ea',
  colorTextSecondary: '#a8bdb0'
}

export const AppearanceProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => readThemeMode())
  const [locale, setLocaleState] = useState<AppLocale>(() => readLocale())
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    resolveTheme('system')
  )

  const resolvedTheme: ResolvedTheme =
    themeMode === 'system' ? systemTheme : themeMode

  useEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      setSystemTheme(mq.matches ? 'dark' : 'light')
    }
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setThemeMode = useCallback((mode: ThemeMode) => {
    writeThemeMode(mode)
    setThemeModeState(mode)
  }, [])

  const setLocale = useCallback((next: AppLocale) => {
    writeLocale(next)
    setLocaleState(next)
  }, [])

  const t = useCallback((key: MessageKey) => translate(locale, key), [locale])

  const value = useMemo(
    () => ({
      themeMode,
      resolvedTheme,
      locale,
      setThemeMode,
      setLocale,
      t
    }),
    [themeMode, resolvedTheme, locale, setThemeMode, setLocale, t]
  )

  return (
    <AppearanceContext.Provider value={value}>
      <ConfigProvider
        locale={locale === 'en-US' ? enUS : zhCN}
        theme={{
          algorithm:
            resolvedTheme === 'dark'
              ? antTheme.darkAlgorithm
              : antTheme.defaultAlgorithm,
          token: resolvedTheme === 'dark' ? darkTokens : lightTokens,
          components: {
            Button: { primaryShadow: 'none' },
            Progress: { defaultColor: '#16a34a' },
            Switch: { colorPrimary: '#16a34a' },
            Tabs: { itemSelectedColor: '#16a34a', inkBarColor: '#16a34a' },
            Checkbox: { colorPrimary: '#16a34a' },
            Radio: { colorPrimary: '#16a34a' },
            Message: {
              contentBg: resolvedTheme === 'dark' ? '#1c2620' : '#ffffff'
            }
          }
        }}
      >
        {children}
      </ConfigProvider>
    </AppearanceContext.Provider>
  )
}

export const useAppearance = (): AppearanceContextValue => {
  const ctx = useContext(AppearanceContext)
  if (!ctx) {
    throw new Error('useAppearance must be used within AppearanceProvider')
  }
  return ctx
}
