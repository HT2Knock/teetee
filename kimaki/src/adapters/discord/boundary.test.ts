// The Discord adapter boundary: discord.js is imported in exactly one place.
// A second import site would let a core module depend on the library's types
// and make the adapter replaceable only by hand.

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { sourceFiles } from '../../test/source-files.ts'

const sourceRoot = path.resolve(import.meta.dirname, '..', '..')

describe('discord adapter boundary', () => {
  test('only src/adapters/discord imports discord.js', async () => {
    const files = await sourceFiles(sourceRoot)
    const offenders: string[] = []
    for (const file of files) {
      const relative = path.relative(sourceRoot, file)
      if (relative.startsWith('adapters/discord/')) continue
      const text = await readFile(file, 'utf8')
      if (/from ['"]discord\.js['"]/.test(text)) offenders.push(relative)
    }
    expect(offenders).toEqual([])
  })
})
