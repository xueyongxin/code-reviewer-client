import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { resolveEditorLanguage } from '../../../shared/language'

interface CodeViewerProps {
  value: string
  language?: string
  path?: string
  readOnly?: boolean
  /** 内容变更（编辑时） */
  onChange?: (value: string) => void
  /** 光标变化（1-based），用于状态栏 Ln/Col */
  onCursorChange?: (line: number, column: number) => void
  /** 识别到的语言变化（供状态栏展示） */
  onLanguageChange?: (language: string) => void
}

let themesReady = false

const ensureProjectThemes = (): void => {
  if (themesReady) return
  monaco.editor.defineTheme('cr-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#14261b',
      'editorLineNumber.foreground': '#6b8575',
      'editorLineNumber.activeForeground': '#16a34a',
      'editor.selectionBackground': '#16a34a33',
      'editor.inactiveSelectionBackground': '#16a34a22',
      'editor.lineHighlightBackground': '#16a34a0f',
      'editorCursor.foreground': '#16a34a',
      'editorIndentGuide.background': '#16a34a22',
      'editorIndentGuide.activeBackground': '#16a34a55',
      'editorGutter.background': '#ffffff',
      'minimap.background': '#f7fcf9',
      'editor.wordHighlightBackground': '#16a34a22',
      'editorBracketMatch.background': '#16a34a28',
      'editorBracketMatch.border': '#16a34a88'
    }
  })
  monaco.editor.defineTheme('cr-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'editorLineNumber.foreground': '#858585',
      'editorLineNumber.activeForeground': '#c6c6c6',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editor.lineHighlightBackground': '#2a2d2e',
      'editorCursor.foreground': '#aeafad',
      'editorIndentGuide.background': '#404040',
      'editorIndentGuide.activeBackground': '#707070',
      'editorGutter.background': '#1e1e1e',
      'minimap.background': '#1e1e1e'
    }
  })
  themesReady = true
}

const currentThemeName = (): 'cr-light' | 'cr-dark' =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'cr-dark' : 'cr-light'

const CodeViewer = ({
  value,
  language,
  path,
  readOnly = false,
  onChange,
  onCursorChange,
  onLanguageChange
}: CodeViewerProps): JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const onChangeRef = useRef(onChange)
  const cursorCbRef = useRef(onCursorChange)
  const langCbRef = useRef(onLanguageChange)
  onChangeRef.current = onChange
  cursorCbRef.current = onCursorChange
  langCbRef.current = onLanguageChange

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    el.innerHTML = ''
    ensureProjectThemes()
    monaco.editor.setTheme(currentThemeName())

    const lang = resolveEditorLanguage(path, language)
    langCbRef.current?.(lang)
    const model = monaco.editor.createModel(value, lang)
    modelRef.current = model

    const editor = monaco.editor.create(el, {
      model,
      automaticLayout: true,
      readOnly,
      domReadOnly: readOnly,
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      foldingHighlight: true,
      showFoldingControls: 'mouseover',
      renderLineHighlight: 'line',
      minimap: {
        enabled: true,
        maxColumn: 120,
        scale: 1,
        showSlider: 'mouseover',
        side: 'right'
      },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineHeight: 20,
      letterSpacing: 0.3,
      fontFamily:
        'Menlo, Monaco, "Courier New", "IBM Plex Mono", Consolas, monospace',
      fontLigatures: false,
      padding: { top: 0, bottom: 0 },
      scrollbar: {
        verticalScrollbarSize: 14,
        horizontalScrollbarSize: 14,
        useShadows: false
      },
      overviewRulerLanes: 3,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      cursorStyle: 'line',
      cursorBlinking: 'blink',
      contextmenu: true,
      wordWrap: 'off',
      renderWhitespace: 'selection',
      smoothScrolling: true,
      mouseWheelZoom: true,
      bracketPairColorization: { enabled: true },
      guides: {
        indentation: true,
        bracketPairs: true,
        highlightActiveIndentation: true
      },
      stickyScroll: { enabled: true },
      fixedOverflowWidgets: true,
      find: { addExtraSpaceOnTop: false },
      tabSize: 2,
      insertSpaces: true,
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'languageDefined',
      formatOnPaste: false,
      links: true
    })
    editorRef.current = editor

    const emitCursor = (): void => {
      const pos = editor.getPosition()
      if (!pos) return
      cursorCbRef.current?.(pos.lineNumber, pos.column)
    }
    emitCursor()
    const dispCursor = editor.onDidChangeCursorPosition(emitCursor)
    const dispChange = model.onDidChangeContent(() => {
      onChangeRef.current?.(model.getValue())
    })

    const onTheme = (): void => {
      monaco.editor.setTheme(currentThemeName())
    }
    const observer = new MutationObserver(onTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      observer.disconnect()
      dispCursor.dispose()
      dispChange.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
      modelRef.current = null
      if (el) el.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ readOnly, domReadOnly: readOnly })
  }, [readOnly])

  useEffect(() => {
    const model = modelRef.current
    if (!model) return
    const lang = resolveEditorLanguage(path, language)
    if (model.getLanguageId() !== lang) {
      monaco.editor.setModelLanguage(model, lang)
    }
    langCbRef.current?.(lang)
  }, [language, path])

  useEffect(() => {
    const model = modelRef.current
    if (!model) return
    if (model.getValue() !== value) {
      const editor = editorRef.current
      const pos = editor?.getPosition()
      model.setValue(value)
      if (pos) editor?.setPosition(pos)
    }
  }, [value])

  return <div className="code-viewer" ref={containerRef} />
}

export default CodeViewer
