import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from 'antd'
import type { InputRef } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import FileTypeIcon from './FileTypeIcon'

export type QuickOpenEntry = {
  path: string
}

type Props = {
  open: boolean
  files: QuickOpenEntry[]
  onClose: () => void
  onSelect: (path: string) => void
  placeholder?: string
  /** 最多展示条数 */
  limit?: number
}

/** VS Code 风格快速打开（⌘P） */
const QuickOpenDialog = ({
  open,
  files,
  onClose,
  onSelect,
  placeholder = '输入文件名以快速打开…',
  limit = 40
}: Props): JSX.Element | null => {
  const inputRef = useRef<InputRef>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    const visible = files.filter((f) => {
      const base = f.path.replace(/\\/g, '/').split('/').pop() || ''
      return (
        base !== '.DS_Store' &&
        base !== 'Thumbs.db' &&
        base !== 'Desktop.ini'
      )
    })
    const list = !q
      ? visible.slice(0, limit)
      : visible
          .filter((f) => f.path.toLowerCase().includes(q))
          .slice(0, limit)
    return list
  }, [files, query, limit])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  if (!open) return null

  return (
    <div
      className="repo-quick-open"
      role="dialog"
      aria-label="快速打开"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="repo-quick-open-panel">
        <Input
          ref={inputRef}
          className="repo-quick-open-input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(hits.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = hits[index]
              if (hit) onSelect(hit.path)
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
          prefix={<SearchOutlined />}
          allowClear
        />
        <div className="repo-quick-open-list">
          {hits.length === 0 ? (
            <div className="repo-quick-open-empty">无匹配文件</div>
          ) : (
            hits.map((f, idx) => (
              <button
                key={f.path}
                type="button"
                className={`repo-quick-open-item ${idx === index ? 'active' : ''}`}
                onMouseEnter={() => setIndex(idx)}
                onClick={() => onSelect(f.path)}
              >
                <span className="repo-quick-open-icon">
                  <FileTypeIcon name={f.path} />
                </span>
                <span className="repo-quick-open-name">
                  {f.path.split('/').pop()}
                </span>
                <span className="repo-quick-open-path">{f.path}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default QuickOpenDialog
