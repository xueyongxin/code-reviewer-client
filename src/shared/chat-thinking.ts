/** 从模型原始输出中拆出思考过程与最终回复 */

const THINK_PATTERNS: RegExp[] = [
  /<think>\s*([\s\S]*?)\s*<\/think>/i,
  /<thinking>\s*([\s\S]*?)\s*<\/thinking>/i,
  /```thinking\s*([\s\S]*?)```/i
]

/** 未闭合标签：从开标签起整段视为思考，避免原文泄漏到回复 */
const UNCLOSED_THINK_PATTERNS: RegExp[] = [
  /<think>\s*([\s\S]*)$/i,
  /<thinking>\s*([\s\S]*)$/i
]

export const splitThinkingContent = (
  raw: string
): { content: string; thinking?: string } => {
  const text = raw ?? ''
  for (const re of THINK_PATTERNS) {
    const match = text.match(re)
    if (match?.[1]?.trim()) {
      return {
        thinking: match[1].trim(),
        content: text.replace(match[0], '').trim()
      }
    }
  }
  for (const re of UNCLOSED_THINK_PATTERNS) {
    const match = text.match(re)
    if (match?.[1]?.trim()) {
      return {
        thinking: match[1].trim(),
        content: text.slice(0, match.index).trim()
      }
    }
  }
  return { content: text.trim() }
}
