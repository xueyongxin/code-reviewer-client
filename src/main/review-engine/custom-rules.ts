import { readFileSync } from 'fs'
import yaml from 'js-yaml'
import type { CustomRuleDefinition, IssueSeverity } from '../../shared/types'
import type { StaticRule } from './static-rules'

interface RulesFile {
  rules?: Array<{
    id?: string
    name?: string
    description?: string
    severity?: string
    pattern?: string
    flags?: string
    message?: string
    extensions?: string[]
  }>
}

const toSeverity = (value?: string): IssueSeverity => {
  const v = (value ?? 'warning').toLowerCase()
  if (v === 'error') return 'error'
  if (v === 'info') return 'info'
  return 'warning'
}

export const parseCustomRulesFile = (filePath: string): CustomRuleDefinition[] => {
  const raw = readFileSync(filePath, 'utf-8')
  const lower = filePath.toLowerCase()
  let data: RulesFile

  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    data = (yaml.load(raw) as RulesFile) ?? {}
  } else {
    data = JSON.parse(raw) as RulesFile
  }

  const rules = data.rules ?? []
  return rules
    .filter((rule) => rule.id && rule.pattern && rule.message)
    .map((rule) => ({
      id: String(rule.id),
      name: String(rule.name || rule.id),
      description: rule.description,
      severity: toSeverity(rule.severity),
      pattern: String(rule.pattern),
      flags: rule.flags || 'g',
      message: String(rule.message),
      extensions: rule.extensions
    }))
}

export const toStaticRules = (defs: CustomRuleDefinition[]): StaticRule[] => {
  return defs.map((def) => ({
    id: def.id,
    name: def.name,
    description: def.description || def.name,
    severity: def.severity,
    extensions: def.extensions,
    test: (content: string) => {
      const issues: Array<{ line: number; message: string }> = []
      try {
        const flags = def.flags?.includes('g') ? def.flags : `${def.flags || ''}g`
        const regex = new RegExp(def.pattern, flags)
        let match: RegExpExecArray | null
        while ((match = regex.exec(content)) !== null) {
          const line = content.slice(0, match.index).split('\n').length
          issues.push({ line, message: def.message })
          if (match.index === regex.lastIndex) regex.lastIndex++
        }
      } catch {
        // invalid regex — skip
      }
      return issues
    }
  }))
}
