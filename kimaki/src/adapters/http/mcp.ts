// The MCP endpoint behind /mcp. One JSON-RPC method per MCP request; every tool
// runs a lock route, so MCP and the CLI share one implementation and one input
// schema.
//
// Two tokens:
//   control  this machine (OpenCode plugin, CLI, tests): every tool
//   notify   other machines and clients: send, upload, buttons, user_lookup
// A notify token never starts a session, reads a transcript, or runs a shell,
// because those actions run code on the bot host.

import type { Bot } from '../../bot.ts'
import { runLockRoute } from './routes.ts'
import type { BotTokens } from './rpc.ts'

export type McpScope = 'control' | 'notify'

type ToolResult = { data: unknown } | Error

export type McpTool = {
  name: string
  description: string
  // control tools reject a notify token.
  scope: McpScope
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  run: (bot: Bot, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>
}

// Every tool is a named lock route. The MCP layer only adds the JSON schema and
// the scope, so a route change cannot drift from the tool contract.
function routeTool(
  name: string,
  description: string,
  scope: McpScope,
  route: string,
  inputSchema: McpTool['inputSchema'],
): McpTool {
  return {
    name,
    description,
    scope,
    inputSchema,
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

export const mcpTools: readonly McpTool[] = [
  routeTool(
    'send',
    'Post a message to a channel or thread, or start a thread. Add `queue` to the prompt to run after the current turn.',
    'notify',
    'send',
    {
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
  ),
  routeTool('upload', 'Attach local files to a session thread or channel.', 'notify', 'upload', {
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
  }),
  routeTool('buttons', 'End a turn with 1-3 action buttons.', 'notify', 'buttons', {
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
  }),
  routeTool('user_lookup', 'Resolve Discord users of a guild for mentions.', 'notify', 'user.list', {
    type: 'object',
    properties: {
      guild: { type: 'string', description: 'Guild ID' },
      query: { type: 'string', description: 'Name filter' },
    },
    required: ['guild'],
  }),
  routeTool('project_list', 'List project channels and their directories.', 'control', 'project.list', {
    type: 'object',
    properties: {},
  }),
  routeTool('session_list', 'List sessions with status and token counts.', 'control', 'session.list', {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project directory (default: none)' },
      all: { type: 'boolean', description: 'All projects' },
      active: { type: 'boolean', description: 'Only busy sessions' },
      exclude: { type: 'array', items: { type: 'string' } },
      json: { type: 'boolean' },
    },
  }),
  routeTool('session_read', 'Read a session as markdown.', 'control', 'session.read', {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Session ID, thread ID or thread URL' },
      thinking: { type: 'boolean' },
      verbose: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    required: ['id'],
  }),
  routeTool('session_archive', 'Archive a session thread.', 'control', 'session.archive', {
    type: 'object',
    properties: sessionTarget,
  }),
  routeTool('sleep', 'Wake this session later.', 'control', 'sleep', {
    type: 'object',
    properties: {
      ...sessionTarget,
      duration: { type: 'string', description: 'For example 90s, 30m or 2h' },
      until: { type: 'string', description: 'UTC ISO time' },
      reason: { type: 'string' },
    },
  }),
  routeTool('routine_list', 'List scheduled routines.', 'control', 'routine.list', {
    type: 'object',
    properties: { all: { type: 'boolean', description: 'Include finished routines' } },
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

export function mcpScopeFor({ authorization, tokens }: { authorization: string | undefined; tokens: BotTokens }) {
  if (authorization === `Bearer ${tokens.control}`) return 'control' as const
  if (authorization === `Bearer ${tokens.notify}`) return 'notify' as const
  return null
}

async function callTool({
  bot,
  scope,
  name,
  params,
  signal,
}: {
  bot: Bot
  scope: McpScope
  name: unknown
  params: unknown
  signal: AbortSignal
}): Promise<McpResponse> {
  const tool = typeof name === 'string' ? toolByName.get(name) : undefined
  if (!tool) return jsonRpcError(null, -32602, `Unknown tool: ${String(name)}`)
  if (tool.scope === 'control' && scope === 'notify') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: null,
        result: { isError: true, content: [{ type: 'text', text: `The notify token cannot call ${tool.name}` }] },
      },
    }
  }
  const args = argsOf(params)
  if (scope === 'notify' && tool.name === 'send' && (args['channelId'] !== undefined || args['project'] !== undefined)) {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: null,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'The notify token cannot start a session. Pass threadId or sessionId.' }],
        },
      },
    }
  }
  const result = await tool.run(bot, args, signal)
  if (result instanceof Error) {
    return {
      status: 200,
      body: { jsonrpc: '2.0', id: null, result: { isError: true, content: [{ type: 'text', text: result.message }] } },
    }
  }
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id: null,
      result: { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] },
    },
  }
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
    const response = await callTool({
      bot,
      scope,
      name: Reflect.get(params, 'name'),
      params,
      signal,
    })
    if (response.body && typeof response.body === 'object' && 'result' in response.body) {
      Reflect.set(response.body, 'id', request.id ?? null)
    }
    return response
  }
  return jsonRpcError(request.id, -32601, `Unknown method: ${request.method}`)
}
