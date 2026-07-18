export type ThemeMode = 'light' | 'dark' | 'system'
export type AppLocale = 'zh-CN' | 'en-US'
export type ResolvedTheme = 'light' | 'dark'

const THEME_KEY = 'cr.themeMode'
const LOCALE_KEY = 'cr.locale'

export const readThemeMode = (): ThemeMode => {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // ignore
  }
  return 'light'
}

export const writeThemeMode = (mode: ThemeMode): void => {
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    // ignore
  }
}

export const readLocale = (): AppLocale => {
  try {
    const raw = localStorage.getItem(LOCALE_KEY)
    if (raw === 'zh-CN' || raw === 'en-US') return raw
  } catch {
    // ignore
  }
  return 'zh-CN'
}

export const writeLocale = (locale: AppLocale): void => {
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // ignore
  }
}

export const getSystemTheme = (): ResolvedTheme => {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const resolveTheme = (mode: ThemeMode): ResolvedTheme =>
  mode === 'system' ? getSystemTheme() : mode

export const applyResolvedTheme = (theme: ResolvedTheme): void => {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}
