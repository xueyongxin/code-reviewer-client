import type { AppConfig, ChatMessage, LlmProviderConfig } from '../../shared/types'
import { resolveActiveProvider } from './llm-reviewer'

const modelFallbacks = (provider: LlmProviderConfig, config: AppConfig): string[] => {
  const primary = provider.model
  const extras = [
    ...(provider.fallbackModels ?? []),
    ...(config.llmFallbackModels ?? [])
  ].filter((m) => m && m !== primary)
  return [primary, ...Array.from(new Set(extras))]
}

const toApiMessages = (
  system: string,
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>
): Array<{ role: string; content: string }> => {
  const filtered = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }))
  return [{ role: 'system', content: system }, ...filtered]
}

const callOpenAiCompatible = async (
  provider: LlmProviderConfig,
  system: string,
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
  signal?: AbortSignal
): Promise<string> => {
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey || 'ollama'}`
    },
    signal,
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.4,
      messages: toApiMessages(system, messages)
    })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${provider.name} 调用失败 (${response.status}): ${detail.slice(0, 240)}`)
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

const callAnthropic = async (
  provider: LlmProviderConfig,
  system: string,
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
  signal?: AbortSignal
): Promise<string> => {
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal,
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 4096,
      temperature: 0.4,
      system,
      messages: messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))
    })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${provider.name} 调用失败 (${response.status}): ${detail.slice(0, 240)}`)
  }
  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>
  }
  return (data.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim()
}

const callOllama = async (
  provider: LlmProviderConfig,
  system: string,
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
  signal?: AbortSignal
): Promise<string> => {
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  try {
    return await callOpenAiCompatible(
      { ...provider, baseUrl: `${baseUrl}/v1`, apiKey: provider.apiKey || 'ollama' },
      system,
      messages,
      signal
    )
  } catch {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        messages: toApiMessages(system, messages)
      })
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`${provider.name} 调用失败 (${response.status}): ${detail.slice(0, 240)}`)
    }
    const data = (await response.json()) as { message?: { content?: string } }
    return data.message?.content?.trim() ?? ''
  }
}

const callProviderChat = async (
  provider: LlmProviderConfig,
  system: string,
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
  signal?: AbortSignal
): Promise<string> => {
  if (provider.protocol === 'anthropic') {
    return callAnthropic(provider, system, messages, signal)
  }
  if (provider.protocol === 'ollama') {
    return callOllama(provider, system, messages, signal)
  }
  return callOpenAiCompatible(provider, system, messages, signal)
}

export const runChatCompletion = async (
  config: AppConfig,
  system: string,
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
  signal?: AbortSignal
): Promise<{ content: string; model: string; providerName: string }> => {
  const provider = resolveActiveProvider(config)
  if (!provider) {
    throw new Error('请先在 Settings 中配置并启用 LLM 模型')
  }
  if (!provider.baseUrl?.trim()) {
    throw new Error(`「${provider.name}」缺少 Base URL`)
  }
  if (!provider.model?.trim()) {
    throw new Error(`「${provider.name}」缺少模型名`)
  }
  if (!provider.apiKey?.trim() && provider.protocol !== 'ollama') {
    throw new Error(`请先为「${provider.name}」填写 API Key`)
  }

  const models = modelFallbacks(provider, config)
  let lastError = ''

  for (const model of models) {
    try {
      const content = await callProviderChat({ ...provider, model }, system, messages, signal)
      if (content) {
        return { content, model, providerName: provider.name }
      }
      lastError = `${provider.name}/${model} 返回空内容`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (signal?.aborted) throw error
    }
  }

  throw new Error(lastError || `${provider.name} 对话失败`)
}
