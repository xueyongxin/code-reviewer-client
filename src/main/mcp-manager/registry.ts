import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpConnectionStatus, McpServerConfig, McpToolInfo } from '../../shared/types'

interface ManagedClient {
  config: McpServerConfig
  client: Client
  transport: StdioClientTransport | SSEClientTransport
  tools: McpToolInfo[]
}

export class McpRegistry {
  private clients = new Map<string, ManagedClient>()

  async connect(config: McpServerConfig): Promise<McpConnectionStatus> {
    await this.disconnect(config.id)

    try {
      const client = new Client(
        { name: 'code-reviewer-client', version: '0.1.0' },
        { capabilities: {} }
      )

      let transport: StdioClientTransport | SSEClientTransport

      if (config.transport === 'sse') {
        if (!config.url) {
          throw new Error(`MCP Server「${config.name}」缺少 SSE URL`)
        }
        transport = new SSEClientTransport(new URL(config.url))
      } else {
        if (!config.command) {
          throw new Error(`MCP Server「${config.name}」缺少启动命令`)
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: {
            ...process.env,
            ...(config.env ?? {})
          } as Record<string, string>
        })
      }

      await client.connect(transport)
      const toolsResult = await client.listTools()
      const tools: McpToolInfo[] = (toolsResult.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description
      }))

      this.clients.set(config.id, { config, client, transport, tools })

      return {
        serverId: config.id,
        name: config.name,
        connected: true,
        tools
      }
    } catch (error) {
      return {
        serverId: config.id,
        name: config.name,
        connected: false,
        tools: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const managed = this.clients.get(serverId)
    if (!managed) return

    try {
      await managed.client.close()
    } catch {
      // ignore close errors
    }
    this.clients.delete(serverId)
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.clients.keys())
    await Promise.all(ids.map((id) => this.disconnect(id)))
  }

  getStatus(configs: McpServerConfig[]): McpConnectionStatus[] {
    return configs.map((config) => {
      const managed = this.clients.get(config.id)
      if (!managed) {
        return {
          serverId: config.id,
          name: config.name,
          connected: false,
          tools: []
        }
      }
      return {
        serverId: config.id,
        name: config.name,
        connected: true,
        tools: managed.tools
      }
    })
  }

  /** 快速状态：优先用连接时缓存的 tools，不重复 listTools */
  getStatusFast(configs: McpServerConfig[]): McpConnectionStatus[] {
    return this.getStatus(configs)
  }

  getTools(serverId: string): McpToolInfo[] {
    return this.clients.get(serverId)?.tools ?? []
  }

  async refreshStatus(configs: McpServerConfig[]): Promise<McpConnectionStatus[]> {
    const results: McpConnectionStatus[] = []
    for (const config of configs) {
      const managed = this.clients.get(config.id)
      if (!managed) {
        results.push({
          serverId: config.id,
          name: config.name,
          connected: false,
          tools: []
        })
        continue
      }

      try {
        const toolsResult = await managed.client.listTools()
        const tools = (toolsResult.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description
        }))
        managed.tools = tools
        results.push({
          serverId: config.id,
          name: config.name,
          connected: true,
          tools
        })
      } catch (error) {
        results.push({
          serverId: config.id,
          name: config.name,
          connected: false,
          tools: [],
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return results
  }

  getClient(serverId: string | null): Client | null {
    if (!serverId) return this.getFirstConnectedClient()
    return this.clients.get(serverId)?.client ?? this.getFirstConnectedClient()
  }

  getFirstConnectedClient(): Client | null {
    const first = this.clients.values().next().value as ManagedClient | undefined
    return first?.client ?? null
  }

  hasConnectedClient(): boolean {
    return this.clients.size > 0
  }

  async callTool(
    serverId: string | null,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = this.getClient(serverId)
    if (!client) {
      throw new Error('没有已连接的 MCP Server，请先在配置页连接')
    }

    const result = await client.callTool({ name: toolName, arguments: args })
    return result
  }

  /** 启动时按配置里 enabled=true 自动重连（连接本身不落盘，仅进程内有效） */
  async autoConnectEnabled(configs: McpServerConfig[]): Promise<McpConnectionStatus[]> {
    const targets = configs.filter((s) => s.enabled)
    const results: McpConnectionStatus[] = []
    for (const server of targets) {
      results.push(
        await this.connect({
          ...server,
          env: { ...(server.env ?? {}) }
        })
      )
    }
    return results
  }
}

export const mcpRegistry = new McpRegistry()
