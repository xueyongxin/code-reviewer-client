import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Checkbox,
  Collapse,
  Dropdown,
  Form,
  Input,
  Modal,
  Select,
  Switch,
  message
} from 'antd'
import {
  ApiOutlined,
  CloudServerOutlined,
  CodeOutlined,
  DownOutlined,
  EllipsisOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined
} from '@ant-design/icons'
import { randomUUID } from './id'
import { useAppStore } from '../store/useAppStore'
import { useAppearance } from '../prefs/AppearanceProvider'
import type { AppLocale, ThemeMode } from '../prefs/appearance'
import ModelManagePanel from './ModelManagePanel'
import type {
  AppConfig,
  McpMarketplaceItem,
  McpServerConfig
} from '../../../shared/types'
import {
  DEFAULT_MCP_JSON,
  buildMcpServersJson,
  parseMcpServersJson,
  titleFromMcpJson
} from '../../../shared/mcp-json'
import type { MessageKey } from '../i18n/messages'

const RULE_OPTIONS = [
  { value: 'no-console-log', label: '禁止 console.log' },
  { value: 'no-debugger', label: '禁止 debugger' },
  { value: 'no-hardcoded-secret', label: '疑似硬编码密钥' },
  { value: 'no-todo-fix', label: '遗留 TODO/FIXME' },
  { value: 'no-any-type', label: '避免 any 类型' },
  { value: 'no-var', label: '禁止 var' },
  { value: 'no-eval', label: '禁止 eval' },
  { value: 'file-too-long', label: '文件行数超限' },
  { value: 'no-empty-catch', label: '禁止空 catch' },
  { value: 'no-http-url', label: '避免明文 HTTP' },
  { value: 'no-force-push-hint', label: '危险 git 操作提示' },
  { value: 'max-line-length', label: '单行过长' }
]

export type SettingsSection = 'cloud' | 'general' | 'mcp' | 'llm' | 'rules'

const SECTIONS: Array<{
  key: SettingsSection
  labelKey: MessageKey
  icon: ReactNode
  /** 同组连续渲染；组间加分隔线 */
  group: number
}> = [
  { key: 'cloud', labelKey: 'settings.account', icon: <UserOutlined />, group: 1 },
  { key: 'general', labelKey: 'settings.general', icon: <SettingOutlined />, group: 1 },
  { key: 'mcp', labelKey: 'settings.mcp', icon: <CloudServerOutlined />, group: 2 },
  { key: 'llm', labelKey: 'settings.models', icon: <ApiOutlined />, group: 2 },
  { key: 'rules', labelKey: 'settings.rules', icon: <CodeOutlined />, group: 2 }
]

type ConfigPageProps = {
  open: boolean
  onClose: () => void
  initialSection?: SettingsSection
}

/**
 * Trae Work 式：随窗口比例缩放，四周留边；全屏时有最大宽高上限。
 * - 变小 → 约 72vw / 80vh 跟着缩
 * - 变大 → 跟着放大
 * - 全屏 → 封顶 1200×980，不会铺满
 */
const SETTINGS_MODAL_WIDTH = 'min(1200px, 72vw, calc(100vw - 48px))'
const SETTINGS_MODAL_HEIGHT = 'min(980px, 80vh, calc(100vh - 48px))'
const SETTINGS_MODAL_STYLES = {
  content: {
    height: SETTINGS_MODAL_HEIGHT,
    maxHeight: SETTINGS_MODAL_HEIGHT
  },
  body: {
    height: '100%',
    overflow: 'hidden' as const
  }
}

interface McpDraft {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command: string
  argsText: string
  url: string
  envText: string
  enabled: boolean
}

const emptyDraft = (): McpDraft => ({
  id: randomUUID(),
  name: '',
  transport: 'stdio',
  command: 'npx',
  argsText: '[]',
  url: '',
  envText: '{}',
  enabled: true
})

const serverToDraft = (server: McpServerConfig): McpDraft => ({
  id: server.id,
  name: server.name,
  transport: server.transport,
  command: server.command || '',
  argsText: JSON.stringify(server.args ?? [], null, 2),
  url: server.url || '',
  envText: JSON.stringify(server.env ?? {}, null, 2),
  enabled: server.enabled
})

const parseJsonArray = (text: string): string[] => {
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // fallthrough
  }
  return text.split(/\s+/).filter(Boolean)
}

const parseJsonObject = (text: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      )
    }
  } catch {
    // fallthrough
  }
  return {}
}

const draftToServer = (draft: McpDraft): McpServerConfig => ({
  id: draft.id || randomUUID(),
  name: draft.name.trim() || '未命名 MCP',
  transport: draft.transport,
  command: draft.command,
  args: parseJsonArray(draft.argsText),
  url: draft.url,
  env: parseJsonObject(draft.envText),
  enabled: draft.enabled
})

const buildMcpJsonPreview = (draft: McpDraft): string =>
  buildMcpServersJson(draftToServer(draft))

const ConfigPage = ({ open, onClose, initialSection = 'cloud' }: ConfigPageProps): JSX.Element => {
  const { t, themeMode, setThemeMode, locale, setLocale } = useAppearance()
  const config = useAppStore((s) => s.config)
  const mcpStatus = useAppStore((s) => s.mcpStatus)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const connectMcp = useAppStore((s) => s.connectMcp)
  const disconnectMcp = useAppStore((s) => s.disconnectMcp)
  const importCustomRules = useAppStore((s) => s.importCustomRules)
  const refreshMcpStatus = useAppStore((s) => s.refreshMcpStatus)

  const [section, setSection] = useState<SettingsSection>(initialSection)

  useEffect(() => {
    if (!open) return
    setSection(initialSection)
  }, [open, initialSection])
  const [mcpTab, setMcpTab] = useState('local')
  const [cloudBusy, setCloudBusy] = useState(false)
  const [cloudCatalog, setCloudCatalog] = useState<
    Array<{
      key: string
      name: string
      description?: string
      verified?: boolean
      tags?: string[]
    }>
  >([])
  const [saving, setSaving] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [marketOpen, setMarketOpen] = useState(false)
  const [marketQuery, setMarketQuery] = useState('')
  const [pendingMarketItem, setPendingMarketItem] = useState<McpMarketplaceItem | null>(null)
  const pendingMarketRef = useRef<McpMarketplaceItem | null>(null)
  const [draft, setDraft] = useState<McpDraft>(emptyDraft())
  const [mcpJson, setMcpJson] = useState(DEFAULT_MCP_JSON)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)

  const [rulesForm] = Form.useForm()

  useEffect(() => {
    if (!config) return
    rulesForm.setFieldsValue({
      enabledRuleIds: config.enabledRuleIds
    })
  }, [config, rulesForm])

  const hasCloudSession = Boolean(config?.cloud?.accessToken)

  useEffect(() => {
    if (!hasCloudSession) return
    void (async () => {
      try {
        const next = await window.electronAPI.cloudRefreshProfile()
        await saveConfig(next)
      } catch {
        // 离线时沿用本地缓存
      }
    })()
  }, [hasCloudSession, saveConfig])

  useEffect(() => {
    return window.electronAPI.onCloudAuthComplete((payload) => {
      void (async () => {
        if (payload.ok && payload.config) {
          await saveConfig(payload.config)
          message.success('授权登录成功')
        } else {
          message.error(payload.error || '授权登录失败')
        }
      })()
    })
  }, [])

  const mcpPresets = config?.mcpPresets ?? []
  const marketplace: McpMarketplaceItem[] = config?.mcpMarketplace?.length
    ? config.mcpMarketplace
    : (config?.mcpPresets ?? []).map((p) => ({
        ...p,
        description: p.name,
        tags: [p.key]
      }))

  const marketResults = useMemo(() => {
    const q = marketQuery.trim().toLowerCase()
    if (!q) return marketplace
    return marketplace.filter((item) => {
      const hay = [item.name, item.description, item.key, ...(item.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [marketplace, marketQuery])

  const installedNames = useMemo(
    () => new Set((config?.mcpServers ?? []).map((s) => s.name.toLowerCase())),
    [config?.mcpServers]
  )

  const statusMap = useMemo(
    () => Object.fromEntries(mcpStatus.map((item) => [item.serverId, item])),
    [mcpStatus]
  )

  if (!config) {
    return (
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        centered
        width={SETTINGS_MODAL_WIDTH}
        styles={SETTINGS_MODAL_STYLES}
        className="settings-dialog"
        rootClassName="settings-dialog-root"
      >
        <div className="settings-dialog-loading">{t('settings.loading')}</div>
      </Modal>
    )
  }

  const persist = async (next: AppConfig): Promise<void> => {
    setSaving(true)
    try {
      await saveConfig(next)
    } finally {
      setSaving(false)
    }
  }

  const openAddModal = (presetKey?: string): void => {
    const preset = presetKey
      ? mcpPresets.find((p) => p.key === presetKey) ||
        marketplace.find((p) => p.key === presetKey)
      : undefined
    setEditingId(null)
    if (preset) {
      const next: McpDraft = {
        id: randomUUID(),
        name: preset.name,
        transport: preset.transport,
        command: preset.command || '',
        argsText: JSON.stringify(preset.args ?? [], null, 2),
        url: preset.url || '',
        envText: JSON.stringify(preset.env || {}, null, 2),
        enabled: true
      }
      setDraft(next)
      setMcpJson(buildMcpJsonPreview(next))
    } else {
      const next = emptyDraft()
      setDraft(next)
      setMcpJson(DEFAULT_MCP_JSON)
    }
    setModalOpen(true)
  }

  const openFromMarket = (item: McpMarketplaceItem): void => {
    // 先关市场弹窗，等 afterClose 再开配置，避免双 Modal 遮罩抢点击
    pendingMarketRef.current = item
    setPendingMarketItem(item)
    setMarketQuery('')
    setMarketOpen(false)
  }

  const applyPendingMarketItem = (): void => {
    const item = pendingMarketRef.current
    if (!item) return
    pendingMarketRef.current = null
    setPendingMarketItem(null)
    setEditingId(null)
    const next: McpDraft = {
      id: randomUUID(),
      name: item.name,
      transport: item.transport,
      command: item.command || '',
      argsText: JSON.stringify(item.args ?? [], null, 2),
      url: item.url || '',
      envText: JSON.stringify(item.env || {}, null, 2),
      enabled: true
    }
    setDraft(next)
    setMcpJson(buildMcpJsonPreview(next))
    setModalOpen(true)
  }

  const openEditModal = (server: McpServerConfig): void => {
    setEditingId(server.id)
    const next = serverToDraft(server)
    setDraft(next)
    setMcpJson(buildMcpJsonPreview(next))
    setModalOpen(true)
  }

  const confirmMcpModal = async (): Promise<void> => {
    try {
      const server = parseMcpServersJson(mcpJson, {
        preferName: draft.name,
        keepId: editingId || draft.id,
        enabled: draft.enabled,
        createId: randomUUID
      })
      const list = [...(config.mcpServers || [])]
      const idx = list.findIndex((s) => s.id === server.id)
      if (idx >= 0) list[idx] = server
      else list.push(server)
      await persist({ ...config, mcpServers: list })
      setModalOpen(false)
      message.success(editingId ? '已更新 MCP' : '已添加 MCP')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '配置无效')
    }
  }

  const toggleMcp = async (server: McpServerConfig, on: boolean): Promise<void> => {
    setConnectingId(server.id)
    try {
      if (on) {
        await persist({
          ...config,
          mcpServers: (config.mcpServers || []).map((s) =>
            s.id === server.id ? { ...s, enabled: true } : s
          )
        })
        await connectMcp(server.id)
        message.success(`已连接并启用 ${server.name}`)
      } else {
        try {
          await disconnectMcp(server.id)
        } catch {
          // ignore
        }
        await persist({
          ...config,
          mcpServers: (config.mcpServers || []).map((s) =>
            s.id === server.id ? { ...s, enabled: false } : s
          )
        })
        message.success(`已断开 ${server.name}`)
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
      // 连接失败时回滚为未启用
      if (on) {
        await persist({
          ...config,
          mcpServers: (config.mcpServers || []).map((s) =>
            s.id === server.id ? { ...s, enabled: false } : s
          )
        })
      }
    } finally {
      setConnectingId(null)
      await refreshMcpStatus()
    }
  }

  const removeMcp = async (id: string): Promise<void> => {
    Modal.confirm({
      title: '删除该 MCP？',
      content: '删除后不可恢复',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await disconnectMcp(id)
        } catch {
          // ignore
        }
        await persist({
          ...config,
          mcpServers: (config.mcpServers || []).filter((s) => s.id !== id)
        })
        message.success('已删除')
      }
    })
  }

  const restartMcp = async (server: McpServerConfig): Promise<void> => {
    setConnectingId(server.id)
    try {
      try {
        await disconnectMcp(server.id)
      } catch {
        // ignore
      }
      await persist({
        ...config,
        mcpServers: (config.mcpServers || []).map((s) =>
          s.id === server.id ? { ...s, enabled: true } : s
        )
      })
      await connectMcp(server.id)
      message.success(`已重启 ${server.name}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重启失败')
    } finally {
      setConnectingId(null)
      await refreshMcpStatus()
    }
  }

  const mcpAvatarTone = (name: string): string => {
    const n = name.toLowerCase()
    if (n.includes('git')) return 'git'
    if (n.includes('mysql') || n.includes('sql') || n.includes('postgres')) return 'db'
    if (n.includes('github')) return 'github'
    if (n.includes('gitee')) return 'gitee'
    return 'default'
  }

  const saveRules = async (): Promise<void> => {
    const values = await rulesForm.validateFields()
    await persist({
      ...config,
      enabledRuleIds: values.enabledRuleIds ?? []
    })
    message.success('规则已保存')
  }

  const mcpModalTitle = titleFromMcpJson(
    mcpJson,
    editingId ? draft.name || '配置 MCP' : '添加 MCP'
  )
  const mcpJsonLineCount = Math.max(mcpJson.split('\n').length, 1)
  const cloudUser =
    config.cloud?.accessToken && config.cloud.user ? config.cloud.user : null
  const sectionTitle = t(
    SECTIONS.find((s) => s.key === section)?.labelKey ?? 'settings.account'
  )

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        centered
        width={SETTINGS_MODAL_WIDTH}
        styles={SETTINGS_MODAL_STYLES}
        className="settings-dialog"
        rootClassName="settings-dialog-root"
        maskClosable
      >
        <div className="settings-dialog-shell">
          <aside className="settings-dialog-nav">
            <div className="settings-dialog-profile">
              <div className="settings-dialog-avatar">
                {cloudUser?.avatarUrl ? (
                  <img src={cloudUser.avatarUrl} alt="" />
                ) : (
                  <span>
                    {(cloudUser?.displayName || '?').slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="settings-dialog-profile-meta">
                <div className="settings-dialog-profile-name">
                  <span className="settings-dialog-profile-name-text">
                    {cloudUser?.displayName || t('account.notLoggedIn')}
                  </span>
                  <span className="settings-dialog-badge">
                    {cloudUser?.isPlatformAdmin
                      ? t('account.superAdmin')
                      : t('menu.free')}
                  </span>
                </div>
                <div className="settings-dialog-profile-sub">
                  {cloudUser?.phone ||
                    cloudUser?.email ||
                    t('account.clickToLogin')}
                </div>
              </div>
            </div>

            <nav className="settings-dialog-nav-list" aria-label="设置分类">
              {SECTIONS.map((item, index) => {
                const prev = SECTIONS[index - 1]
                const showDivider = Boolean(prev && prev.group !== item.group)
                return (
                  <div key={item.key} className="settings-dialog-nav-block">
                    {showDivider ? <div className="settings-dialog-nav-divider" /> : null}
                    <button
                      type="button"
                      className={`settings-dialog-nav-item ${section === item.key ? 'active' : ''}`}
                      onClick={() => setSection(item.key)}
                    >
                      <span className="settings-dialog-nav-icon">{item.icon}</span>
                      {t(item.labelKey)}
                    </button>
                  </div>
                )
              })}
            </nav>
          </aside>

          <main className="settings-dialog-main">
        {section === 'cloud' && (
          <div className="settings-main-inner account-panel">
            <h1 className="settings-h1">{sectionTitle}</h1>

            {cloudUser ? (
              <>
                <section className="account-block">
                  <div className="account-block-label">{t('account.info')}</div>
                  <div className="account-block-card">
                    <div className="account-row">
                      <div className="account-row-main">
                        <div className="account-id">
                          {cloudUser.displayName}
                          {cloudUser.isPlatformAdmin ? (
                            <span className="settings-dialog-badge">
                              {t('account.superAdmin')}
                            </span>
                          ) : null}
                        </div>
                        <div className="account-phone">
                          {cloudUser.phone || cloudUser.email || t('account.noPhone')}
                        </div>
                        {config.cloud?.orgName ? (
                          <div className="account-org">
                            {t('account.org')} · {config.cloud.orgName}
                          </div>
                        ) : null}
                      </div>
                      <div className="account-row-actions">
                        <button
                          type="button"
                          className="account-btn"
                          disabled={cloudBusy}
                          onClick={() => {
                            void (async () => {
                              setCloudBusy(true)
                              try {
                                await window.electronAPI.cloudOpenAccountManage()
                                message.info(
                                  locale === 'en-US'
                                    ? 'Opened account settings in browser'
                                    : '已在浏览器打开账号设置'
                                )
                              } catch (e) {
                                message.error(
                                  e instanceof Error ? e.message : '无法打开账号设置'
                                )
                              } finally {
                                setCloudBusy(false)
                              }
                            })()
                          }}
                        >
                          {t('account.manage')}
                          <ExportOutlined />
                        </button>
                        <Dropdown
                          menu={{
                            items: [
                              {
                                key: 'refresh',
                                label: '刷新资料',
                                icon: <ReloadOutlined />,
                                disabled: cloudBusy,
                                onClick: () => {
                                  void (async () => {
                                    setCloudBusy(true)
                                    try {
                                      const next =
                                        await window.electronAPI.cloudRefreshProfile()
                                      await saveConfig(next)
                                      message.success('已刷新资料')
                                    } catch (e) {
                                      message.error(
                                        e instanceof Error ? e.message : '刷新失败'
                                      )
                                    } finally {
                                      setCloudBusy(false)
                                    }
                                  })()
                                }
                              },
                              {
                                key: 'org',
                                label: '刷新组织',
                                disabled: cloudBusy,
                                onClick: () => {
                                  void (async () => {
                                    setCloudBusy(true)
                                    try {
                                      const orgs =
                                        await window.electronAPI.cloudListOrgs()
                                      if (!orgs.length) {
                                        message.warning('没有组织')
                                        return
                                      }
                                      const pick = orgs[0]
                                      const next = await window.electronAPI.cloudSetOrg({
                                        orgId: pick.org.id,
                                        orgName: pick.org.name
                                      })
                                      await saveConfig(next)
                                      message.success(`当前组织：${pick.org.name}`)
                                    } catch (e) {
                                      message.error(
                                        e instanceof Error ? e.message : '失败'
                                      )
                                    } finally {
                                      setCloudBusy(false)
                                    }
                                  })()
                                }
                              },
                              {
                                key: 'pull',
                                label: '拉取云端配置',
                                disabled: cloudBusy,
                                onClick: () => {
                                  void (async () => {
                                    setCloudBusy(true)
                                    try {
                                      const result =
                                        await window.electronAPI.cloudPullConfig()
                                      await saveConfig(result.config)
                                      message.success(
                                        result.changed
                                          ? `已同步配置 v${result.version}`
                                          : '配置已是最新'
                                      )
                                    } catch (e) {
                                      message.error(
                                        e instanceof Error ? e.message : '同步失败'
                                      )
                                    } finally {
                                      setCloudBusy(false)
                                    }
                                  })()
                                }
                              },
                              {
                                key: 'upload',
                                label: '上传最近报告',
                                disabled: cloudBusy,
                                onClick: () => {
                                  void (async () => {
                                    setCloudBusy(true)
                                    try {
                                      const r =
                                        await window.electronAPI.cloudUploadReport()
                                      message.success(
                                        `报告已上传：${r.id.slice(0, 8)}…`
                                      )
                                    } catch (e) {
                                      message.error(
                                        e instanceof Error ? e.message : '上传失败'
                                      )
                                    } finally {
                                      setCloudBusy(false)
                                    }
                                  })()
                                }
                              }
                            ]
                          }}
                          trigger={['click']}
                        >
                          <button
                            type="button"
                            className="account-btn icon-only"
                            aria-label={t('account.more')}
                          >
                            <EllipsisOutlined />
                          </button>
                        </Dropdown>
                      </div>
                    </div>

                    <div className="account-divider" />

                    <div className="account-row">
                      <div className="account-row-main">
                        <div className="account-plan">{t('menu.free')}</div>
                        <div className="account-plan-desc">{t('account.upgradeDesc')}</div>
                      </div>
                      <button
                        type="button"
                        className="account-upgrade"
                        onClick={() =>
                          message.info(
                            locale === 'en-US' ? 'Upgrade coming soon' : '升级权益即将开放'
                          )
                        }
                      >
                        <ThunderboltOutlined />
                        {t('account.upgrade')}
                      </button>
                    </div>
                  </div>
                </section>

                <section className="account-block">
                  <div className="account-block-label">{t('account.usage')}</div>
                  <div className="account-block-card account-usage">
                    <div className="account-usage-left">
                      <ThunderboltOutlined className="account-usage-icon" />
                      <span>
                        {t('account.usageAvailable')} <strong>0</strong>{' '}
                        {t('account.usageTimes')}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="account-link-icon"
                      title={t('account.usage')}
                      onClick={() =>
                        message.info(
                          locale === 'en-US' ? 'Usage details coming soon' : '用量详情即将开放'
                        )
                      }
                    >
                      <ExportOutlined />
                    </button>
                  </div>
                </section>

                <section className="account-block">
                  <div className="account-block-card account-toggle-card">
                    <div className="account-toggle-copy">
                      <div className="account-toggle-title">{t('account.autoUpload')}</div>
                      <p className="account-toggle-desc">{t('account.autoUploadDesc')}</p>
                    </div>
                    <Switch
                      checked={Boolean(config.cloud?.autoUploadReports)}
                      onChange={(checked) => {
                        void saveConfig({
                          ...config,
                          cloud: { ...config.cloud!, autoUploadReports: checked }
                        })
                      }}
                    />
                  </div>
                </section>

                <button
                  type="button"
                  className="account-logout"
                  disabled={cloudBusy}
                  onClick={() => {
                    void (async () => {
                      setCloudBusy(true)
                      try {
                        const next = await window.electronAPI.cloudLogout()
                        await saveConfig(next)
                        message.success(
                          locale === 'en-US' ? 'Signed out' : '已退出登录'
                        )
                      } catch (e) {
                        message.error(e instanceof Error ? e.message : '退出失败')
                      } finally {
                        setCloudBusy(false)
                      }
                    })()
                  }}
                >
                  {t('account.logout')}
                </button>
              </>
            ) : (
              <>
                <section className="account-block">
                  <div className="account-block-label">{t('account.info')}</div>
                  <div className="account-block-card account-guest">
                    <div className="account-guest-title">{t('account.notLoggedIn')}</div>
                    <p className="account-guest-desc">{t('account.guestHint')}</p>
                  </div>
                </section>
              </>
            )}
          </div>
        )}

        {section === 'general' && (
          <div className="settings-main-inner general-panel">
            <h1 className="settings-h1">{t('general.title')}</h1>

            <section className="account-block">
              <div className="account-block-label">{t('general.basic')}</div>
              <div className="account-block-card general-card">
                <div className="general-row">
                  <div className="general-row-copy">
                    <div className="general-row-title">{t('general.theme')}</div>
                    <div className="general-row-desc">{t('general.themeDesc')}</div>
                  </div>
                  <Select
                    className="general-select"
                    value={themeMode}
                    options={[
                      { value: 'dark', label: t('general.themeDark') },
                      { value: 'light', label: t('general.themeLight') },
                      { value: 'system', label: t('general.themeSystem') }
                    ]}
                    popupMatchSelectWidth={180}
                    onChange={(v) => setThemeMode(v as ThemeMode)}
                  />
                </div>
                <div className="account-divider" />
                <div className="general-row">
                  <div className="general-row-copy">
                    <div className="general-row-title">{t('general.language')}</div>
                    <div className="general-row-desc">{t('general.languageDesc')}</div>
                  </div>
                  <Select
                    className="general-select"
                    value={locale}
                    options={[
                      { value: 'zh-CN', label: t('general.langZh') },
                      { value: 'en-US', label: t('general.langEn') }
                    ]}
                    popupMatchSelectWidth={180}
                    onChange={(v) => setLocale(v as AppLocale)}
                  />
                </div>
              </div>
            </section>

            <section className="account-block">
              <div className="account-block-label">{t('general.prefs')}</div>
              <div className="account-block-card general-card">
                <div className="general-row">
                  <div className="general-row-copy">
                    <div className="general-row-title">{t('general.notify')}</div>
                    <div className="general-row-desc">{t('general.notifyDesc')}</div>
                  </div>
                  <Switch
                    checked={Boolean(config.notifyOnComplete)}
                    onChange={(checked) => {
                      void saveConfig({ ...config, notifyOnComplete: checked })
                    }}
                  />
                </div>
                <div className="account-divider" />
                <div className="general-row">
                  <div className="general-row-copy">
                    <div className="general-row-title">{t('general.gitClone')}</div>
                    <div className="general-row-desc">{t('general.gitCloneDesc')}</div>
                  </div>
                  <Switch
                    checked={Boolean(config.enableGitClone)}
                    onChange={(checked) => {
                      void saveConfig({ ...config, enableGitClone: checked })
                    }}
                  />
                </div>
                <div className="account-divider" />
                <div className="general-row">
                  <div className="general-row-copy">
                    <div className="general-row-title">启用 LLM 审查</div>
                    <div className="general-row-desc">关闭后仅使用静态规则审查</div>
                  </div>
                  <Switch
                    checked={Boolean(config.enableLlm)}
                    onChange={(checked) => {
                      void saveConfig({ ...config, enableLlm: checked })
                    }}
                  />
                </div>
              </div>
            </section>
          </div>
        )}

        {section === 'mcp' && (
          <div className="settings-main-inner mcp-page">
            <h1 className="settings-h1">MCP</h1>

            <div className="mcp-segment" role="tablist" aria-label="MCP 范围">
              <button
                type="button"
                role="tab"
                aria-selected={mcpTab === 'local'}
                className={`mcp-segment-item ${mcpTab === 'local' ? 'active' : ''}`}
                onClick={() => setMcpTab('local')}
              >
                本地
                <InfoCircleOutlined className="mcp-segment-info" />
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mcpTab === 'cloud'}
                className={`mcp-segment-item ${mcpTab === 'cloud' ? 'active' : ''}`}
                onClick={() => setMcpTab('cloud')}
              >
                云端
              </button>
            </div>

            {mcpTab === 'cloud' ? (
              <div className="mcp-manage">
                <div className="mcp-manage-head">
                  <div className="mcp-manage-intro">
                    <div className="mcp-manage-title">云端 MCP 目录</div>
                    <p className="mcp-manage-desc">
                      从服务端拉取目录，添加到本地后自行填写 Token。
                    </p>
                  </div>
                  <div className="mcp-manage-actions">
                    <button
                      type="button"
                      className="mcp-icon-btn"
                      title="刷新目录"
                      disabled={cloudBusy}
                      onClick={() => {
                        void (async () => {
                          setCloudBusy(true)
                          try {
                            const list = await window.electronAPI.cloudMcpCatalog()
                            setCloudCatalog(list)
                            message.success(`已加载 ${list.length} 项`)
                          } catch (e) {
                            message.error(e instanceof Error ? e.message : '加载失败')
                          } finally {
                            setCloudBusy(false)
                          }
                        })()
                      }}
                    >
                      <ReloadOutlined spin={cloudBusy} />
                    </button>
                  </div>
                </div>

                {!cloudCatalog.length ? (
                  <div className="mcp-empty">点击刷新从云端加载目录</div>
                ) : (
                  <div className="mcp-server-list">
                    {cloudCatalog.map((item) => (
                      <div key={item.key} className="mcp-server-card">
                        <div className="mcp-server-row">
                          <div
                            className={`mcp-server-avatar tone-${mcpAvatarTone(item.name)}`}
                            aria-hidden
                          >
                            {(item.name || '?').slice(0, 1).toUpperCase()}
                          </div>
                          <div className="mcp-server-main">
                            <div className="mcp-server-title-line">
                              <span className="mcp-server-name">{item.name}</span>
                              {item.verified ? (
                                <span className="mcp-server-ok" title="官方">
                                  ✓
                                </span>
                              ) : null}
                            </div>
                            <div className="mcp-server-desc">
                              {item.description || '无描述'}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="mcp-add-inline"
                            onClick={() => {
                              void (async () => {
                                try {
                                  const next = await window.electronAPI.cloudAddMcp(item.key)
                                  await saveConfig(next)
                                  message.success(`已添加 ${item.name}，请填写 Token 后连接`)
                                  setMcpTab('local')
                                } catch (e) {
                                  message.error(e instanceof Error ? e.message : '添加失败')
                                }
                              })()
                            }}
                          >
                            添加到本地
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="mcp-manage">
                <div className="mcp-manage-head">
                  <div className="mcp-manage-intro">
                    <div className="mcp-manage-title">MCP Servers 管理</div>
                    <p className="mcp-manage-desc">
                      管理您已添加的 MCP 服务器，可启用、配置或添加新的工具能力。
                    </p>
                  </div>
                  <div className="mcp-manage-actions">
                    <button
                      type="button"
                      className="mcp-icon-btn"
                      title="刷新状态"
                      onClick={() => void refreshMcpStatus()}
                    >
                      <ReloadOutlined />
                    </button>
                    <Dropdown
                      menu={{
                        items: [
                          {
                            key: 'market',
                            label: '从市场添加',
                            onClick: () => {
                              setMarketQuery('')
                              setMarketOpen(true)
                            }
                          },
                          {
                            key: 'manual',
                            label: '手动配置',
                            onClick: () => openAddModal()
                          }
                        ]
                      }}
                    >
                      <button type="button" className="mcp-add-btn">
                        <PlusOutlined />
                        添加
                        <DownOutlined className="mcp-add-caret" />
                      </button>
                    </Dropdown>
                  </div>
                </div>

                {(config.mcpServers || []).length === 0 ? (
                  <div className="mcp-empty">还没有 MCP。点击右上角「添加」开始配置。</div>
                ) : (
                  <Collapse
                    bordered={false}
                    className="mcp-collapse"
                    expandIconPosition="end"
                    items={(config.mcpServers || []).map((server) => {
                      const status = statusMap[server.id]
                      const live = Boolean(status?.connected)
                      const failed = Boolean(status?.error) && !live
                      const tools = status?.tools ?? []
                      const enabled = server.enabled !== false
                      return {
                        key: server.id,
                        label: (
                          <div className="mcp-server-row">
                            <div
                              className={`mcp-server-avatar tone-${mcpAvatarTone(server.name)}`}
                              aria-hidden
                            >
                              {(server.name || '?').slice(0, 1).toUpperCase()}
                            </div>
                            <div className="mcp-server-main">
                              <div className="mcp-server-title-line">
                                <span className="mcp-server-name">{server.name}</span>
                                {live ? (
                                  <span className="mcp-server-ok" title="已连接">
                                    ✓
                                  </span>
                                ) : null}
                                {failed ? (
                                  <span className="mcp-server-fail">
                                    ⚠️ 启动失败
                                    <button
                                      type="button"
                                      className="mcp-retry-link"
                                      onClick={(e) => {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        void restartMcp(server)
                                      }}
                                    >
                                      重试
                                    </button>
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div
                              className="mcp-server-ops"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <Dropdown
                                trigger={['click']}
                                menu={{
                                  items: [
                                    {
                                      key: 'edit',
                                      label: '编辑',
                                      onClick: () => openEditModal(server)
                                    },
                                    {
                                      key: 'restart',
                                      label: '重启',
                                      onClick: () => void restartMcp(server)
                                    },
                                    {
                                      key: 'delete',
                                      label: '删除',
                                      danger: true,
                                      onClick: () => void removeMcp(server.id)
                                    }
                                  ]
                                }}
                              >
                                <button
                                  type="button"
                                  className="mcp-gear-btn"
                                  title="更多操作"
                                >
                                  <SettingOutlined />
                                </button>
                              </Dropdown>
                              <Switch
                                size="small"
                                checked={enabled && live}
                                loading={connectingId === server.id}
                                title={
                                  live
                                    ? '已连接并启用，关闭将断开'
                                    : '打开以连接并启用'
                                }
                                onClick={(_, e) => e.stopPropagation()}
                                onChange={(checked) => void toggleMcp(server, checked)}
                              />
                            </div>
                          </div>
                        ),
                        children: (
                          <div className="mcp-server-body">
                            {live && tools.length > 0 ? (
                              <div className="mcp-tools">
                                {tools.map((tool) => (
                                  <div key={tool.name} className="mcp-tool-row">
                                    <div className="mcp-tool-name mono">{tool.name}</div>
                                    <div className="mcp-tool-desc">
                                      {tool.description || '—'}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <>
                                <div className="mono mcp-meta">
                                  {server.transport === 'sse'
                                    ? `sse · ${server.url || '—'}`
                                    : `stdio · ${server.command} ${(server.args || []).join(' ')}`}
                                </div>
                                {status?.error ? (
                                  <div className="mcp-error">{status.error}</div>
                                ) : (
                                  <div className="mcp-tools-empty">
                                    {live ? '暂无工具列表' : '连接后可查看可用工具'}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )
                      }
                    })}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {section === 'llm' && (
          <div className="settings-main-inner model-page">
            <ModelManagePanel config={config} saving={saving} onPersist={persist} />
          </div>
        )}

        {section === 'rules' && (
          <div className="settings-main-inner">
            <div className="settings-main-head">
              <h1 className="settings-h1">规则</h1>
              <div className="actions">
                <Button
                  onClick={() => {
                    void (async () => {
                      try {
                        const count = await importCustomRules()
                        message.success(`已导入 ${count} 条`)
                        const latest = useAppStore.getState().config
                        if (latest) {
                          rulesForm.setFieldsValue({ enabledRuleIds: latest.enabledRuleIds })
                        }
                      } catch (error) {
                        if (error instanceof Error && error.message.includes('取消')) return
                        message.error(error instanceof Error ? error.message : '导入失败')
                      }
                    })()
                  }}
                >
                  导入 YAML/JSON
                </Button>
                <Button type="primary" loading={saving} onClick={() => void saveRules()}>
                  保存
                </Button>
              </div>
            </div>
            <Form form={rulesForm} layout="vertical" className="settings-card">
              <Form.Item name="enabledRuleIds" style={{ margin: 0 }}>
                <Checkbox.Group options={RULE_OPTIONS} className="rule-grid" />
              </Form.Item>
            </Form>
          </div>
        )}
          </main>
        </div>
      </Modal>

      <Modal
        open={marketOpen}
        title="MCP Marketplace"
        onCancel={() => {
          setMarketOpen(false)
          setMarketQuery('')
          pendingMarketRef.current = null
          setPendingMarketItem(null)
        }}
        afterClose={() => {
          applyPendingMarketItem()
        }}
        footer={null}
        width={720}
        destroyOnClose
        maskClosable
        className="mcp-market-modal"
      >
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索 MCP…"
          value={marketQuery}
          onChange={(e) => setMarketQuery(e.target.value)}
          style={{ marginBottom: 10 }}
        />
        <div className="mcp-market-meta">
          找到 {marketResults.length} 个相关结果，若未找到 MCP，也可{' '}
          <button
            type="button"
            className="mcp-market-link"
            onClick={() => {
              setPendingMarketItem(null)
              setMarketOpen(false)
              window.setTimeout(() => openAddModal(), 200)
            }}
          >
            手动配置
          </button>
        </div>
        <div className="mcp-market-list">
          {marketResults.length === 0 ? (
            <div className="mcp-market-empty">没有匹配结果</div>
          ) : (
            marketResults.map((item) => {
              const installed = installedNames.has(item.name.toLowerCase())
              const existing = (config.mcpServers || []).find(
                (s) => s.name.toLowerCase() === item.name.toLowerCase()
              )
              return (
                <div key={item.key} className="mcp-market-item">
                  <div className="mcp-market-avatar">
                    {(item.badge || item.name).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="mcp-market-body">
                    <div className="mcp-market-name">
                      {item.name}
                      {item.verified ? <span className="mcp-market-verified">✓</span> : null}
                      {item.tags?.includes('local') ? (
                        <span className="mcp-market-tag">Local</span>
                      ) : null}
                    </div>
                    <div className="mcp-market-desc">
                      {item.description || `${item.transport} · ${item.command || item.url || ''}`}
                    </div>
                  </div>
                  {installed && existing ? (
                    <button
                      type="button"
                      className="mcp-market-action"
                      title="配置"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setPendingMarketItem(null)
                        setMarketOpen(false)
                        window.setTimeout(() => openEditModal(existing), 200)
                      }}
                    >
                      <SettingOutlined />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="mcp-market-action primary"
                      title="添加"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        openFromMarket(item)
                      }}
                    >
                      <PlusOutlined />
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>
      </Modal>

      <Modal
        open={modalOpen}
        title={
          <div className="mcp-modal-title">
            <span>{mcpModalTitle}</span>
          </div>
        }
        onCancel={() => setModalOpen(false)}
        centered
        zIndex={1200}
        getContainer={() => document.body}
        width={560}
        destroyOnClose
        className="mcp-json-modal"
        rootClassName="mcp-json-modal-root"
        footer={
          <div className="mcp-modal-footer">
            <span className="mcp-modal-warn">
              <ExclamationCircleOutlined />
              配置前请确认来源，甄别风险
            </span>
            <div className="actions">
              <Button onClick={() => setModalOpen(false)}>取消</Button>
              <Button
                type="primary"
                className="mcp-confirm-btn"
                loading={saving}
                onClick={() => void confirmMcpModal()}
              >
                确认
              </Button>
            </div>
          </div>
        }
      >
        <div className="mcp-modal-body">
          <p className="mcp-json-hint">
            请复制 MCP Servers 介绍页中的 JSON 配置（优先使用 NPX 或 UVX
            配置）并粘贴到输入框中。
          </p>
          <div className="mcp-json-editor">
            <div className="mcp-json-gutter" aria-hidden>
              {Array.from({ length: mcpJsonLineCount }, (_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            <textarea
              className="mcp-json-textarea mono"
              value={mcpJson}
              spellCheck={false}
              onChange={(e) => setMcpJson(e.target.value)}
              placeholder={DEFAULT_MCP_JSON}
            />
          </div>
        </div>
      </Modal>
    </>
  )
}

export default ConfigPage
