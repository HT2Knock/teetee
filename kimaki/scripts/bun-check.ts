// Runs the Kimaki suite on Bun: the bot and every CLI child process.
//
//   bun run bun:check
//   bun run bun:check -- src/cli-read.e2e.test.ts
//
// Node stays supported. This script only proves the Bun path works, so a
// failure here is a Bun regression, not a change to the default runtime.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

import { runtimeName } from '../src/runtime.ts'

const execFileAsync = promisify(execFile)

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

// A whole-suite timeout, so an unattended run cannot hang forever.
const SUITE_TIMEOUT_MS = 45 * 60_000

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
    const timer = setTimeout(() => {
      process.stderr.write(`${command} did not finish in ${SUITE_TIMEOUT_MS / 60_000} minutes, stopping it\n`)
      child.kill('SIGKILL')
    }, SUITE_TIMEOUT_MS)
    const done = (code: number) => { clearTimeout(timer); resolve(code) }
    child.once('error', (error) => {
      process.stderr.write(`Cannot start ${command}: ${error.message}\n`)
      done(1)
    })
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
  })
}

async function cliPrintsHelp(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['src/cli.ts', '--help'], { cwd: root, timeout: 60_000 })
    if (!stdout.includes('Usage:')) {
      process.stderr.write('bun src/cli.ts --help printed no usage\n')
      return 1
    }
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`bun src/cli.ts --help failed: ${message}\n`)
    return 1
  }
}

async function main(): Promise<number> {
  if (runtimeName() !== 'bun') {
    process.stderr.write(`bun:check must run under Bun, but it is running on ${runtimeName()}\n`)
    return 1
  }

  const bun = process.execPath
  process.stderr.write(`bun ${process.versions['bun']} at ${bun}\n`)

  const help = await cliPrintsHelp()
  if (help !== 0) return help

  // Resolve the vitest entry the way its own npm bin does, then run it on Bun.
  // `bun run test` would execute the sh wrapper, which starts Node.
  const vitestEntry = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const args = ['run', ...process.argv.slice(2), '--config', 'vitest.config.ts']
  // The runtime test asserts this, so a Node run cannot pass for a Bun run.
  return run(bun, [vitestEntry, ...args], { KIMAKI_EXPECT_RUNTIME: 'bun' })
}

process.exitCode = await main()
