import type { ReactNode } from 'react'
import {
  FileMarkdownOutlined,
  FileOutlined,
  FileTextOutlined,
  Html5Outlined
} from '@ant-design/icons'

/** Cursor 风格：按扩展名着色的文件图标 */
export const FileTypeIcon = ({ name }: { name: string }): ReactNode => {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : ''
  const base = name.split('/').pop()?.toLowerCase() || ''
  if (base === '.gitignore' || base === '.gitattributes') {
    return <span className="repo-file-badge is-git">git</span>
  }
  if (ext === 'md' || ext === 'mdx') {
    return <FileMarkdownOutlined className="repo-file-icon is-md" />
  }
  if (ext === 'json' || ext === 'jsonc') {
    return <span className="repo-file-badge is-json">{'{}'}</span>
  }
  if (ext === 'ts' || ext === 'tsx') {
    return <span className="repo-file-badge is-ts">TS</span>
  }
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') {
    return <span className="repo-file-badge is-js">JS</span>
  }
  if (ext === 'css' || ext === 'scss' || ext === 'less') {
    return <span className="repo-file-badge is-css">CSS</span>
  }
  if (ext === 'html' || ext === 'htm') {
    return <Html5Outlined className="repo-file-icon is-html" />
  }
  if (ext === 'yml' || ext === 'yaml') {
    return <span className="repo-file-badge is-yml">YML</span>
  }
  if (ext === 'py') {
    return <span className="repo-file-badge is-py">PY</span>
  }
  if (ext === 'java') {
    return <span className="repo-file-badge is-java">JV</span>
  }
  if (ext === 'txt' || ext === 'log') {
    return <FileTextOutlined className="repo-file-icon is-txt" />
  }
  return <FileOutlined className="repo-file-icon" />
}

export default FileTypeIcon
