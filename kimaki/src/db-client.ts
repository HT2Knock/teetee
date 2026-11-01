// The SQLite adapter of the bot: the tagged-template client every module uses,
// backed by `@effect/sql-sqlite-bun`.
//
// The public shape is the one Bun's SQL client had (`db\`...\``,
// `db.unsafe(text, params)`, `db.begin(fn)`, `db(list)`), so every query and
// its `T | Error` call site stays unchanged. Phase 4 can turn each call into
// `yield* sql\`...\`` inside the module that owns the query; the connection,
// the error type and the Layer are already Effect's.

import { Cause, Effect, Exit, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-bun'

// The one database handle every module receives. Queries use tagged templates:
// await db`SELECT * FROM thread_sessions WHERE thread_id = ${threadId}`.
// The generic is the whole result, as in Bun's `db<T>`: `db<Row[]>` is `Row[]`.
export type KimakiDb = {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
  unsafe: <T = unknown>(query: string, params?: readonly unknown[]) => Promise<T>
  begin: <T>(run: (tx: KimakiDb) => Promise<T>) => Promise<T>
  // `IN (...)` list helper, as in Bun SQL: db`... IN ${db(ids)}`.
  (values: readonly unknown[]): unknown
}

export type DbClient = {
  db: KimakiDb
  close: () => Promise<void>
}

// Bun SQL binds `undefined` nowhere; SQLite has NULL, so a caller that leaves a
// value out writes NULL (the same value an explicit null writes).
function bind(value: unknown): unknown {
  return value === undefined ? null : value
}

function isTemplate(strings: unknown): strings is TemplateStringsArray {
  return Array.isArray(strings) && 'raw' in strings
}

function makeDb(runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>, client: SqlClient.SqlClient) {
  const run = (effect: Effect.Effect<ReadonlyArray<object>, unknown>) => runtime.runPromise(effect)
  const query = (strings: TemplateStringsArray, values: unknown[]) => run(client(strings, ...values.map(bind)))
  const queryUnsafe = (text: string, params: readonly unknown[] = []) =>
    run(client.unsafe(text, params.map(bind))) as Promise<unknown>

  const callable = (strings: TemplateStringsArray | readonly unknown[], ...values: unknown[]) =>
    isTemplate(strings) ? query(strings, values) : client.in(strings)

  const db = Object.assign(callable, {
    unsafe: queryUnsafe,
    // One connection, so BEGIN/COMMIT on it is the transaction Bun SQL's
    // `begin` gave us. The callback writes through the same handle.
    begin: async <T>(body: (tx: KimakiDb) => Promise<T>): Promise<T> => {
      await queryUnsafe('BEGIN', [])
      try {
        const result = await body(db as unknown as KimakiDb)
        await queryUnsafe('COMMIT', [])
        return result
      } catch (cause) {
        await queryUnsafe('ROLLBACK', []).catch(() => undefined)
        throw cause
      }
    },
  })
  // The callable shape above cannot be typed by construction: the generic
  // result type comes from the call site, as in Bun's own `db<T>`.
  return db as unknown as KimakiDb
}

// Opens one connection to `filename`. The caller closes it with `close`, which
// runs the client's Layer finalizers.
export function openClient({ filename }: { filename: string }): Error | DbClient {
  const runtime = ManagedRuntime.make(SqliteClient.layer({ filename }))
  const exit = runtime.runSyncExit(SqlClient.SqlClient)
  if (Exit.isFailure(exit)) {
    void runtime.dispose()
    const cause = Cause.squash(exit.cause)
    return cause instanceof Error ? cause : new Error(String(cause))
  }
  return { db: makeDb(runtime, exit.value), close: () => runtime.dispose() }
}
