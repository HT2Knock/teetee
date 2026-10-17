import path from 'node:path'
import { expect, test } from 'vitest'

import { entryArgv, evalArgv, isTypeScriptEntry, runtimeExecutable, runtimeName, runtimePath } from './runtime.ts'

const jsEntry = path.resolve('dist/cli.js')
const tsEntry = path.resolve('src/cli.ts')

test('runtimeName reports the runtime that loaded this file', () => {
  expect(['bun', 'node']).toContain(runtimeName())
  // The Bun run of the suite sets this, so a green Node run cannot pass for it.
  const expected = process.env['KIMAKI_EXPECT_RUNTIME']
  if (expected) expect(runtimeName()).toBe(expected)
})

test('runtimePath returns the running executable, and finds the other runtime on PATH', () => {
  expect(runtimePath()).toBe(runtimeExecutable())
  expect(runtimePath('node')).toMatch(/node(\.exe)?$/)
})

test('isTypeScriptEntry only accepts the TypeScript extensions', () => {
  expect(isTypeScriptEntry(tsEntry)).toBe(true)
  expect(isTypeScriptEntry(jsEntry)).toBe(false)
})

test('a JavaScript entry needs no loader on either runtime', () => {
  expect(entryArgv(jsEntry, ['status'], { runtime: 'node', executable: '/usr/bin/node' })).toEqual(['/usr/bin/node', jsEntry, 'status'])
  expect(entryArgv(jsEntry, ['status'], { runtime: 'bun', executable: '/usr/bin/bun' })).toEqual(['/usr/bin/bun', jsEntry, 'status'])
})

test('bun runs a TypeScript entry directly, node needs the tsx loader', () => {
  expect(entryArgv(tsEntry, ['--help'], { runtime: 'bun', executable: '/usr/bin/bun' })).toEqual(['/usr/bin/bun', tsEntry, '--help'])
  expect(entryArgv(tsEntry, ['--help'], { runtime: 'node', executable: '/usr/bin/node', tsxLoader: '/pkg/tsx.mjs' })).toEqual([
    '/usr/bin/node',
    '--import',
    '/pkg/tsx.mjs',
    tsEntry,
    '--help',
  ])
})

test('node refuses a TypeScript entry without a loader instead of failing later', () => {
  expect(() => entryArgv(tsEntry, [], { runtime: 'node', executable: '/usr/bin/node' })).toThrow(/tsxLoader/)
})

test('an inline module gets the loader and module input type on node, and neither on bun', () => {
  expect(evalArgv('console.log(1)', { runtime: 'bun', executable: '/usr/bin/bun' })).toEqual(['/usr/bin/bun', '--eval', 'console.log(1)'])
  expect(evalArgv('console.log(1)', { runtime: 'node', executable: '/usr/bin/node', tsxLoader: '/pkg/tsx.mjs' })).toEqual([
    '/usr/bin/node',
    '--import',
    '/pkg/tsx.mjs',
    '--input-type=module',
    '--eval',
    'console.log(1)',
  ])
})
