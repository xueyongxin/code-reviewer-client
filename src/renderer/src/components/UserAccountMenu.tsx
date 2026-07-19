import { useEffect, useRef, useState } from 'react'
import { Dropdown, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  GlobalOutlined,
  RightOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined,
  BgColorsOutlined,
  BellOutlined,
  BugOutlined,
  MobileOutlined,
  DownOutlined,
  CheckOutlined
} from '@ant-design/icons'
import { useAppStore } from '../store/useAppStore'
import { useAppearance } from '../prefs/AppearanceProvider'
import type { AppLocale, ThemeMode } from '../prefs/appearance'
import type { SettingsSection } from '../pages/ConfigPage'

type Props = {
  displayName: string
  phone?: string | null
  email?: string | null
  avatarUrl?: string | null
  onOpenSettings: (section?: SettingsSection) => void
  initials: string
}

const UserAccountMenu = ({
  displayName,
  phone,
  email,
  avatarUrl,
  onOpenSettings,
  initials
}: Props): JSX.Element => {
  const saveConfig = useAppStore((s) => s.saveConfig)
  const { t, themeMode, locale, setThemeMode, setLocale } = useAppearance()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      // 下拉挂到 body，点选项时不要关掉账号菜单
      if (
        target instanceof Element &&
        target.closest('.user-menu-quick-dropdown')
      ) {
        return
      }
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open || !rootRef.current) return
    const syncPos = (): void => {
      const trigger = rootRef.current?.querySelector('.app-sider-user')
      if (!(trigger instanceof HTMLElement) || !rootRef.current) return
      const rect = trigger.getBoundingClientRect()
      rootRef.current.style.setProperty('--user-menu-left', `${Math.max(8, rect.left)}px`)
      rootRef.current.style.setProperty(
        '--user-menu-bottom',
        `${Math.max(8, window.innerHeight - rect.top + 8)}px`
      )
    }
    syncPos()
    window.addEventListener('resize', syncPos)
    return () => window.removeEventListener('resize', syncPos)
  }, [open])

  const close = (): void => setOpen(false)

  const soon = (label: string): void => {
    message.info(
      locale === 'en-US' ? `${label} coming soon` : `${label}即将开放`
    )
    close()
  }

  const themeLabel =
    themeMode === 'dark'
      ? t('general.themeDark')
      : themeMode === 'system'
        ? t('general.themeSystem')
        : t('general.themeLight')

  const localeLabel = locale === 'en-US' ? t('general.langEn') : t('general.langZh')

  const localeMenu: MenuProps = {
    selectable: true,
    selectedKeys: [locale],
    className: 'user-menu-quick-dropdown',
    items: [
      {
        key: 'zh-CN',
        label: (
          <span className="user-menu-option">
            {t('general.langZh')}
            {locale === 'zh-CN' ? <CheckOutlined /> : null}
          </span>
        )
      },
      {
        key: 'en-US',
        label: (
          <span className="user-menu-option">
            {t('general.langEn')}
            {locale === 'en-US' ? <CheckOutlined /> : null}
          </span>
        )
      }
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation()
      setLocale(key as AppLocale)
    }
  }

  const themeMenu: MenuProps = {
    selectable: true,
    selectedKeys: [themeMode],
    className: 'user-menu-quick-dropdown',
    items: [
      {
        key: 'light',
        label: (
          <span className="user-menu-option">
            {t('general.themeLight')}
            {themeMode === 'light' ? <CheckOutlined /> : null}
          </span>
        )
      },
      {
        key: 'dark',
        label: (
          <span className="user-menu-option">
            {t('general.themeDark')}
            {themeMode === 'dark' ? <CheckOutlined /> : null}
          </span>
        )
      },
      {
        key: 'system',
        label: (
          <span className="user-menu-option">
            {t('general.themeSystem')}
            {themeMode === 'system' ? <CheckOutlined /> : null}
          </span>
        )
      }
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation()
      setThemeMode(key as ThemeMode)
    }
  }

  return (
    <div className={`user-menu ${open ? 'open' : ''}`} ref={rootRef}>
      {open && (
        <div className="user-menu-popover" role="menu">
          <div className="user-menu-head">
            <div className="user-menu-head-main">
              <span className="user-menu-avatar">
                {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{initials}</span>}
              </span>
              <div className="user-menu-head-meta">
                <div className="user-menu-head-name">
                  <span className="user-menu-name-text">{displayName}</span>
                  <span className="user-menu-badge">{t('menu.free')}</span>
                </div>
                <div className="user-menu-head-sub">
                  {phone || email || t('menu.loggedIn')}
                </div>
              </div>
            </div>
            <div className="user-menu-credit" title="权益额度">
              <ThunderboltOutlined />
              <span>0</span>
            </div>
          </div>

          <button
            type="button"
            className="user-menu-upgrade"
            onClick={() => soon(t('menu.upgrade'))}
          >
            <ThunderboltOutlined />
            {t('menu.upgrade')}
          </button>

          <div className="user-menu-list">
            <button
              type="button"
              className="user-menu-item"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true)
                  try {
                    await window.electronAPI.cloudOpenAccountManage()
                    message.info(
                      locale === 'en-US'
                        ? 'Opened account settings in browser'
                        : '已在浏览器打开账号设置'
                    )
                    close()
                  } catch (e) {
                    message.error(
                      e instanceof Error ? e.message : '无法打开账号设置'
                    )
                  } finally {
                    setBusy(false)
                  }
                })()
              }}
            >
              <span className="user-menu-item-left">
                <UserOutlined />
                {t('menu.manageAccount')}
              </span>
              <RightOutlined className="user-menu-chevron" />
            </button>
            <button
              type="button"
              className="user-menu-item"
              onClick={() => soon(t('menu.messages'))}
            >
              <span className="user-menu-item-left">
                <BellOutlined />
                {t('menu.messages')}
              </span>
            </button>
          </div>

          <div className="user-menu-divider" />

          <div className="user-menu-list">
            <div className="user-menu-item user-menu-item-static">
              <span className="user-menu-item-left">
                <GlobalOutlined />
                {t('menu.language')}
              </span>
              <Dropdown
                menu={localeMenu}
                trigger={['click']}
                placement="bottomRight"
                overlayClassName="user-menu-quick-dropdown"
              >
                <button
                  type="button"
                  className="user-menu-select-trigger"
                  onClick={(e) => e.stopPropagation()}
                >
                  {localeLabel}
                  <DownOutlined />
                </button>
              </Dropdown>
            </div>
            <div className="user-menu-item user-menu-item-static">
              <span className="user-menu-item-left">
                <BgColorsOutlined />
                {t('menu.theme')}
              </span>
              <Dropdown
                menu={themeMenu}
                trigger={['click']}
                placement="bottomRight"
                overlayClassName="user-menu-quick-dropdown"
              >
                <button
                  type="button"
                  className="user-menu-select-trigger"
                  onClick={(e) => e.stopPropagation()}
                >
                  {themeLabel}
                  <DownOutlined />
                </button>
              </Dropdown>
            </div>
            <button
              type="button"
              className="user-menu-item"
              onClick={() => {
                close()
                onOpenSettings('cloud')
              }}
            >
              <span className="user-menu-item-left">
                <SettingOutlined />
                {t('menu.settings')}
              </span>
            </button>
            <button
              type="button"
              className="user-menu-item"
              onClick={() => soon(t('menu.reportIssue'))}
            >
              <span className="user-menu-item-left">
                <BugOutlined />
                {t('menu.reportIssue')}
              </span>
            </button>
          </div>

          <button
            type="button"
            className="user-menu-logout"
            disabled={busy}
            onClick={() => {
              void (async () => {
                setBusy(true)
                try {
                  const next = await window.electronAPI.cloudLogout()
                  await saveConfig(next)
                  message.success(locale === 'en-US' ? 'Signed out' : '已退出登录')
                  close()
                } catch (e) {
                  message.error(e instanceof Error ? e.message : '退出失败')
                } finally {
                  setBusy(false)
                }
              })()
            }}
          >
            {t('menu.logout')}
          </button>
        </div>
      )}

      <button
        type="button"
        className={`app-sider-user ${open ? 'active' : ''}`}
        title="账号菜单"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="app-sider-user-avatar">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{initials}</span>}
        </span>
        <span className="app-sider-user-meta">
          <span className="app-sider-user-name-row">
            <span className="app-sider-user-name">{displayName}</span>
            <span className="user-menu-badge compact">{t('menu.free')}</span>
          </span>
          <span className="app-sider-user-sub">{phone || email || t('menu.loggedIn')}</span>
        </span>
        <MobileOutlined className="app-sider-user-trailing" />
      </button>
    </div>
  )
}

export default UserAccountMenu
