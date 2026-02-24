// Prisma client initialization with in-memory libsql.
// Each DigitalDiscord instance gets a fresh database via :memory:
// so tests are fully isolated.

import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

export function createPrismaClient(): PrismaClient {
  // cache=shared ensures all connections (including transaction connections)
  // share the same in-memory database. Without it, libsql's transaction()
  // method creates a new Database() which gets a separate empty DB.
  const adapter = new PrismaLibSql({ url: 'file::memory:?cache=shared' })
  return new PrismaClient({ adapter })
}
