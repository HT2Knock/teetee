// Prisma client initialization with in-memory libsql.
// Each DigitalDiscord instance gets its own named in-memory database
// so concurrent tests are fully isolated.

import crypto from 'node:crypto'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

let instanceCounter = 0

export function createPrismaClient(dbUrl?: string): PrismaClient {
  // Default: named in-memory DB with mode=memory&cache=shared.
  // - Each instance gets a unique name so concurrent tests are isolated.
  // - cache=shared is required because libsql's transaction() creates a
  //   new Database() internally. Without shared cache, the new connection
  //   gets a separate empty in-memory DB, silently breaking upsert/$transaction.
  // - mode=memory keeps it in-memory (no file on disk).
  // Pass a file: URL (e.g. "file:./test.db") for persistent/debuggable storage.
  const url = dbUrl ?? `file:dd-${process.pid}-${instanceCounter++}?mode=memory&cache=shared`
  const adapter = new PrismaLibSql({ url })
  return new PrismaClient({ adapter })
}
