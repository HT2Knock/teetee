// Prisma client initialization with in-memory libsql.
// Vitest runs each test file in a separate worker thread, so all
// instances within the same file share file::memory:?cache=shared
// and cross-file isolation comes from separate processes/threads.

import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

export function createPrismaClient(dbUrl?: string): PrismaClient {
  // cache=shared is required because libsql's transaction() creates a
  // new Database() internally. Without shared cache, the new connection
  // gets a separate empty in-memory DB, silently breaking upsert/$transaction.
  // The old `mode=memory` URL param is not supported by @prisma/adapter-libsql.
  // Pass a file: URL (e.g. "file:./test.db") for persistent/debuggable storage.
  const url = dbUrl ?? 'file::memory:?cache=shared'
  const adapter = new PrismaLibSql({ url })
  return new PrismaClient({ adapter })
}
