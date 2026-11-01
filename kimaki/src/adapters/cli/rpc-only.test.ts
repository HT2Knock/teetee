// Phase 3 exit check: the CLI client is pure RPC. It never opens kimaki.db,
// even when the file exists and is not a database. Only start.ts (the bot host
// that migrates and onboards) may touch SQLite.

import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'

import { cliCommand, freePort, tempDataDir } from '../../test/harness.ts'
import { sourceFiles } from '../../test/source-files.ts'

const exec = promisify(execFile)
const cliRoot = path.resolve(import.meta.dirname)
const sourceRoot = path.resolve(cliRoot, '..', '..')

describe('CLI RPC boundary', () => {
  test('only start.ts may open the database', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles(cliRoot)) {
      const relative = path.relative(sourceRoot, file)
      if (relative === path.join('adapters', 'cli', 'start.ts') || file.endsWith('.test.ts')) continue
      const text = await fs.promises.readFile(file, 'utf8')
      // A type-only import of db.ts is erased; every other form opens the file.
      const runtime = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('import type '))
        .join('\n')
      const opensDatabase =
        /\bfrom '[^']*\/(?:db|db-client|migrations)\.ts'/.test(runtime) ||
        /\bimport\(['"][^'"]*\/(?:db|db-client|migrations)\.ts['"]\)/.test(runtime) ||
        /\bfrom 'bun:sqlite'/.test(runtime) ||
        /\bopenDb\(/.test(runtime) ||
        /\bopenCliDb\(/.test(runtime)
      if (opensDatabase) offenders.push(relative)
    }
    expect(offenders).toEqual([])
  })

  test('project list, routine list and bot install-url answer over RPC with a corrupt kimaki.db', async () => {
    const dataDir = tempDataDir()
    const port = await freePort()
    const control = 'test-control-token'
    const requests: string[] = []
    const server = http.createServer((request, response) => {
      const route = (request.url ?? '').replace(/^\/rpc\//, '')
      requests.push(route)
      expect(request.headers.authorization).toBe(`Bearer ${control}`)
      const bodies: Record<string, unknown> = {
        'project.list': [{ channelId: '123', directory: '/tmp/project', guildId: '456' }],
        'routine.list': [],
        'bot.credentials': { appId: '456', token: 'bot-token', installUrl: 'https://example.test/install' },
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(bodies[route]))
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'lock-token'), control)
    // Opening this as a database would throw SQLITE_NOTADB.
    fs.writeFileSync(path.join(dataDir, 'kimaki.db'), 'this is not a sqlite file')
    const run = async (args: string[]) => {
      const result = await exec(...cliCommand([...args, '--data-dir', dataDir]), {
        env: { ...process.env, KIMAKI_LOCK_PORT: String(port) },
      })
      return result.stdout.trim()
    }
    try {
      expect(await run(['project', 'list', '--json'])).toBe(
        JSON.stringify([{ channelId: '123', directory: '/tmp/project', guildId: '456' }], null, 2),
      )
      expect(await run(['routine', 'list', '--json'])).toBe('[]')
      expect(await run(['bot', 'install-url'])).toBe('https://example.test/install')
    } finally {
      server.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
    expect(requests).toEqual(['project.list', 'routine.list', 'bot.credentials'])
  })
})
