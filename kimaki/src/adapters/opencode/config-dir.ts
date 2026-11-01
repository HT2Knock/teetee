// The OpenCode global config dir and the bot's MCP state file. Kept free of
// bot modules so the OpenCode plugin can import it: the plugin runs in the
// OpenCode process and must not pull in the core, SQLite or discord.js.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Same rule as OpenCode's global config dir (packages/util/src/global-roots.ts).
export function opencodeConfigDir(): string {
  const explicit = process.env['OPENCODE_CONFIG_DIR']
  if (explicit) return path.resolve(explicit)
  const xdg = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config')
  return path.join(xdg, 'opencode')
}

const MCP_STATE_FILE = 'kimaki-mcp.json'

export type McpState = { url: string; token: string }

export function mcpStateFile({ configDir = opencodeConfigDir() }: { configDir?: string } = {}): string {
  return path.join(configDir, MCP_STATE_FILE)
}

// null when the bot has not written the file yet, or it is malformed.
export async function readMcpState(): Promise<McpState | null> {
  const text = await fs.promises.readFile(mcpStateFile(), 'utf8').catch(() => null)
  if (text === null) return null
  const value: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const url = Reflect.get(value, 'url')
  const token = Reflect.get(value, 'token')
  return typeof url === 'string' && typeof token === 'string' ? { url, token } : null
}
