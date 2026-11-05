// The MCP endpoint behind /mcp. Every tool runs a lock route, so MCP and the
// CLI share one implementation and one input schema. Token scopes are in
// tokens.ts.

import type { Bot } from '../../bot.ts'

import { runLockRoute } from './routes.ts'
import type { McpScope } from './tokens.ts'

export type { McpScope } from './tokens.ts'

type ToolResult = { data: unknown } | Error

type McpTool = {
  name: string
  description: string
  scope: McpScope
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  // Returns the reason to reject, or null.
  guard?: (args: Record<string, unknown>) => string | null
  run: (bot: Bot, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>
}

// Every tool is a named lock route. The MCP layer only adds the JSON schema and
// the scope, so a route change cannot drift from the tool contract.
function routeTool(
  name: string,
  description: string,
  {
    scope,
    route,
    inputSchema,
    guard,
  }: {
    scope: McpScope
    route: string
    inputSchema: McpTool['inputSchema']
    guard?: McpTool['guard']
  },
): McpTool {
  return {
    name,
    description,
    scope,
    inputSchema,
    guard,
    run: (bot, args, signal) => runLockRoute(bot, { route, input: args, signal }),
  }
}

const sessionTarget = {
  sessionId: { type: 'string', description: 'OpenCode session ID' },
  threadId: { type: 'string', description: 'Discord thread ID' },
}

const optionalTarget = {
  channelId: { type: 'string', description: 'Channel ID; starts a new session thread' },
  threadId: { type: 'string', description: 'Existing thread; continues its session' },
  sessionId: { type: 'string', description: 'Existing session' },
  project: { type: 'string', description: 'Project channel or project directory' },
}

const mcpTools: readonly McpTool[] = [
  routeTool(
    'send',
    'Post a message to a channel or thread, or start a thread. Add `queue` to the prompt to run after the current turn.',
    {
      scope: 'notify',
      route: 'send',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Message text' },
          ...optionalTarget,
          name: { type: 'string', description: 'Thread name' },
          agent: { type: 'string', description: 'Agent ID' },
          model: { type: 'string', description: 'provider/model' },
          user: {
            type: 'array',
            items: { type: 'string' },
            description: 'Discord user IDs to add to the thread',
          },
          notifyOnly: { type: 'boolean', description: 'Post without starting an AI session' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { uri: { type: 'string' }, name: { type: 'string' } },
              required: ['uri', 'name'],
            },
          },
        },
        required: ['prompt'],
      },
      guard: (args) =>
        args['channelId'] !== undefined || args['project'] !== undefined
          ? 'The notify token cannot start a session. Pass threadId or sessionId.'
          : null,
    },
  ),
  routeTool('upload', 'Attach local files to a session thread or channel.', {
    scope: 'notify',
    route: 'upload',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID, thread ID or channel ID' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, name: { type: 'string' } },
            required: ['path', 'name'],
          },
        },
      },
      required: ['id', 'files'],
    },
  }),
  routeTool('buttons', 'End a turn with 1-3 action buttons.', {
    scope: 'notify',
    route: 'buttons',
    inputSchema: {
      type: 'object',
      properties: {
        buttons: {
          type: 'array',
          maxItems: 3,
          items: { type: 'string', description: 'Label[:white|blue|green|red]' },
        },
        ...sessionTarget,
        fromShell: { type: 'boolean' },
        toolCall: { type: 'string' },
      },
      required: ['buttons'],
    },
  }),
  routeTool('user_lookup', 'Resolve Discord users of a guild for mentions.', {
    scope: 'notify',
    route: 'user.list',
    inputSchema: {
      type: 'object',
      properties: {
        guild: { type: 'string', description: 'Guild ID' },
        query: { type: 'string', description: 'Name filter' },
      },
      required: ['guild'],
    },
  }),
  routeTool('project_list', 'List project channels and their directories.', {
    scope: 'control',
    route: 'project.list',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  }),
  routeTool('session_list', 'List sessions with status and token counts.', {
    scope: 'control',
    route: 'session.list',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project directory (default: none)' },
        all: { type: 'boolean', description: 'All projects' },
        active: { type: 'boolean', description: 'Only busy sessions' },
        exclude: { type: 'array', items: { type: 'string' } },
        json: { type: 'boolean' },
      },
    },
  }),
  routeTool('session_read', 'Read a session as markdown.', {
    scope: 'control',
    route: 'session.read',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID, thread ID or thread URL' },
        thinking: { type: 'boolean' },
        verbose: { type: 'boolean' },
        json: { type: 'boolean' },
      },
      required: ['id'],
    },
  }),
  routeTool('session_archive', 'Archive a session thread.', {
    scope: 'control',
    route: 'session.archive',
    inputSchema: {
      type: 'object',
      properties: sessionTarget,
    },
  }),
  routeTool('sleep', 'Wake this session later.', {
    scope: 'control',
    route: 'sleep',
    inputSchema: {
      type: 'object',
      properties: {
        ...sessionTarget,
        duration: { type: 'string', description: 'For example 90s, 30m or 2h' },
        until: { type: 'string', description: 'UTC ISO time' },
        reason: { type: 'string' },
      },
    },
  }),
  routeTool('routine_list', 'List scheduled routines.', {
    scope: 'control',
    route: 'routine.list',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'Include finished routines' } },
    },
  }),
]

const toolByName = new Map(mcpTools.map((tool) => [tool.name, tool]))

export type McpRequest = { jsonrpc?: string; id?: number | string | null; method: string; params?: unknown }

export type McpResponse = { status: number; body: unknown }

const SERVER_INFO = { name: 'teetee', version: '1.0.0' }
// Streamable HTTP, the spec OpenCode's `legacy` protocol speaks.
const PROTOCOL_VERSION = '2025-03-26'

function jsonRpcError(id: McpRequest['id'], code: number, message: string): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } }
}

function jsonRpcResult(id: McpRequest['id'], result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } }
}

function argsOf(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  const args = Reflect.get(params, 'arguments')
  return args && typeof args === 'object' && !Array.isArray(args) ? Reflect.get(params, 'arguments') : {}
}

function toolResult(id: McpRequest['id'], result: unknown): McpResponse {
  return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
}

function toolError(id: McpRequest['id'], text: string): McpResponse {
  return jsonRpcResult(id, { isError: true, content: [{ type: 'text', text }] })
}

async function callTool({
  bot,
  scope,
  id,
  name,
  params,
  signal,
}: {
  bot: Bot
  scope: McpScope
  id: McpRequest['id']
  name: unknown
  params: unknown
  signal: AbortSignal
}): Promise<McpResponse> {
  const tool = typeof name === 'string' ? toolByName.get(name) : undefined
  if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${String(name)}`)
  if (tool.scope === 'control' && scope === 'notify') return toolError(id, `The notify token cannot call ${tool.name}`)
  const args = argsOf(params)
  const rejected = scope === 'notify' ? tool.guard?.(args) : null
  if (rejected) return toolError(id, rejected)
  const result = await tool.run(bot, args, signal)
  return result instanceof Error ? toolError(id, result.message) : toolResult(id, result.data)
}

// One MCP request. `id` is echoed on the result; a notification (no id) still
// gets 202 with no body at the HTTP layer.
export async function handleMcp({
  bot,
  scope,
  request,
  signal,
}: {
  bot: Bot
  scope: McpScope
  request: McpRequest
  signal: AbortSignal
}): Promise<McpResponse> {
  if (request.method === 'initialize') {
    return jsonRpcResult(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (request.method === 'ping') return jsonRpcResult(request.id, {})
  if (request.method === 'notifications/initialized') return { status: 202, body: null }
  if (request.method === 'tools/list') {
    return jsonRpcResult(request.id, {
      tools: mcpTools
        .filter((tool) => scope === 'control' || tool.scope === 'notify')
        .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    })
  }
  if (request.method === 'tools/call') {
    const params = request.params && typeof request.params === 'object' ? request.params : {}
    return callTool({
      bot,
      scope,
      id: request.id,
      name: Reflect.get(params, 'name'),
      params,
      signal,
    })
  }
  return jsonRpcError(request.id, -32601, `Unknown method: ${request.method}`)
}
