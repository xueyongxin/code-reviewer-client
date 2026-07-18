import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  content: string
  className?: string
}

/** 助手回复 Markdown 渲染（GFM：表格/删除线/任务列表等） */
const MarkdownMessage = ({ content, className }: Props): JSX.Element => {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}

export default MarkdownMessage
