// Row types and the datetime boundary for the local SQLite file. This replaces
// the types Drizzle's schema.ts inferred: one interface per table, with the
// same column names and value types, so call sites read like before.
//
// SQLite stores datetimes as text. Drizzle converted them to Date in the driver
// (a custom type that appends 'Z' to the DDL's 'YYYY-MM-DD HH:MM:SS' default).
// Read paths pass every row through parseRows() so row fields stay Date, and
// write paths send toDbDate(). The tables keep the V1 columns unchanged
// (migrations.ts imports a V1 discord-sessions.db into them).

import type { SQL } from 'bun'

const TABLES = [
  'bot_api_keys',
  'bot_settings',
  'bot_tokens',
  'channel_agents',
  'channel_directories',
  'channel_mention_mode',
  'channel_models',
  'channel_verbosity',
  'channel_worktrees',
  'global_models',
  'guild_categories',
  'scheduled_tasks',
  'session_sleeps',
  'thread_sessions',
] as const

export type TableName = (typeof TABLES)[number]

// openDb() checks these exist before handing the database to callers.
export const REQUIRED_TABLES: string[] = [...TABLES].sort()

// The datetime columns of each table, used by parseRows().
const DATE_FIELDS: Record<TableName, readonly string[]> = {
  bot_api_keys: ['created_at'],
  bot_settings: ['created_at', 'updated_at'],
  bot_tokens: ['created_at', 'last_used_at'],
  channel_agents: ['created_at', 'updated_at'],
  channel_directories: ['created_at'],
  channel_mention_mode: ['created_at', 'updated_at'],
  channel_models: ['created_at', 'updated_at'],
  channel_verbosity: ['updated_at'],
  channel_worktrees: ['created_at', 'updated_at'],
  global_models: ['created_at', 'updated_at'],
  guild_categories: ['created_at'],
  scheduled_tasks: ['run_at', 'next_run_at', 'running_started_at', 'last_run_at', 'created_at', 'updated_at'],
  session_sleeps: ['wake_at', 'last_attempt_at', 'created_at'],
  thread_sessions: ['created_at', 'updated_at'],
}

export type V1Verbosity = 'tools_and_text' | 'text_and_essential_tools' | 'text_only'
export type V1BotMode = 'self_hosted' | 'gateway'
export type V1ChannelType = 'text' | 'voice'
export type ThreadSource = 'kimaki' | 'external_poll'
export type TaskStatus = 'planned' | 'running' | 'completed' | 'cancelled' | 'failed'
export type ScheduleKind = 'at' | 'cron'
export type SleepStatus = 'planned' | 'consumed' | 'cancelled' | 'failed'

export interface ThreadSessionRow {
  thread_id: string
  session_id: string
  source: ThreadSource
  last_synced_name: string | null
  parent_session_id: string | null
  created_at: Date | null
  updated_at: Date | null
}

export interface BotTokenRow {
  app_id: string
  token: string
  bot_mode: V1BotMode
  client_id: string | null
  client_secret: string | null
  proxy_url: string | null
  created_at: Date | null
  last_used_at: Date | null
}

export interface ChannelDirectoryRow {
  channel_id: string
  directory: string
  channel_type: V1ChannelType
  guild_id: string | null
  created_at: Date | null
}

export interface GuildCategoryRow {
  guild_id: string
  category_id: string | null
  audio_category_id: string | null
  created_at: Date | null
}

export interface BotApiKeyRow {
  app_id: string
  gemini_api_key: string | null
  openai_api_key: string | null
  xai_api_key: string | null
  created_at: Date | null
}

export interface BotSettingRow {
  app_id: string
  voice_call_voice: string | null
  created_at: Date | null
  updated_at: Date | null
}

export interface ChannelModelRow {
  channel_id: string
  model_id: string
  variant: string | null
  created_at: Date | null
  updated_at: Date | null
}

export interface GlobalModelRow {
  app_id: string
  model_id: string
  variant: string | null
  created_at: Date | null
  updated_at: Date | null
}

export interface ChannelAgentRow {
  channel_id: string
  agent_name: string
  created_at: Date | null
  updated_at: Date | null
}

export interface ChannelWorktreeRow {
  channel_id: string
  enabled: number
  created_at: Date | null
  updated_at: Date | null
}

export interface ChannelVerbosityRow {
  channel_id: string
  verbosity: V1Verbosity
  updated_at: Date | null
}

export interface ScheduledTaskRow {
  id: number
  status: TaskStatus
  schedule_kind: ScheduleKind
  run_at: Date | null
  cron_expr: string | null
  timezone: string | null
  next_run_at: Date
  running_started_at: Date | null
  last_run_at: Date | null
  last_error: string | null
  attempts: number
  payload_json: string
  prompt_preview: string
  channel_id: string | null
  thread_id: string | null
  session_id: string | null
  project_directory: string | null
  created_at: Date | null
  updated_at: Date | null
}

export interface SessionSleepRow {
  session_id: string
  wake_at: Date
  reason: string | null
  status: SleepStatus
  delivery_id: string
  attempts: number
  last_attempt_at: Date | null
  created_at: Date | null
}

// 'YYYY-MM-DD HH:MM:SS' is UTC (SQLite CURRENT_TIMESTAMP); Drizzle read it the
// same way. ISO strings parse as-is.
function toDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) return new Date(`${value.replace(' ', 'T')}Z`)
  return new Date(value)
}

export function toDbDate(value: Date): string {
  return value.toISOString()
}

// INSERT ... ON CONFLICT(key) DO UPDATE for exactly the given columns, with
// every value bound. Column and table names come from code, never from data.
// Used where the column set is built at runtime (keys a user did or did not
// pass); a fixed set reads better as a plain tagged template. `values` needs at
// least one entry, so the column list is never empty.
export function upsert({
  db,
  table,
  key,
  values,
}: {
  db: SQL
  table: string
  key: { column: string; value: string }
  values: Record<string, string | number | null | Date | undefined>
}): SQL.Query<unknown[]> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  const columns = entries.map(([column]) => column)
  const inserted = entries.map(([, value]) => (value instanceof Date ? toDbDate(value) : value))
  return db.unsafe(
    `INSERT INTO ${table} (${key.column}, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
     ON CONFLICT(${key.column}) DO UPDATE SET ${columns.map((column) => `${column} = ?`).join(', ')}`,
    [key.value, ...inserted, ...inserted],
  )
}

// Converts the datetime columns of the rows a query returned from text to Date.
// `raw` is the row as SQLite returned it (datetime columns are text there).
export function parseRows<T>(table: TableName, raw: readonly unknown[]): T[] {
  return raw.map((value) => {
    const parsed: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const field of DATE_FIELDS[table]) {
      const fieldValue = parsed[field]
      if (typeof fieldValue === 'string') parsed[field] = toDate(fieldValue)
    }
    return parsed as unknown as T
  })
}

// The first row, or undefined when the query returned none (findFirst returned
// undefined too, and callers test with `!row` / `row?.field`).
export function parseFirst<T>(table: TableName, raw: readonly unknown[]): T | undefined {
  return parseRows<T>(table, raw)[0]
}
