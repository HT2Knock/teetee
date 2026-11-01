// The two tokens of one bot. `control` is this machine: the RPC and every MCP
// tool. `notify` is for other machines: message, upload and button tools only.
// No imports, so the HTTP server and the MCP handler can both read it without a
// cycle.

export type BotTokens = { control: string; notify: string }

export type McpScope = 'control' | 'notify'

export function mcpScopeFor({
  authorization,
  tokens,
}: {
  authorization: string | undefined
  tokens: BotTokens
}): McpScope | null {
  if (authorization === `Bearer ${tokens.control}`) return 'control'
  if (authorization === `Bearer ${tokens.notify}`) return 'notify'
  return null
}
