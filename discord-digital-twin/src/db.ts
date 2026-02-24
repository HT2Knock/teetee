// Prisma client initialization with in-memory libsql.
// Each DigitalDiscord instance gets a fresh database via :memory:
// so tests are fully isolated.

import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

export function createPrismaClient(): PrismaClient {
  const adapter = new PrismaLibSql({ url: 'file::memory:' })
  return new PrismaClient({ adapter })
}
