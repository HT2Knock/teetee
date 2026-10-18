import path from 'node:path'
import { expect, test } from 'vitest'

import { entryArgv, evalArgv, RUNTIME_NAME, runtimeExecutable } from './runtime.ts'

const jsEntry = path.resolve('dist/cli.js')
const tsEntry = path.resolve('src/cli.ts')

test('the suite runs on Bun', () => {
  expect(RUNTIME_NAME).toBe('bun')
  // The whole suite runs on Bun, so this fails on any other runtime.
  expect(process.versions['bun']).toBeDefined()
})

test('entryArgv runs a TypeScript or JavaScript entry on the current executable', () => {
  expect(entryArgv(tsEntry, ['--help'])).toEqual([runtimeExecutable(), tsEntry, '--help'])
  expect(entryArgv(jsEntry, ['status'])).toEqual([runtimeExecutable(), jsEntry, 'status'])
  expect(entryArgv(tsEntry, [], { executable: '/usr/bin/bun' })).toEqual(['/usr/bin/bun', tsEntry])
})

test('evalArgv runs an inline module', () => {
  expect(evalArgv('console.log(1)')).toEqual([runtimeExecutable(), '--eval', 'console.log(1)'])
})
