// Configuration of one bot, fixed at start: what main.ts reads from the CLI
// options and every module reads from `bot` today. The tag makes the values
// composable in the app Layer, so a unit test can start a bot with
// `Layer.succeed(Settings, testSettings)` instead of a full CLI parse.

import { Context, Layer } from 'effect'

export type BotSettings = {
  dataDir: string
  // Port of this bot's lock server; written into session markers for the agent's `kimaki` calls.
  lockPort: number
  // Control token of the local HTTP server: every RPC route and every MCP tool.
  controlToken: string
  // Notify token: message, upload and button MCP tools only, for other machines.
  notifyToken: string
  // Discord REST base URL when it is not discord.com (tests use the twin).
  restUrl: string | null
  // bot_tokens.app_id of these credentials: key of the global_models row.
  appId: string
  // Started by the `kimaki` supervisor: `kimaki restart` can respawn it.
  supervised: boolean
  // Default for channels without a channel_worktrees row.
  autoWorktrees: boolean
  // --allow-all-users: every guild member can use the bot (canUseKimaki).
  allowAllUsers: boolean
  // Built-in skill ids (builtin-skills.ts) denied through the permissions of new sessions.
  disabledSkills: readonly string[]
  // Shell command that runs this install (given to agents), from kimakiShellCommand().
  kimakiCommand: string
  // Global OpenCode config dir that gets plugins/kimaki/ (opencodeConfigDir()).
  opencodeConfigDir: string
}

export class Settings extends Context.Service<Settings, BotSettings>()('kimaki/Settings') {
  static readonly layer = (settings: BotSettings): Layer.Layer<Settings> => Layer.succeed(Settings, settings)
}
