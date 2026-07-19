import { useEffect, useState, type ReactNode } from 'react'
import {
  languageDisplayName,
  resolveEditorLanguage
} from '../../../shared/language'
import CodeViewer from './CodeViewer'
import MarkdownMessage from './MarkdownMessage'

export const isRichDocPath = (path: string): boolean => {
  const lower = path.toLowerCase()
  return (
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm')
  )
}

const isHtmlPath = (path: string): boolean => {
  const lower = path.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

type DocMode = 'preview' | 'edit'

type Props = {
  path: string
  value: string
  language?: string
  readOnly?: boolean
  /** 相对已落盘内容是否有未保存修改 */
  dirty?: boolean
  onChange?: (value: string) => void
  onSave?: () => void
  onLanguageChange?: (language: string) => void
  showBreadcrumb?: boolean
  /** md/html 初始模式，默认预览 */
  initialDocMode?: DocMode
  /** 状态栏左侧额外信息（如分支） */
  statusLeft?: ReactNode
  className?: string
}

/**
 * IDE 工作区编辑器：Monaco + 面包屑 + 底栏
 * md/html 支持 预览 | 编辑；报告页与 IDE 共用。
 */
const WorkspaceEditor = ({
  path,
  value,
  language,
  readOnly = false,
  dirty = false,
  onChange,
  onSave,
  onLanguageChange,
  showBreadcrumb = true,
  initialDocMode = 'preview',
  statusLeft,
  className
}: Props): JSX.Element => {
  const rich = isRichDocPath(path)
  const [docMode, setDocMode] = useState<DocMode>(
    rich ? initialDocMode : 'edit'
  )
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [resolvedLang, setResolvedLang] = useState(
    resolveEditorLanguage(path, language)
  )

  useEffect(() => {
    setResolvedLang(resolveEditorLanguage(path, language))
    setDocMode(isRichDocPath(path) ? initialDocMode : 'edit')
  }, [path, language, initialDocMode])

  useEffect(() => {
    if (readOnly || !onSave) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave, readOnly])

  const crumbs = path.split(/[/\\]/).filter(Boolean)
  const showPreview = rich && docMode === 'preview'
  const canEdit = !readOnly

  return (
    <div className={`workspace-editor ${className || ''}`.trim()}>
      <div className="workspace-editor-toolbar">
        {showBreadcrumb && crumbs.length > 0 ? (
          <div className="repo-breadcrumb" title={path}>
            {crumbs.map((part, idx) => {
              const isLast = idx === crumbs.length - 1
              return (
                <span key={`${part}-${idx}`} className="repo-breadcrumb-item">
                  {idx > 0 ? (
                    <span className="repo-breadcrumb-sep">›</span>
                  ) : null}
                  <span className={isLast ? 'is-current' : ''}>{part}</span>
                </span>
              )
            })}
          </div>
        ) : (
          <span className="workspace-editor-path mono" title={path}>
            {path}
          </span>
        )}
        {rich ? (
          <div className="workspace-doc-mode" role="tablist" aria-label="预览或编辑">
            <button
              type="button"
              role="tab"
              aria-selected={docMode === 'preview'}
              className={`workspace-doc-mode-btn${docMode === 'preview' ? ' is-active' : ''}`}
              onClick={() => setDocMode('preview')}
            >
              预览
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={docMode === 'edit'}
              className={`workspace-doc-mode-btn${docMode === 'edit' ? ' is-active' : ''}`}
              disabled={!canEdit && docMode !== 'edit'}
              onClick={() => setDocMode('edit')}
            >
              编辑
            </button>
          </div>
        ) : null}
      </div>

      <div className="workspace-editor-viewer repo-browser-viewer">
        {showPreview ? (
          isHtmlPath(path) ? (
            <iframe
              key={`html-${path}-preview`}
              className="workspace-html-preview"
              title={path}
              sandbox="allow-same-origin"
              srcDoc={value}
            />
          ) : (
            <div className="workspace-md-preview">
              <MarkdownMessage content={value} />
            </div>
          )
        ) : (
          <CodeViewer
            key={`edit-${path}`}
            value={value}
            language={resolvedLang}
            path={path}
            readOnly={readOnly}
            onChange={onChange}
            onCursorChange={(line, column) => setCursor({ line, column })}
            onLanguageChange={(lang) => {
              setResolvedLang(lang)
              onLanguageChange?.(lang)
            }}
          />
        )}
      </div>

      <div className="repo-browser-statusbar">
        <div className="repo-status-left">
          {statusLeft}
          <span className="repo-status-item" title={path}>
            {path}
          </span>
          {dirty ? (
            <span className="repo-status-item is-dirty">未保存</span>
          ) : null}
          {rich ? (
            <span className="repo-status-item">
              {showPreview ? '预览' : '编辑'}
            </span>
          ) : null}
        </div>
        <div className="repo-status-right">
          {canEdit && onSave && !showPreview ? (
            <span
              className="repo-status-item repo-status-click"
              title="保存 (⌘S)"
              onClick={() => onSave()}
            >
              保存
            </span>
          ) : null}
          {!showPreview ? (
            <span className="repo-status-item">
              Ln {cursor.line}, Col {cursor.column}
            </span>
          ) : null}
          <span className="repo-status-item">Spaces: 2</span>
          <span className="repo-status-item">UTF-8</span>
          <span className="repo-status-item">
            {languageDisplayName(resolvedLang)}
          </span>
        </div>
      </div>
    </div>
  )
}

export default WorkspaceEditor
