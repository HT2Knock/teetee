// Writes the MCP endpoint of this bot, as the OpenCode plugin finds it. The bot
// writes it into the OpenCode config dir before the plugin shim, so plugin
// setup can register the server without a session and without reading
// kimaki.db.
//
// The file is the transport for the control token, not a new secret store: it
// sits next to the plugin shim, mode 0600, in a directory the user owns.

import fs from 'node:fs'

import { ConfigError } from '../../errors.ts'
import { mcpStateFile, type McpState } from './config-dir.ts'

export async function writeMcpState({
  configDir,
  port,
  token,
}: {
  configDir: string
  port: number
  token: string
}): Promise<ConfigError | void> {
  const file = mcpStateFile({ configDir })
  const state: McpState = { url: `http://127.0.0.1:${port}/mcp`, token }
  const written = await fs.promises
    .mkdir(configDir, { recursive: true })
    .then(() => fs.promises.writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 }))
    .then(() => fs.promises.chmod(file, 0o600))
    .catch((cause) => new ConfigError({ reason: `Cannot write ${file}`, cause }))
  return written instanceof Error ? written : undefined
}

export async function removeMcpState({ configDir }: { configDir: string }): Promise<void> {
  await fs.promises.rm(mcpStateFile({ configDir }), { force: true }).catch(() => undefined)
}
