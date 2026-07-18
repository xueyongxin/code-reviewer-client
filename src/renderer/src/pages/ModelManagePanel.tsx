import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Form, Input, Modal, Select, Switch, Tabs, message } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RightOutlined
} from '@ant-design/icons'
import { randomUUID } from './id'
import type {
  AppConfig,
  LlmProtocol,
  LlmProviderConfig,
  LlmProviderPreset
} from '../../../shared/types'

const PROTOCOL_OPTIONS: { value: LlmProtocol; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'ollama', label: 'Ollama' }
]

interface ModelDraft {
  id: string
  name: string
  protocol: LlmProtocol
  baseUrl: string
  apiKey: string
  model: string
  displayName: string
  enabled: boolean
  fallbackModels: string[]
  apiKeyUrl?: string
  models: string[]
}

const blankDraft = (): ModelDraft => ({
  id: randomUUID(),
  name: '',
  protocol: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  model: '',
  displayName: '',
  enabled: true,
  fallbackModels: [],
  models: []
})

/** 备用模型不含当前主模型 */
const normalizeFallbacks = (list: string[] | undefined, primary: string): string[] => {
  const main = primary.trim()
  return Array.from(
    new Set((list ?? []).map((s) => s.trim()).filter((s) => s && s !== main))
  )
}

const fromProvider = (
  p: LlmProviderConfig,
  presets: LlmProviderPreset[]
): ModelDraft => {
  const preset = presets.find((x) => x.name === p.name || x.baseUrl === p.baseUrl)
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    displayName: p.displayName || p.model,
    enabled: p.enabled,
    fallbackModels: normalizeFallbacks(p.fallbackModels, p.model),
    apiKeyUrl: preset?.apiKeyUrl,
    models: preset?.models?.length
      ? preset.models
      : [p.model].filter(Boolean)
  }
}

const fromPreset = (preset: LlmProviderPreset): ModelDraft => ({
  id: randomUUID(),
  name: preset.name,
  protocol: preset.protocol,
  baseUrl: preset.baseUrl,
  apiKey: '',
  model: preset.model,
  displayName: preset.model,
  enabled: true,
  fallbackModels: normalizeFallbacks(preset.fallbackModels, preset.model),
  apiKeyUrl: preset.apiKeyUrl,
  models: preset.models?.length ? preset.models : [preset.model].filter(Boolean)
})

const toProvider = (d: ModelDraft): LlmProviderConfig => ({
  id: d.id,
  name: d.name.trim(),
  protocol: d.protocol,
  baseUrl: d.baseUrl.trim(),
  apiKey: d.apiKey,
  model: d.model.trim(),
  displayName: d.displayName.trim() || d.model.trim(),
  enabled: d.enabled,
  fallbackModels: normalizeFallbacks(d.fallbackModels, d.model)
})

/** 按模型名匹配品牌色块图标（对齐 Trae 行首 logo 观感） */
const modelBrandIcon = (name: string): { letter: string; tone: string } => {
  const n = name.toLowerCase()
  if (n.includes('doubao') || n.includes('seed')) return { letter: '豆', tone: 'doubao' }
  if (n.includes('minimax')) return { letter: 'M', tone: 'minimax' }
  if (n.includes('glm') || n.includes('zhipu')) return { letter: '智', tone: 'glm' }
  if (n.includes('deepseek')) return { letter: 'D', tone: 'deepseek' }
  if (n.includes('kimi') || n.includes('moonshot')) return { letter: 'K', tone: 'kimi' }
  if (n.includes('qwen') || n.includes('通义')) return { letter: 'Q', tone: 'qwen' }
  if (n.includes('gpt') || n.includes('openai')) return { letter: 'O', tone: 'openai' }
  if (n.includes('claude') || n.includes('anthropic')) return { letter: 'A', tone: 'claude' }
  if (n.includes('gemini') || n.includes('google')) return { letter: 'G', tone: 'gemini' }
  return { letter: (name || '?').slice(0, 1).toUpperCase(), tone: 'default' }
}

interface Props {
  config: AppConfig
  saving: boolean
  onPersist: (next: AppConfig) => Promise<void>
}

const ModelManagePanel = ({ config, saving, onPersist }: Props): JSX.Element => {
  const providers = config.llmProviders ?? []
  const [presets, setPresets] = useState<LlmProviderPreset[]>(
    () => config.llmProviderPresets ?? []
  )
  const [catalogLoading, setCatalogLoading] = useState(false)

  const [pickOpen, setPickOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editTab, setEditTab] = useState<'provider' | 'custom'>('provider')
  const [draft, setDraft] = useState<ModelDraft>(blankDraft())
  const [isNew, setIsNew] = useState(true)
  const [builtinOpen, setBuiltinOpen] = useState(true)
  const [customOpen, setCustomOpen] = useState(true)
  const [form] = Form.useForm()

  const activeId = config.activeLlmProviderId

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setCatalogLoading(true)
      try {
        // 主进程已按服务端整表覆盖本地缓存；此处用 getConfig 避免用陈旧 React state 回写造成数据异常
        const list = await window.electronAPI.cloudLlmCatalog()
        if (cancelled) return
        setPresets(list)
        const latest = await window.electronAPI.getConfig()
        if (cancelled) return
        if (
          JSON.stringify(latest.llmProviderPresets ?? []) !==
          JSON.stringify(config.llmProviderPresets ?? [])
        ) {
          await onPersist(latest)
        }
      } catch {
        if (!cancelled) {
          const latest = await window.electronAPI.getConfig().catch(() => null)
          setPresets(latest?.llmProviderPresets ?? config.llmProviderPresets ?? [])
        }
      } finally {
        if (!cancelled) setCatalogLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // 每次进入模型页拉取一次服务端目录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const modelOptions = useMemo(() => {
    const list = draft.models.length ? draft.models : [draft.model].filter(Boolean)
    return Array.from(new Set(list)).map((m) => ({ value: m, label: m }))
  }, [draft.models, draft.model])

  /** 与配置中心目录 1:1：每条目录 = 一行内置模型（不再展开 models 列表） */
  const builtinRows = useMemo(() => {
    return presets
      .map((preset) => ({
        key: preset.key || preset.name,
        model: preset.model || preset.name,
        vendor: preset.name || 'Reviewer'
      }))
      .filter((r) => Boolean(r.model))
  }, [presets])

  const openPick = (): void => {
    setPickOpen(true)
  }

  const openEditFromPreset = (preset: LlmProviderPreset): void => {
    const next = fromPreset(preset)
    setDraft(next)
    setIsNew(true)
    setEditTab('provider')
    form.setFieldsValue(next)
    setPickOpen(false)
    setEditOpen(true)
  }

  const openCustom = (): void => {
    const next = blankDraft()
    setDraft(next)
    setIsNew(true)
    setEditTab('custom')
    form.setFieldsValue(next)
    setPickOpen(false)
    setEditOpen(true)
  }

  const openEditExisting = (p: LlmProviderConfig): void => {
    const next = fromProvider(p, presets)
    setDraft(next)
    setIsNew(false)
    setEditTab('provider')
    form.setFieldsValue(next)
    setEditOpen(true)
  }

  const persistProviders = async (list: LlmProviderConfig[]): Promise<void> => {
    const active =
      list.find((p) => p.id === activeId && p.enabled) ||
      list.find((p) => p.enabled) ||
      list[0]
    await onPersist({
      ...config,
      llmProviders: list,
      activeLlmProviderId: active?.id,
      llmApiKey: active?.apiKey ?? '',
      llmBaseUrl: active?.baseUrl ?? '',
      llmModel: active?.model ?? '',
      enableLlm: config.enableLlm
    })
  }

  const confirmEdit = async (): Promise<void> => {
    const values = await form.validateFields()
    const merged: ModelDraft = {
      ...draft,
      ...values,
      models: draft.models
    }
    if (!merged.name.trim()) {
      message.warning('请填写服务商名称')
      return
    }
    if (!merged.baseUrl.trim()) {
      message.warning('请填写 Base URL（可在高级配置中填写）')
      return
    }
    if (!merged.model.trim()) {
      message.warning('请选择或填写模型')
      return
    }

    const provider = toProvider(merged)
    const list = [...providers]
    const idx = list.findIndex((p) => p.id === provider.id)
    if (idx >= 0) list[idx] = provider
    else list.push(provider)
    await persistProviders(list)
    setEditOpen(false)
    message.success(isNew ? '已添加模型' : '已更新模型')
  }

  const toggleEnabled = async (id: string, enabled: boolean): Promise<void> => {
    let list = providers.map((p) => (p.id === id ? { ...p, enabled } : p))
    // 开启时若无当前模型，自动设为当前
    if (enabled && !list.some((p) => p.id === activeId && p.enabled)) {
      await onPersist({
        ...config,
        llmProviders: list,
        activeLlmProviderId: id,
        llmApiKey: list.find((p) => p.id === id)?.apiKey ?? '',
        llmBaseUrl: list.find((p) => p.id === id)?.baseUrl ?? '',
        llmModel: list.find((p) => p.id === id)?.model ?? '',
        enableLlm: config.enableLlm
      })
      return
    }
    await persistProviders(list)
  }

  const removeProvider = (id: string): void => {
    Modal.confirm({
      title: '删除该模型？',
      content: '删除后不可恢复',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await persistProviders(providers.filter((p) => p.id !== id))
        message.success('已删除')
      }
    })
  }

  const renderBrand = (name: string): ReactNode => {
    const brand = modelBrandIcon(name)
    return (
      <span className={`model-brand model-brand-${brand.tone}`} aria-hidden>
        {brand.letter}
      </span>
    )
  }

  return (
    <div className="model-manage">
      <div className="model-manage-top">
        <h1 className="model-manage-title">模型</h1>
        <div className="model-manage-toolbar">
          <div className="model-manage-intro">
            <div className="model-manage-sub">模型管理</div>
            <p className="model-manage-desc">
              配置 API key 添加更多可用模型，内置模型默认使用稳定版本。
            </p>
          </div>
          <button type="button" className="model-add-btn" onClick={openPick}>
            <PlusOutlined />
            添加模型
          </button>
        </div>
      </div>

      <div className="model-table">
        <div className="model-table-head">
          <span>模型</span>
          <span>服务商</span>
          <span className="model-col-ops">操作</span>
        </div>

        <button
          type="button"
          className="model-section-head"
          onClick={() => setBuiltinOpen((v) => !v)}
        >
          <span className={`model-section-caret ${builtinOpen ? 'open' : ''}`} />
          内置
        </button>
        {builtinOpen ? (
          catalogLoading && builtinRows.length === 0 ? (
            <div className="model-table-empty">正在加载内置模型…</div>
          ) : builtinRows.length === 0 ? (
            <div className="model-table-empty">
              暂无内置模型（请在管理端配置中心 → 内置模型中发布）
            </div>
          ) : (
            builtinRows.map((row) => (
              <div key={row.key} className="model-table-row">
                <div className="model-cell-model">
                  {renderBrand(row.model)}
                  <span className="model-name" title={row.model}>
                    {row.model}
                  </span>
                </div>
                <div className="model-cell-vendor" title={row.vendor}>
                  {row.vendor}
                </div>
                <div className="model-cell-ops muted">-</div>
              </div>
            ))
          )
        ) : null}

        <button
          type="button"
          className="model-section-head"
          onClick={() => setCustomOpen((v) => !v)}
        >
          <span className={`model-section-caret ${customOpen ? 'open' : ''}`} />
          自定义
        </button>
        {customOpen ? (
          providers.length === 0 ? (
            <div className="model-table-empty">暂无自定义模型</div>
          ) : (
            providers.map((p) => {
              const label = p.displayName || p.model || '未命名模型'
              const vendor =
                p.protocol === 'anthropic'
                  ? `自定义(Anthropic Compatible)`
                  : p.name || '自定义'
              return (
                <div key={p.id} className="model-table-row">
                  <div className="model-cell-model">
                    {renderBrand(label)}
                    <span className="model-name" title={label}>
                      {label}
                    </span>
                  </div>
                  <div className="model-cell-vendor" title={vendor}>
                    {vendor}
                  </div>
                  <div className="model-cell-ops">
                    <button
                      type="button"
                      className="model-icon-btn"
                      title="编辑"
                      onClick={() => openEditExisting(p)}
                    >
                      <EditOutlined />
                    </button>
                    <button
                      type="button"
                      className="model-icon-btn"
                      title="删除"
                      onClick={() => removeProvider(p.id)}
                    >
                      <DeleteOutlined />
                    </button>
                    <Switch
                      size="small"
                      checked={p.enabled}
                      onChange={(checked) => void toggleEnabled(p.id, checked)}
                    />
                  </div>
                </div>
              )
            })
          )
        ) : null}
      </div>

      <Modal
        open={pickOpen}
        title="添加模型"
        onCancel={() => setPickOpen(false)}
        centered
        zIndex={1200}
        getContainer={() => document.body}
        className="model-form-modal"
        rootClassName="model-form-modal-root"
        footer={
          <div className="model-modal-footer">
            <Button onClick={() => setPickOpen(false)}>取消</Button>
            <Button type="primary" disabled>
              提交
            </Button>
          </div>
        }
        width={720}
        destroyOnClose
      >
        <div className="model-form-modal-scroll">
          <div className="model-pick-grid">
            {presets.map((preset) => (
              <button
                key={preset.key || preset.name}
                type="button"
                className="model-pick-item"
                onClick={() => openEditFromPreset(preset)}
              >
                <span className="model-pick-avatar">
                  {(preset.name || '?').slice(0, 1)}
                </span>
                <span className="model-pick-name">{preset.name}</span>
                <RightOutlined className="model-pick-arrow" />
              </button>
            ))}
            <button type="button" className="model-pick-item" onClick={openCustom}>
              <span className="model-pick-avatar">+</span>
              <span className="model-pick-name">自定义配置</span>
              <RightOutlined className="model-pick-arrow" />
            </button>
          </div>
          {presets.length === 0 && (
            <div className="settings-card-desc" style={{ marginTop: 12 }}>
              暂无服务端内置服务商，请使用「自定义配置」，或在管理端配置中心发布内置模型。
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={editOpen}
        title={isNew ? '添加模型' : '编辑模型'}
        onCancel={() => setEditOpen(false)}
        centered
        zIndex={1200}
        getContainer={() => document.body}
        className="model-form-modal"
        rootClassName="model-form-modal-root"
        footer={
          <Button
            type="primary"
            block
            size="large"
            loading={saving}
            onClick={() => void confirmEdit()}
          >
            确认
          </Button>
        }
        width={520}
        destroyOnClose
      >
        <div className="model-form-modal-scroll">
          <Tabs
            activeKey={editTab}
            onChange={(k) => setEditTab(k as 'provider' | 'custom')}
            items={[
              { key: 'provider', label: '模型服务商' },
              { key: 'custom', label: '自定义配置' }
            ]}
          />
          <Form
            form={form}
            layout="vertical"
            initialValues={draft}
            onValuesChange={(_, all) => setDraft((d) => ({ ...d, ...all }))}
          >
            <Form.Item
              label="服务商"
              name="name"
              rules={[{ required: true, message: '请填写服务商' }]}
            >
              {editTab === 'provider' && presets.length > 0 ? (
                <Select
                  options={presets.map((p) => ({ value: p.name, label: p.name }))}
                  getPopupContainer={() => document.body}
                  onChange={(name) => {
                    const preset = presets.find((p) => p.name === name)
                    if (!preset) return
                    const next = {
                      ...fromPreset(preset),
                      id: draft.id,
                      apiKey: draft.apiKey
                    }
                    setDraft(next)
                    form.setFieldsValue(next)
                  }}
                />
              ) : (
                <Input placeholder="如：硅基流动" />
              )}
            </Form.Item>

            <Form.Item
              label="模型"
              name="model"
              rules={[{ required: true, message: '请选择模型' }]}
            >
              {editTab === 'provider' && modelOptions.length > 0 ? (
                <Select
                  showSearch
                  options={modelOptions}
                  getPopupContainer={() => document.body}
                  onChange={(model) => {
                    setDraft((d) => ({ ...d, model, displayName: model }))
                    form.setFieldsValue({ model, displayName: model })
                  }}
                />
              ) : (
                <Input className="mono" placeholder="模型 id" />
              )}
            </Form.Item>

            <Form.Item
              label={
                <span className="model-key-label">
                  API 密钥
                  {draft.apiKeyUrl ? (
                    <a href={draft.apiKeyUrl} target="_blank" rel="noreferrer">
                      获取 API 密钥
                    </a>
                  ) : null}
                </span>
              }
              name="apiKey"
              extra="已保存的密钥显示为 ••••；留空或保持掩码则不修改"
            >
              <Input.Password className="mono" placeholder="sk-…" />
            </Form.Item>

            <details className="model-advanced">
              <summary>高级配置</summary>
              <div className="model-advanced-body">
                <Form.Item label="显示名称" name="displayName">
                  <Input placeholder="列表中展示的名称" />
                </Form.Item>
                <Form.Item label="协议" name="protocol">
                  <Select
                    options={PROTOCOL_OPTIONS}
                    getPopupContainer={() => document.body}
                  />
                </Form.Item>
                <Form.Item
                  label="Base URL"
                  name="baseUrl"
                  rules={[{ required: true, message: '请填写 Base URL' }]}
                >
                  <Input className="mono" placeholder="https://…" />
                </Form.Item>
                <Form.Item
                  label="备用模型"
                  name="fallbackModels"
                  extra="勿填当前主模型；输入其它模型 id 后回车添加，点标签 × 删除"
                >
                  <Select
                    mode="tags"
                    className="mono"
                    tokenSeparators={[]}
                    placeholder="输入模型 id 后回车添加"
                    options={modelOptions.filter((o) => o.value !== draft.model)}
                    notFoundContent={null}
                    getPopupContainer={() => document.body}
                    onChange={(vals: string[]) => {
                      const next = normalizeFallbacks(vals, draft.model)
                      setDraft((d) => ({ ...d, fallbackModels: next }))
                      form.setFieldsValue({ fallbackModels: next })
                    }}
                  />
                </Form.Item>
                <Form.Item label="启用" name="enabled" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </div>
            </details>
          </Form>
        </div>
      </Modal>
    </div>
  )
}

export default ModelManagePanel
