// Runs the Kimaki suite with `bun test`: the bot and every CLI child process.
//
//   cd kimaki && bun run test
//   cd kimaki && bun run test src/cli-read.e2e.test.ts
//
// Kimaki runs on Bun only. The suite starts the bot and the CLI from source, so
// a green run proves every entrypoint works on Bun.

import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const root = path.resolve(import.meta.dirname, '..')

// A whole-suite timeout, so an unattended run cannot hang forever.
const SUITE_TIMEOUT_MS = 45 * 60_000
// Above the 10s waitFor clamp in the harness, so a slow wait fails with its own label.
const TEST_TIMEOUT_MS = 30_000
// Each e2e file starts its own OpenCode server (~400 MB, CPU-heavy cold start).
// One worker per CPU starts them all at once and the machine thrashes. Cap the
// file workers; KIMAKI_TEST_WORKERS overrides.
const workers = Number(process.env['KIMAKI_TEST_WORKERS']) || Math.max(2, Math.floor(os.availableParallelism() / 3))

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
  if (!process.versions['bun']) {
    process.stderr.write('Kimaki runs on Bun. Install it from https://bun.sh and run `bun run test` again.\n')
    return 1
  }

  const bun = process.execPath
  process.stderr.write(`bun ${process.versions['bun']} at ${bun}\n`)

  const help = await cliPrintsHelp()
  if (help !== 0) return help

  const args = [`test`, `--timeout=${TEST_TIMEOUT_MS}`, `--parallel=${workers}`, ...process.argv.slice(2)]
  // KIMAKI_TEST is also set by the bunfig preload; here so every child process sees it.
  return run(bun, args, { KIMAKI_TEST: '1' })
}

process.exitCode = await main()
