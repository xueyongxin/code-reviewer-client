import { useCallback, useEffect, useState } from 'react'
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined
} from '@ant-design/icons'
import type {
  AppConfig,
  LlmMemory,
  MemoryKind,
  MemoryScope,
  MemoryStats
} from '../../../shared/types'

const KIND_OPTIONS: Array<{ value: MemoryKind; label: string }> = [
  { value: 'preference', label: '用户偏好' },
  { value: 'convention', label: '项目约定' },
  { value: 'review', label: '审查结论' },
  { value: 'fix', label: '修复经验' },
  { value: 'note', label: '笔记' }
]

const kindLabel = (kind: MemoryKind): string =>
  KIND_OPTIONS.find((o) => o.value === kind)?.label || kind

type Props = {
  config: AppConfig
  saveConfig: (next: AppConfig) => Promise<void>
}

export function MemorySettingsPanel({
  config,
  saveConfig
}: Props): JSX.Element {
  const { message, modal } = App.useApp()
  const [items, setItems] = useState<LlmMemory[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [q, setQ] = useState('')
  const [appliedQ, setAppliedQ] = useState('')
  const [editing, setEditing] = useState<LlmMemory | null>(null)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<{
    title: string
    content: string
    kind: MemoryKind
    scope: MemoryScope
    repoUrl?: string
    tags?: string
  }>()

  const reload = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([
        window.electronAPI.listMemories({
          q: appliedQ.trim() || undefined
        }),
        window.electronAPI.getMemoryStats()
      ])
      setItems(list)
      setStats(st)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载记忆失败')
    }
  }, [message, appliedQ])

  useEffect(() => {
    void reload()
  }, [reload])

  const openCreate = () => {
    setCreating(true)
    setEditing(null)
    form.setFieldsValue({
      title: '',
      content: '',
      kind: 'note',
      scope: 'global',
      repoUrl: '',
      tags: ''
    })
  }

  const openEdit = (row: LlmMemory) => {
    setCreating(false)
    setEditing(row)
    form.setFieldsValue({
      title: row.title,
      content: row.content,
      kind: row.kind,
      scope: row.scope,
      repoUrl: row.repoUrl || '',
      tags: row.tags.join(', ')
    })
  }

  const closeModal = () => {
    setCreating(false)
    setEditing(null)
  }

  const submit = async () => {
    const values = await form.validateFields()
    const tags = (values.tags || '')
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)
    try {
      await window.electronAPI.upsertMemory({
        id: editing?.id,
        title: values.title,
        content: values.content,
        kind: values.kind,
        scope: values.scope,
        repoUrl: values.scope === 'repo' ? values.repoUrl : undefined,
        tags,
        enabled: editing?.enabled ?? true,
        source: editing?.source || 'manual'
      })
      message.success(editing ? '已更新记忆' : '已添加记忆')
      closeModal()
      await reload()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const sourceLabel = (source: LlmMemory['source']): string => {
    if (source === 'remember') return '/remember'
    if (source === 'chat') return '对话沉淀'
    if (source === 'review') return '审查沉淀'
    return '手动'
  }

  return (
    <div className="settings-main-inner memory-settings">
      <header className="memory-page-header">
        <div>
          <h1 className="settings-h1">大模型记忆</h1>
          <p className="ext-apps-lead">
            跨会话保存偏好与约定，对话 / 审查时按作用域注入。默认仅存本机。
          </p>
        </div>
        {stats ? (
          <div className="memory-stat-chip" title="已启用 / 总数 / 上限">
            <span className="memory-stat-num">{stats.enabled}</span>
            <span className="memory-stat-sep">/</span>
            <span>{stats.total}</span>
            <span className="memory-stat-sep">·</span>
            <span className="memory-stat-cap">{stats.maxCount}</span>
          </div>
        ) : null}
      </header>

      <section className="account-block">
        <div className="account-block-label">记忆列表</div>
        <div className="account-block-card general-card memory-list-card">
          <div className="memory-toolbar">
            <Input
              allowClear
              placeholder="搜索标题 / 内容 / 标签，回车搜索"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onPressEnter={() => setAppliedQ(q.trim())}
              onClear={() => {
                setQ('')
                setAppliedQ('')
              }}
              className="memory-toolbar-search"
            />
            <div className="memory-toolbar-actions">
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={openCreate}
                disabled={!config.enableMemory}
              >
                添加
              </Button>
            </div>
          </div>

          {!items.length ? (
            <div className="memory-empty">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  appliedQ.trim()
                    ? '没有匹配的记忆'
                    : '暂无记忆，可添加或在对话中使用 /remember'
                }
              />
            </div>
          ) : (
            <div className="memory-list">
              {items.map((row) => (
                <div
                  key={row.id}
                  className={`memory-list-item${row.enabled ? '' : ' is-disabled'}`}
                >
                  <div className="memory-list-main">
                    <div className="memory-list-title-row">
                      <span className="memory-list-title">{row.title}</span>
                      <span className="memory-chip">{kindLabel(row.kind)}</span>
                      <span
                        className={`memory-chip${row.scope === 'repo' ? ' is-repo' : ''}`}
                      >
                        {row.scope === 'repo' ? '仓库' : '全局'}
                      </span>
                      {!row.enabled ? (
                        <span className="memory-chip is-off">已禁用</span>
                      ) : null}
                    </div>
                    <p className="memory-list-content">{row.content}</p>
                    <div className="memory-list-meta">
                      <span>{sourceLabel(row.source)}</span>
                      {row.repoUrl ? <span title={row.repoUrl}>{row.repoUrl}</span> : null}
                      {row.tags.length ? (
                        <span>{row.tags.slice(0, 4).join(' · ')}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="memory-list-actions">
                    <Switch
                      size="small"
                      checked={row.enabled}
                      onChange={async (checked) => {
                        await window.electronAPI.setMemoryEnabled(row.id, checked)
                        await reload()
                      }}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      aria-label="编辑"
                      onClick={() => openEdit(row)}
                    />
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="删除"
                      onClick={() => {
                        modal.confirm({
                          title: '删除这条记忆？',
                          content: row.title,
                          okText: '删除',
                          okButtonProps: { danger: true },
                          onOk: async () => {
                            await window.electronAPI.deleteMemory(row.id)
                            message.success('已删除')
                            await reload()
                          }
                        })
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="account-block">
        <div className="account-block-label">偏好设置</div>
        <div className="account-block-card general-card">
          <div className="general-row">
            <div className="general-row-copy">
              <div className="general-row-title">启用大模型记忆</div>
              <div className="general-row-desc">
                关闭后不再写入或注入；已有条目仍保留在本机
              </div>
            </div>
            <Switch
              checked={Boolean(config.enableMemory)}
              onChange={(checked) => {
                void saveConfig({ ...config, enableMemory: checked })
              }}
            />
          </div>
          <div className="account-divider" />
          <div className="general-row">
            <div className="general-row-copy">
              <div className="general-row-title">自动沉淀</div>
              <div className="general-row-desc">
                对话中的偏好/约定与审查 error 会自动写入（可去重）
              </div>
            </div>
            <Switch
              checked={Boolean(config.enableMemoryAutoExtract)}
              disabled={!config.enableMemory}
              onChange={(checked) => {
                void saveConfig({ ...config, enableMemoryAutoExtract: checked })
              }}
            />
          </div>
          <div className="account-divider" />
          <div className="general-row">
            <div className="general-row-copy">
              <div className="general-row-title">容量上限</div>
              <div className="general-row-desc">
                超出后自动删除最旧记忆
              </div>
            </div>
            <InputNumber
              min={20}
              max={1000}
              step={10}
              value={config.memoryMaxCount ?? 200}
              disabled={!config.enableMemory}
              onChange={(v) => {
                void saveConfig({
                  ...config,
                  memoryMaxCount: Math.max(20, Math.min(1000, Number(v) || 200))
                })
              }}
            />
          </div>
          <div className="account-divider" />
          <div className="general-row">
            <div className="general-row-copy">
              <div className="general-row-title">检索方式</div>
              <div className="general-row-desc">
                增强检索在关键词外叠加文本相似度
              </div>
            </div>
            <Select
              style={{ width: 140 }}
              disabled={!config.enableMemory}
              value={config.memoryRetrievalMode || 'hybrid'}
              options={[
                { value: 'hybrid', label: '增强检索' },
                { value: 'keyword', label: '仅关键词' }
              ]}
              onChange={(v) => {
                void saveConfig({
                  ...config,
                  memoryRetrievalMode: v === 'keyword' ? 'keyword' : 'hybrid'
                })
              }}
            />
          </div>
          <div className="account-divider" />
          <div className="general-row">
            <div className="general-row-copy">
              <div className="general-row-title">清理最旧记忆</div>
              <div className="general-row-desc">一次删除最旧的 20 条</div>
            </div>
            <Button
              disabled={!config.enableMemory || !stats?.total}
              onClick={() => {
                modal.confirm({
                  title: '删除最旧的 20 条记忆？',
                  okText: '删除',
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    const r = await window.electronAPI.clearOldestMemories(20)
                    message.success(`已删除 ${r.deleted} 条`)
                    setStats(r.stats)
                    await reload()
                  }
                })
              }}
            >
              清理
            </Button>
          </div>
        </div>
      </section>

      <section className="account-block">
        <div className="account-block-label">备份与同步</div>
        <div className="account-block-card general-card">
          <div className="general-row">
            <div className="general-row-copy">
              <div className="general-row-title">导出 / 导入 JSON</div>
              <div className="general-row-desc">
                跨设备迁移；导入时自动去重合并
              </div>
            </div>
            <Space size={8}>
              <Button
                disabled={!config.enableMemory}
                onClick={async () => {
                  try {
                    const r = await window.electronAPI.exportMemories()
                    if (!r.ok) return
                    message.success(`已导出 ${r.count} 条`)
                  } catch (e) {
                    message.error(e instanceof Error ? e.message : '导出失败')
                  }
                }}
              >
                导出
              </Button>
              <Button
                disabled={!config.enableMemory}
                onClick={async () => {
                  try {
                    const r = await window.electronAPI.importMemories()
                    if (!r.ok) return
                    message.success(
                      `导入完成：新增 ${r.imported}，合并 ${r.merged}`
                    )
                    setStats(r.memoryStats)
                    await reload()
                  } catch (e) {
                    message.error(e instanceof Error ? e.message : '导入失败')
                  }
                }}
              >
                导入
              </Button>
            </Space>
          </div>
          <div className="account-divider" />
          <div className="general-row">
            <div className="general-row-copy">
              <div className="general-row-title">从 Memory MCP 导入</div>
              <div className="general-row-desc">
                需先在 MCP 连接 server-memory（可选）
              </div>
            </div>
            <Button
              disabled={!config.enableMemory}
              onClick={async () => {
                try {
                  const r = await window.electronAPI.importMemoriesFromMcp()
                  message.success(
                    `MCP 导入：新增 ${r.imported}，合并 ${r.merged}（${r.detail}）`
                  )
                  setStats(r.memoryStats)
                  await reload()
                } catch (e) {
                  message.error(e instanceof Error ? e.message : 'MCP 导入失败')
                }
              }}
            >
              导入
            </Button>
          </div>
          <div className="account-divider" />
          <div className="general-row is-muted">
            <div className="general-row-copy">
              <div className="general-row-title">云端同步</div>
              <div className="general-row-desc">
                尚未开放；跨机请先用导入导出
              </div>
            </div>
            <Switch checked={false} disabled />
          </div>
        </div>
      </section>

      <Modal
        open={creating || Boolean(editing)}
        title={editing ? '编辑记忆' : '添加记忆'}
        onCancel={closeModal}
        onOk={() => void submit()}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '请填写标题' }]}
          >
            <Input placeholder="简短标题" maxLength={80} />
          </Form.Item>
          <Form.Item
            name="content"
            label="内容"
            rules={[{ required: true, message: '请填写内容' }]}
          >
            <Input.TextArea rows={5} placeholder="希望模型长期遵守或参考的内容" />
          </Form.Item>
          <Form.Item name="kind" label="类型" initialValue="note">
            <Select options={KIND_OPTIONS} />
          </Form.Item>
          <Form.Item name="scope" label="作用域" initialValue="global">
            <Select
              options={[
                { value: 'global', label: '全局' },
                { value: 'repo', label: '当前仓库' }
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.scope !== c.scope}>
            {() =>
              form.getFieldValue('scope') === 'repo' ? (
                <Form.Item
                  name="repoUrl"
                  label="仓库 URL"
                  rules={[{ required: true, message: '请填写仓库地址' }]}
                >
                  <Input placeholder="https://github.com/org/repo" />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Input placeholder="逗号分隔，可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
