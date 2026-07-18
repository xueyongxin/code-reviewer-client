import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { ReviewIssue } from '../../../shared/types'

interface DiffViewerProps {
  original: string
  modified: string
  language?: string
  issues?: ReviewIssue[]
  focusLine?: number
}

const severityColor: Record<string, string> = {
  error: 'rgba(255, 99, 105, 0.28)',
  warning: 'rgba(245, 165, 36, 0.24)',
  info: 'rgba(82, 169, 255, 0.22)'
}

const DiffViewer = ({
  original,
  modified,
  language = 'typescript',
  issues = [],
  focusLine
}: DiffViewerProps): JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalsRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null)
  const decorationsRef = useRef<string[]>([])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // StrictMode 下避免重复挂载残留 DOM
    el.innerHTML = ''
    monaco.editor.setTheme('vs-dark')

    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)
    originalsRef.current = originalModel
    modifiedRef.current = modifiedModel

    const editor = monaco.editor.createDiffEditor(el, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      originalEditable: false,
      minimap: { enabled: false },
      fontSize: 12,
      fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, monospace',
      scrollBeyondLastLine: false,
      renderIndicators: true,
      glyphMargin: true
    })

    editor.setModel({
      original: originalModel,
      modified: modifiedModel
    })
    editorRef.current = editor

    return () => {
      decorationsRef.current = []
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      editorRef.current = null
      originalsRef.current = null
      modifiedRef.current = null
      if (el) el.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const originalModel = originalsRef.current
    const modifiedModel = modifiedRef.current
    if (!originalModel || !modifiedModel) return

    if (originalModel.getValue() !== original) originalModel.setValue(original)
    if (modifiedModel.getValue() !== modified) modifiedModel.setValue(modified)
    monaco.editor.setModelLanguage(originalModel, language)
    monaco.editor.setModelLanguage(modifiedModel, language)
  }, [original, modified, language])

  useEffect(() => {
    const editor = editorRef.current
    const modifiedEditor = editor?.getModifiedEditor()
    if (!editor || !modifiedEditor) return

    const decorations = issues.map((issue) => ({
      range: new monaco.Range(issue.line, 1, issue.line, 1),
      options: {
        isWholeLine: true,
        className: 'cr-issue-line',
        glyphMarginClassName: 'cr-issue-glyph',
        overviewRuler: {
          color: severityColor[issue.severity] || severityColor.info,
          position: monaco.editor.OverviewRulerLane.Full
        },
        minimap: {
          color: severityColor[issue.severity] || severityColor.info,
          position: monaco.editor.MinimapPosition.Inline
        },
        linesDecorationsClassName: `cr-issue-${issue.severity}`,
        hoverMessage: {
          value: `**[${issue.severity}]** ${issue.message}\n\n\`${issue.ruleId}\``
        }
      }
    }))

    decorationsRef.current = modifiedEditor.deltaDecorations(
      decorationsRef.current,
      decorations
    )

    if (focusLine && focusLine > 0) {
      modifiedEditor.revealLineInCenter(focusLine)
      modifiedEditor.setPosition({ lineNumber: focusLine, column: 1 })
    }
  }, [issues, focusLine])

  return <div ref={containerRef} className="diff-viewer" />
}

export default DiffViewer
