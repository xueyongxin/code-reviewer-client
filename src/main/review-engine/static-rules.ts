import { randomUUID } from 'crypto'
import type { IssueSeverity, ReviewIssue } from '../../shared/types'

export interface StaticRule {
  id: string
  name: string
  description: string
  severity: IssueSeverity
  /** 文件扩展名过滤，空表示全部 */
  extensions?: string[]
  test: (content: string, filePath: string) => Array<{ line: number; message: string }>
}

const lineOf = (content: string, index: number): number =>
  content.slice(0, index).split('\n').length

const findRegexIssues = (
  content: string,
  pattern: RegExp,
  message: string
): Array<{ line: number; message: string }> => {
  const issues: Array<{ line: number; message: string }> = []
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const regex = new RegExp(pattern.source, flags)
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    issues.push({ line: lineOf(content, match.index), message })
    if (match.index === regex.lastIndex) regex.lastIndex++
  }
  return issues
}

export const STATIC_RULES: StaticRule[] = [
  {
    id: 'no-console-log',
    name: '禁止 console.log',
    description: '生产代码中不应保留调试日志',
    severity: 'warning',
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.vue'],
    test: (content) =>
      findRegexIssues(content, /console\.log\s*\(/g, '发现 console.log，建议移除或使用正式日志库')
  },
  {
    id: 'no-debugger',
    name: '禁止 debugger',
    description: '不应提交 debugger 语句',
    severity: 'error',
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    test: (content) => findRegexIssues(content, /\bdebugger\b/g, '发现 debugger 语句')
  },
  {
    id: 'no-hardcoded-secret',
    name: '疑似硬编码密钥',
    description: '检测常见密钥/Token 字面量',
    severity: 'error',
    test: (content) =>
      findRegexIssues(
        content,
        /(?:api[_-]?key|secret|password|token|access[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
        '疑似硬编码密钥或口令，请改用环境变量或密钥管理'
      )
  },
  {
    id: 'no-todo-fix',
    name: '遗留 TODO/FIXME',
    description: '变更中包含未处理的 TODO/FIXME',
    severity: 'info',
    test: (content) =>
      findRegexIssues(content, /\b(TODO|FIXME)\b/g, '存在 TODO/FIXME，请确认是否需要跟进')
  },
  {
    id: 'no-any-type',
    name: '避免 any 类型',
    description: 'TypeScript 中尽量避免 any',
    severity: 'warning',
    extensions: ['.ts', '.tsx'],
    test: (content) =>
      findRegexIssues(content, /:\s*any\b|<any>|as\s+any\b/g, '使用了 any 类型，建议替换为具体类型')
  },
  {
    id: 'no-var',
    name: '禁止 var',
    description: '应使用 let/const',
    severity: 'warning',
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    test: (content) => findRegexIssues(content, /\bvar\s+\w+/g, '使用了 var，建议改为 let 或 const')
  },
  {
    id: 'no-eval',
    name: '禁止 eval',
    description: 'eval 存在安全风险',
    severity: 'error',
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    test: (content) => findRegexIssues(content, /\beval\s*\(/g, '发现 eval 调用，存在安全风险')
  },
  {
    id: 'file-too-long',
    name: '文件行数超限',
    description: '单文件超过 500 行',
    severity: 'warning',
    test: (content) => {
      const lines = content.split('\n').length
      if (lines <= 500) return []
      return [{ line: 1, message: `文件共 ${lines} 行，超过 500 行建议拆分` }]
    }
  },
  {
    id: 'no-empty-catch',
    name: '禁止空 catch',
    description: 'catch 块不应为空',
    severity: 'warning',
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    test: (content) =>
      findRegexIssues(content, /catch\s*\([^)]*\)\s*\{\s*\}/g, '空的 catch 块会吞掉异常')
  },
  {
    id: 'no-http-url',
    name: '避免明文 HTTP',
    description: '代码中出现 http:// 链接',
    severity: 'info',
    test: (content) =>
      findRegexIssues(
        content,
        /http:\/\/(?!localhost|127\.0\.0\.1)/gi,
        '发现非本地 http:// 地址，建议使用 https'
      )
  },
  {
    id: 'no-force-push-hint',
    name: '危险 git 操作提示',
    description: '脚本中出现 force push',
    severity: 'error',
    extensions: ['.sh', '.bash', '.zsh', '.yml', '.yaml'],
    test: (content) =>
      findRegexIssues(content, /git\s+push\s+[^\n]*--force/gi, '检测到 force push，请谨慎使用')
  },
  {
    id: 'max-line-length',
    name: '单行过长',
    description: '单行超过 160 字符',
    severity: 'info',
    test: (content) => {
      const issues: Array<{ line: number; message: string }> = []
      content.split('\n').forEach((line, index) => {
        if (line.length > 160) {
          issues.push({
            line: index + 1,
            message: `该行长度为 ${line.length}，超过 160 字符`
          })
        }
      })
      return issues
    }
  }
]

export const DEFAULT_RULE_IDS = STATIC_RULES.map((rule) => rule.id)

const matchesExtension = (filePath: string, extensions?: string[]): boolean => {
  if (!extensions?.length) return true
  return extensions.some((ext) => filePath.endsWith(ext))
}

export const runStaticScan = (
  filePath: string,
  content: string,
  enabledRuleIds: string[],
  extraRules: StaticRule[] = []
): ReviewIssue[] => {
  const enabled = new Set(enabledRuleIds)
  const issues: ReviewIssue[] = []
  const rules = [...STATIC_RULES, ...extraRules]

  for (const rule of rules) {
    const isBuiltin = STATIC_RULES.some((item) => item.id === rule.id)
    if (isBuiltin && !enabled.has(rule.id)) continue
    if (!matchesExtension(filePath, rule.extensions)) continue

    const matches = rule.test(content, filePath)
    for (const match of matches) {
      issues.push({
        id: randomUUID(),
        filePath,
        line: match.line,
        severity: rule.severity,
        ruleId: rule.id,
        message: match.message,
        source: isBuiltin ? 'static' : 'custom'
      })
    }
  }

  return issues
}
