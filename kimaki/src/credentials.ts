// Discord credentials (spec 3, "Credential resolution"). Self-hosted only: the
// user creates their own Discord app and pastes its bot token.
//
// Priority: KIMAKI_BOT_TOKEN env, saved bot_tokens row (most recently used),
// then the wizard. Rows keep the exact V1 shape, so old databases still load;
// gateway rows from an older install are ignored, never selected.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as clack from '@clack/prompts'
import { OAuth2Scopes, PermissionFlagsBits } from 'discord.js'
import dedent from 'string-dedent'

import type { KimakiDb } from './db.ts'
import { ConfigError, DbError } from './errors.ts'
import { createLogger } from './logger.ts'
import { parseRows, upsert, type BotTokenRow } from './rows.ts'

const logger = createLogger('CREDS')
const execFileAsync = promisify(execFile)

export type Credentials = {
  appId: string
  // What discord.js logs in with.
  token: string
}

// Bot tokens start with base64(application id).
function appIdFromToken(token: string): string | null {
  const segment = token.split('.')[0] ?? ''
  const decoded = Buffer.from(segment, 'base64').toString('utf8')
  return /^\d{17,20}$/.test(decoded) ? decoded : null
}

function credentialsFromRow(row: BotTokenRow): Credentials | null {
  if (row.bot_mode !== 'self_hosted') return null
  return row.token ? { appId: row.app_id, token: row.token } : null
}

// KIMAKI_BOT_TOKEN (headless and CI) wins over saved credentials for the bot
// start and for CLI subcommands.
export function envCredentials(): ConfigError | Credentials | null {
  const token = process.env['KIMAKI_BOT_TOKEN']?.trim()
  if (!token) return null
  const appId = appIdFromToken(token)
  if (!appId) return new ConfigError({ reason: 'KIMAKI_BOT_TOKEN is not a Discord bot token' })
  return { appId, token }
}

export async function readSavedCredentials({ db }: { db: KimakiDb }): Promise<DbError | Credentials | null> {
  const rows = await db
    .unsafe<BotTokenRow[]>(
      `SELECT * FROM bot_tokens WHERE bot_mode = 'self_hosted' ORDER BY last_used_at DESC, created_at DESC`,
    )
    .catch((e) => new DbError({ operation: 'read bot_tokens', cause: e }))
  if (rows instanceof Error) return rows
  return parseRows<BotTokenRow>('bot_tokens', rows).map(credentialsFromRow).find((row) => row !== null) ?? null
}

export async function saveCredentials({
  db,
  credentials,
}: {
  db: KimakiDb
  credentials: Credentials
}): Promise<DbError | void> {
  const saved = await upsert({
    db,
    table: 'bot_tokens',
    key: { column: 'app_id', value: credentials.appId },
    values: {
      token: credentials.token,
      bot_mode: 'self_hosted',
      last_used_at: new Date(),
    },
  }).catch((e) => new DbError({ operation: 'save bot_tokens', cause: e }))
  if (saved instanceof Error) return saved
}

const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.AddReactions,
]

export function installUrlFor({ credentials }: { credentials: Credentials }): string {
  const permissions = BOT_PERMISSIONS.reduce((sum, flag) => sum | flag, 0n)
  const params = new URLSearchParams({
    client_id: credentials.appId,
    scope: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '),
    permissions: permissions.toString(),
  })
  return `https://discord.com/oauth2/authorize?${params}`
}

// Non-TTY hosts (cloud sandboxes, CI) read these on stdout. SSE framing, so
// consumers can use eventsource-parser on noisy output.
export type ProgrammaticEvent =
  | { type: 'install_url'; url: string }
  | { type: 'ready'; app_id: string; guild_ids: string[] }
  | { type: 'error'; message: string; install_url?: string }

export function emitEvent(event: ProgrammaticEvent): void {
  process.stdout.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function openInBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  await execFileAsync(command, [url]).catch(() => undefined)
}

async function promptSelfHostedToken(): Promise<ConfigError | Credentials> {
  const developerPage = 'https://discord.com/developers/applications'
  clack.note(
    dedent`
      1. Create an app: ${developerPage}
      2. Bot tab: enable Message Content Intent
      3. Bot tab: Reset Token, then paste it here
    `,
    'Discord bot',
  )
  await openInBrowser(developerPage)
  const token = await clack.password({
    message: 'Bot token',
    validate: (value) => (value && appIdFromToken(value.trim()) ? undefined : 'This does not look like a bot token'),
  })
  if (clack.isCancel(token)) return new ConfigError({ reason: 'Onboarding cancelled' })
  const trimmed = token.trim()
  return { appId: appIdFromToken(trimmed) ?? '', token: trimmed }
}

export type ResolvedCredentials = { credentials: Credentials }

export async function resolveCredentials({
  db,
  restartOnboarding,
}: {
  db: KimakiDb
  restartOnboarding: boolean
}): Promise<ConfigError | DbError | ResolvedCredentials> {
  if (!restartOnboarding) {
    const fromEnv = envCredentials()
    if (fromEnv instanceof Error) return fromEnv
    if (fromEnv) {
      const saved = await saveCredentials({ db, credentials: fromEnv })
      if (saved instanceof Error) return saved
      return { credentials: fromEnv }
    }

    const savedCredentials = await readSavedCredentials({ db })
    if (savedCredentials instanceof Error) return savedCredentials
    if (savedCredentials) {
      // Mark as most recently used, so `project add` picks the same bot.
      const touched = await saveCredentials({ db, credentials: savedCredentials })
      if (touched instanceof Error) return touched
      return { credentials: savedCredentials }
    }
  }

  if (!process.stdin.isTTY) {
    return new ConfigError({
      reason: 'No Discord bot token saved. Set KIMAKI_BOT_TOKEN, or run kimaki in a terminal to paste one.',
    })
  }

  const credentials = await promptSelfHostedToken()
  if (credentials instanceof Error) return credentials
  const saved = await saveCredentials({ db, credentials })
  if (saved instanceof Error) return saved
  process.stderr.write(`\nAdd the bot to your server: ${installUrlFor({ credentials })}\n\n`)
  logger.log(`saved the bot token of app ${credentials.appId}`)
  return { credentials }
}
