// The reducer boundary: thread-reducer.ts must not reach a module that does
// I/O or loads discord.js, even indirectly. reduce() itself is pure by
// inspection; this test keeps its import graph honest so a helper added to a
// slice cannot quietly pull the Discord client or SQLite into the fold.

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { sourceFiles } from '../../test/source-files.ts'

const sourceRoot = path.resolve(import.meta.dirname, '..', '..')

// Modules that must stay outside the reducer's runtime closure.
const FORBIDDEN_MODULES = ['node:fs', 'node:fs/promises', 'node:child_process', 'node:http', 'bun:sqlite', 'discord.js']
// Local modules with I/O or mutable state.
const FORBIDDEN_FILES = ['db.ts', 'store.ts', 'bot.ts', 'logger.ts', 'effects.ts', 'event-loop.ts']

function id(file: string): string {
  return path.relative(sourceRoot, file).replace(/\.ts$/, '')
}

// Runtime imports only: `import type` and `export type` are erased, so they do
// not put a module in the runtime closure. The clause may span several lines.
function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const statement = /(?:^|\n)[ \t]*(?:import|export)\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = statement.exec(source))) {
    if (match[1]) continue
    specifiers.push(match[2] ?? '')
  }
  const dynamic = /import\s*\(\s*['"]([^'"]+)['"]/g
  while ((match = dynamic.exec(source))) specifiers.push(match[1] ?? '')
  return specifiers
}

async function runtimeClosure(entry: string): Promise<Map<string, string[]>> {
  const files = await sourceFiles(sourceRoot)
  const byId = new Map(files.map((file) => [id(file), file]))
  const closure = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.pop() ?? ''
    if (closure.has(current)) continue
    const file = byId.get(current)
    if (!file) continue
    const source = await readFile(file, 'utf8')
    const local = runtimeSpecifiers(source)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => id(path.resolve(path.dirname(file), specifier)))
      .filter((target) => byId.has(target))
    closure.set(current, [...local, ...runtimeSpecifiers(source).filter((specifier) => !specifier.startsWith('.'))])
    queue.push(...local)
  }
  return closure
}

// A path to a module that does I/O or loads the Discord client.
function isForbidden(specifier: string): boolean {
  if (FORBIDDEN_MODULES.includes(specifier)) return true
  const target = path.basename(specifier).replace(/\.ts$/, '')
  return FORBIDDEN_FILES.some((file) => file.replace(/\.ts$/, '') === target)
}

function offendersOf(closure: Map<string, string[]>): string[] {
  return [...closure].flatMap(([module, specifiers]) =>
    specifiers.filter((specifier) => isForbidden(specifier)).map((specifier) => `${module} -> ${specifier}`),
  )
}

describe('reducer boundary', () => {
  test('thread-reducer reaches no I/O module and no discord.js', async () => {
    const closure = await runtimeClosure('features/transcript/thread-reducer')
    // Guard the walker itself: an empty or truncated closure would pass silently.
    expect([...closure.keys()]).toContain('features/transcript/format-parts')
    expect(closure.size).toBeGreaterThan(3)
    expect(offendersOf(closure)).toEqual([])
  })
})
