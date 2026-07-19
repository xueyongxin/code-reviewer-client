import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { formatDateTime } from '../../shared/datetime'
import type { ReportOutputFormat, ReviewReport } from '../../shared/types'
import { formatDuration } from './flow-tracker'

/** 报告只收录 error；兼容历史数据中的 warning/info */
const reportErrors = (report: ReviewReport): ReviewReport['issues'] =>
  (report.issues ?? []).filter((i) => i.severity === 'error')

export const buildMarkdownSummary = (report: ReviewReport): string => {
  const errors = reportErrors(report)

  const lines = [
    `# 代码审查报告`,
    '',
    `- 仓库: ${report.repoUrl}`,
    report.prNumber ? `- PR: #${report.prNumber}` : null,
    `- 开始: ${formatDateTime(report.createdAt, report.createdAt || '-')}`,
    report.finishedAt
      ? `- 结束: ${formatDateTime(report.finishedAt, report.finishedAt)}`
      : null,
    `- 总耗时: ${formatDuration(report.totalDurationMs)}`,
    report.pullSource ? `- 拉码来源: ${report.pullSource}` : null,
    report.fromCache ? `- 缓存: 命中` : null,
    `- 错误数: ${errors.length}`,
    '',
    '## 流程时间线',
    ''
  ].filter(Boolean) as string[]

  if (!report.flowTimeline?.length) {
    lines.push('（无节点记录）')
  } else {
    for (const node of report.flowTimeline) {
      const when = [
        formatDateTime(node.startedAt),
        formatDateTime(node.endedAt)
      ]
        .filter(Boolean)
        .join(' → ')
      lines.push(
        `- **${node.name}** · ${node.status} · ${formatDuration(node.durationMs)}` +
          (when ? ` · ${when}` : '') +
          (node.detail ? ` — ${node.detail}` : '')
      )
    }
  }

  lines.push('', '## 问题列表', '')

  if (errors.length === 0) {
    lines.push('未发现错误。')
  } else {
    for (const issue of errors) {
      lines.push(
        `- **[error]** \`${issue.filePath}:${issue.line}\` (${issue.ruleId}) — ${issue.message}`
      )
    }
  }

  return lines.join('\n')
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const buildHtmlSummary = (report: ReviewReport): string => {
  const md = report.summaryMarkdown || buildMarkdownSummary(report)
  const errors = reportErrors(report)
  const rows = errors
    .map(
      (issue) => `<tr>
      <td>error</td>
      <td><code>${escapeHtml(issue.filePath)}:${issue.line}</code></td>
      <td>${escapeHtml(issue.ruleId)}</td>
      <td>${escapeHtml(issue.message)}</td>
    </tr>`
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>代码审查报告 · ${escapeHtml(report.repoUrl)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; margin: 32px; color: #14261b; background: #f4faf6; }
    .card { background: #fff; border: 1px solid rgba(15,80,40,.1); border-radius: 12px; padding: 20px 24px; max-width: 960px; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    .meta { color: #6b8575; font-size: 13px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid rgba(15,80,40,.1); padding: 8px 6px; text-align: left; vertical-align: top; }
    th { color: #3d5a48; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    pre { white-space: pre-wrap; background: #f7fcf9; padding: 12px; border-radius: 8px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>代码审查报告</h1>
    <div class="meta">${escapeHtml(report.repoUrl)} · 错误 ${errors.length} 条 · ${escapeHtml(formatDuration(report.totalDurationMs))}</div>
    <table>
      <thead><tr><th>级别</th><th>位置</th><th>规则</th><th>说明</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">未发现错误</td></tr>'}</tbody>
    </table>
    <h2 style="margin-top:24px;font-size:16px">Markdown 原文</h2>
    <pre>${escapeHtml(md)}</pre>
  </div>
</body>
</html>`
}

/**
 * 将报告按所选格式写入目录（支持同时生成多种：md / html / json）。
 * 流水线配置了工作区时，上层应传入 `{项目根}/分析报告`。
 */
export const persistReportFiles = (
  report: ReviewReport,
  outputDir?: string,
  formats: ReportOutputFormat[] = ['md', 'html']
): string => {
  const dir =
    outputDir && outputDir.trim()
      ? outputDir.trim()
      : join(app.getPath('documents'), 'code-reviewer-client', 'reports')

  mkdirSync(dir, { recursive: true })
  // 同一报告 id 固定文件名，重复落盘会覆盖而不是再生成一份
  const stamp = (report.finishedAt || report.createdAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .slice(0, 19)
  const base = `review-${stamp}-${report.id.slice(0, 8)}`
  const wanted = new Set(formats.length ? formats : ['md', 'html'])

  if (wanted.has('json')) {
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(report, null, 2), 'utf-8')
  }
  if (wanted.has('md')) {
    writeFileSync(
      join(dir, `${base}.md`),
      report.summaryMarkdown || buildMarkdownSummary(report),
      'utf-8'
    )
  }
  if (wanted.has('html')) {
    writeFileSync(join(dir, `${base}.html`), buildHtmlSummary(report), 'utf-8')
  }
  return dir
}
