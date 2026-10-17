// What runtime is running this process, in one place.
//
// Kimaki runs on Node and on Bun. Bun runs TypeScript directly; Node needs a
// loader for it. Code that spawns a Kimaki entrypoint asks here, instead of
// reading `process.execPath` and `process.execArgv` by hand and assuming Node.

import fs from 'node:fs'
import path from 'node:path'

export type RuntimeName = 'bun' | 'node'

export function runtimeName(): RuntimeName {
  return process.versions['bun'] ? 'bun' : 'node'
}

// The executable that runs this process. Named, so callers do not read it as
// "the node binary".
export function runtimeExecutable(): string {
  return process.execPath
}

// Path to a runtime executable, without spawning a process (spawnSync and
// execSync are banned in this repo). The current runtime is process.execPath;
// the other one comes from PATH.
export function runtimePath(runtime: RuntimeName = runtimeName()): string {
  if (runtime === runtimeName()) return process.execPath
  const names = runtime === 'bun' ? ['bun', 'bun.exe'] : ['node', 'node.exe']
  const found = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => path.join(directory, name)))
    .find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error(`Cannot find the ${runtime} executable on PATH`)
  return found
}

const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']

export function isTypeScriptEntry(entry: string): boolean {
  return TYPESCRIPT_EXTENSIONS.includes(path.extname(entry))
}

// argv that runs `entry`: `[executable, ...args]`.
//
// Bun runs TypeScript directly. Node needs a loader for it, passed as
// `tsxLoader`. Plain JavaScript needs nothing on either runtime, which is the
// shape of the published package: `dist/cli.js` runs on both.
export function entryArgv(
  entry: string,
  args: readonly string[] = [],
  options: { runtime?: RuntimeName; executable?: string; tsxLoader?: string } = {},
): string[] {
  const runtime = options.runtime ?? runtimeName()
  const executable = options.executable ?? runtimePath(runtime)
  if (runtime === 'bun' || !isTypeScriptEntry(entry)) return [executable, entry, ...args]
  return [executable, ...loaderArgs(runtime, options.tsxLoader), entry, ...args]
}

// argv that runs an inline module. Node needs the loader because the code may
// import a `.ts` file, and `--input-type=module` for top level await.
export function evalArgv(
  code: string,
  options: { runtime?: RuntimeName; executable?: string; tsxLoader?: string } = {},
): string[] {
  const runtime = options.runtime ?? runtimeName()
  const executable = options.executable ?? runtimePath(runtime)
  if (runtime === 'bun') return [executable, '--eval', code]
  return [executable, ...loaderArgs(runtime, options.tsxLoader), '--input-type=module', '--eval', code]
}

function loaderArgs(runtime: RuntimeName, tsxLoader: string | undefined): string[] {
  if (runtime === 'bun') return []
  if (!tsxLoader) throw new Error(`Cannot load TypeScript on ${runtime} without a tsxLoader`)
  return ['--import', tsxLoader]
}
