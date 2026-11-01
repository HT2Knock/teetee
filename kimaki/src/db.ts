// SQLite access: file <dataDir>/kimaki.db, queried through the Effect SQL
// client of `@effect/sql-sqlite-bun` (db-client.ts). Only the bot start opens
// with migrate: true (migrations.ts: V1 import + schema). Subcommands open
// without migrating and fail with DbNotMigratedError when the file or a table
// is missing; they never create the file, so the next bot start still imports
// the V1 database.

import fs from 'node:fs'
import path from 'node:path'

import { Context, Layer } from 'effect'

import { openClient, type DbQuery, type KimakiDb } from './db-client.ts'
import { DbError, DbNotMigratedError, attempt } from './errors.ts'
import { DB_FILE, migrateDb } from './migrations.ts'
import { REQUIRED_TABLES, type V1Verbosity } from './rows.ts'

export type { KimakiDb } from './db-client.ts'

export type OpenedDb = {
  db: KimakiDb
  query: DbQuery
  close: () => Promise<void>
}

// The database as a service: main.ts provides it after the file is open, tests
// provide their own with `Layer.succeed(Database, opened)`.
export class Database extends Context.Service<Database, OpenedDb>()('kimaki/Database') {
  static readonly layer = (opened: OpenedDb): Layer.Layer<Database> => Layer.succeed(Database, opened)
}

function dbPath({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, DB_FILE)
}

export async function openDb({
  dataDir,
  migrate,
}: {
  dataDir: string
  migrate: boolean
}): Promise<DbError | DbNotMigratedError | OpenedDb> {
  const created = attempt(
    () => {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dataDir, 0o700)
    },
    (e) => new DbError({ operation: `create ${dataDir}`, cause: e }),
  )
  if (created instanceof Error) return created
  if (migrate) {
    const migrated = await migrateDb({ dataDir })
    if (migrated instanceof Error) return migrated
  }
  if (!fs.existsSync(dbPath({ dataDir }))) return new DbNotMigratedError({ missing: DB_FILE })
  const opened = openClient({ filename: dbPath({ dataDir }) })
  if (opened instanceof Error) return new DbError({ operation: 'open', cause: opened })
  const setup = await (async () => {
    // The client enables WAL and a 5s busy timeout; the pragmas keep the file
    // behaviour the same if a driver default ever changes.
    await opened.db.unsafe('PRAGMA journal_mode = WAL')
    await opened.db.unsafe('PRAGMA busy_timeout = 5000')
    const rows = await opened.db<{ name: string }[]>`SELECT name FROM sqlite_master WHERE type = 'table'`
    return new Set(rows.map((row) => row.name))
  })().catch((e) => new DbError({ operation: 'open', cause: e }))
  if (setup instanceof Error) {
    await opened.close()
    return setup
  }
  const missing = REQUIRED_TABLES.find((table) => !setup.has(table))
  if (missing) {
    await opened.close()
    return new DbNotMigratedError({ missing: `table ${missing}` })
  }
  return { db: opened.db, query: opened.query, close: opened.close }
}

// V2 has two verbosity levels; the V1 enum stays on disk (spec section 17).
export type Verbosity = 'text' | 'tools'

export function verbosityFromV1(value: V1Verbosity | null | undefined): Verbosity {
  if (value === 'text_only') return 'text'
  return 'tools'
}

export function verbosityToV1(value: Verbosity): V1Verbosity {
  if (value === 'text') return 'text_only'
  return 'text_and_essential_tools'
}
