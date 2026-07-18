import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ReportOutputFormat, ReviewReport } from '../../shared/types'
import { formatDuration } from './flow-tracker'

export const buildMarkdownSummary = (report: ReviewReport): string => {
  const errorCount = report.issues.filter((i) => i.severity === 'error').length
  const warningCount = report.issues.filter((i) => i.severity === 'warning').length
  const infoCount = report.issues.filter((i) => i.severity === 'info').length

  const lines = [
    `# 代码审查报告`,
    '',
    `- 仓库: ${report.repoUrl}`,
    report.prNumber ? `- PR: #${report.prNumber}` : null,
    `- 开始: ${report.createdAt}`,
    report.finishedAt ? `- 结束: ${report.finishedAt}` : null,
    `- 总耗时: ${formatDuration(report.totalDurationMs)}`,
    report.pullSource ? `- 拉码来源: ${report.pullSource}` : null,
    report.fromCache ? `- 缓存: 命中` : null,
    `- 问题总数: ${report.issues.length}（错误 ${errorCount} / 警告 ${warningCount} / 提示 ${infoCount}）`,
    '',
    '## 流程时间线',
    ''
  ].filter(Boolean) as string[]

  if (!report.flowTimeline?.length) {
    lines.push('（无节点记录）')
  } else {
    for (const node of report.flowTimeline) {
      lines.push(
        `- **${node.name}** · ${node.status} · ${formatDuration(node.durationMs)}` +
          (node.detail ? ` — ${node.detail}` : '')
      )
    }
  }

  lines.push('', '## 问题列表', '')

  if (report.issues.length === 0) {
    lines.push('未发现问题。')
  } else {
    for (const issue of report.issues) {
      lines.push(
        `- **[${issue.severity}]** \`${issue.filePath}:${issue.line}\` (${issue.ruleId}) — ${issue.message}`
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
  const rows = report.issues
    .map(
      (issue) => `<tr>
      <td>${escapeHtml(issue.severity)}</td>
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
    <div class="meta">${escapeHtml(report.repoUrl)} · 问题 ${report.issues.length} 条 · ${escapeHtml(formatDuration(report.totalDurationMs))}</div>
    <table>
      <thead><tr><th>级别</th><th>位置</th><th>规则</th><th>说明</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">未发现问题</td></tr>'}</tbody>
    </table>
    <h2 style="margin-top:24px;font-size:16px">Markdown 原文</h2>
    <pre>${escapeHtml(md)}</pre>
  </div>
</body>
</html>`
}

export const persistReportFiles = (
  report: ReviewReport,
  outputDir?: string,
  formats: ReportOutputFormat[] = ['md', 'json']
): string => {
  const dir =
    outputDir && outputDir.trim()
      ? outputDir.trim()
      : join(app.getPath('documents'), 'code-reviewer-client', 'reports')

  mkdirSync(dir, { recursive: true })
  const base = `review-${report.id}`
  const wanted = new Set(formats.length ? formats : ['md', 'json'])

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
