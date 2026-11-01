// Provider login, and bot status, logs and credentials. The root command lives
// in start.ts, the only CLI module that opens kimaki.db.

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Goke } from 'goke'
import dedent from 'string-dedent'

import { parseDuration } from '../../duration.ts'
import { callBot } from '../http/rpc.ts'

import { action, DATA_DIR_HELP, dataDirOrDefault, discordApi, fail, printJson } from './shared.ts'

// null when the file vanished meanwhile (bot restart).
async function readRange({ file, start, end }: { file: string; start: number; end: number }): Promise<Buffer | null> {
  const handle = await fs.promises.open(file, 'r').catch(() => null)
  if (!handle) return null
  const buffer = Buffer.alloc(end - start)
  const read = await handle.read(buffer, 0, buffer.length, start).catch(() => null)
  await handle.close().catch(() => undefined)
  return read ? buffer.subarray(0, read.bytesRead) : null
}

// tail -f that survives the bot truncating the file on restart.
async function followFile(file: string): Promise<never> {
  const position = { offset: 0 }
  while (true) {
    const size = await fs.promises
      .stat(file)
      .then((stat) => stat.size)
      .catch(() => 0)
    if (size < position.offset) position.offset = 0
    if (size > position.offset) {
      const chunk = await readRange({ file, start: position.offset, end: size })
      if (chunk) process.stdout.write(chunk)
      position.offset = size
    }
    await sleep(300)
  }
}

// The root command runs the bot in a child process and starts it again when it
// exits with RESTART_EXIT_CODE (`kimaki restart`), so a restart loads new code:
//
//   kimaki (supervisor) ──spawn, same argv, KIMAKI_SUPERVISED=1──▶ bot
//        ▲                                                         │
//        └──────────── exit 75: spawn again; other code: exit ─────┘
//
// The child shares the terminal (stdio inherit), so onboarding prompts work.
// The IPC channel only exists so the child sees `disconnect` if the supervisor dies.
// login, login credential: OpenCode provider credentials through the bot.
export function registerLoginCommands(cli: Goke) {
  cli
    .command('login <provider>', 'Connect a provider using OpenCode integration credentials')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--key <key>', 'API key to store in OpenCode')
    .option('--method <id>', 'OAuth method ID; without flags, list login methods')
    .option('--attempt <id>', 'Check or complete this native OAuth attempt')
    .option('--code <code>', 'Authorization code for the attempt')
    .option('--cancel', 'Cancel the native OAuth attempt')
    .action(async (provider, options) => {
      await action({
        route: 'login',
        dataDir: options.dataDir,
        input: {
          provider,
          key: options.key,
          method: options.method,
          attempt: options.attempt,
          code: options.code,
          ...(options.cancel && { operation: 'cancel' }),
        },
      })
    })

  cli
    .command('login credential <id>', 'Activate, remove, or label an OpenCode credential')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--operation <name>', 'activate | remove | label')
    .option('--label <text>', 'Credential label')
    .action(async (id, options) => {
      await action({
        route: 'credential',
        dataDir: options.dataDir,
        input: { id, operation: options.operation ?? 'activate', label: options.label },
      })
    })
}

// status, logs, bot token / install-url
export function registerBotCommands(cli: Goke) {
  cli
    .command('status', 'Bot health: running, pid, runtime, uptime, OpenCode URL and version, guilds')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'status', input: {} })
      if (result instanceof Error) {
        process.stdout.write(
          options.json
            ? `${JSON.stringify({ running: false, reason: result.message })}\n`
            : `not running: ${result.message}\n`,
        )
        process.exitCode = 1
        return
      }
      const status = { running: true, ...result.data }
      if (options.json) return printJson(status)
      process.stdout.write(
        dedent`
        running: pid ${status.pid}, up ${status.uptimeSec}s, mode ${JSON.stringify(status.mode)}
        runtime: ${status.runtime}
        opencode: ${JSON.stringify(status.opencode)}
        guilds: ${JSON.stringify(status.guilds)}
        data dir: ${JSON.stringify(status.dataDir)}
      ` + '\n',
      )
    })

  cli
    .command('logs', 'Print the log file path. The bot resets the file on every start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-f, --follow', 'Print the log and keep printing new lines')
    .action(async (options) => {
      const file = path.join(dataDirOrDefault(options.dataDir), 'kimaki.log')
      if (!options.follow) {
        process.stdout.write(`${file}\n`)
        return
      }
      await followFile(file)
    })

  cli
    .command('restart', 'Restart the running bot with the code on disk. Sessions keep running in OpenCode')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'restart', input: {} })
      if (result instanceof Error) fail(result)
      process.stdout.write(`Restarting bot (pid ${result.data.pid})\n`)
    })

  cli
    .command('profile cpu', 'Record a CPU profile of the running bot and print the .cpuprofile path')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-d, --duration <duration>', 'How long to record, e.g. 20s or 2m (default: 20s)')
    .example('kimaki profile cpu --duration 30s')
    .action(async (options) => {
      const durationMs = parseDuration(options.duration ?? '20s', '--duration')
      if (durationMs instanceof Error) fail(durationMs)
      // Ctrl+C stops the recording early; the bot still writes the profile.
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(durationMs + 30_000)])
      process.stderr.write(`Recording for ${options.duration ?? '20s'}. Press Ctrl+C to stop early.\n`)
      const result = await callBot({
        dataDir: dataDirOrDefault(options.dataDir),
        route: 'profile.cpu',
        input: { durationMs },
        signal,
      })
      if (result instanceof Error)
        fail(
          controller.signal.aborted
            ? new Error('Stopped early. The bot writes the profile to <data dir>/profiles/')
            : result,
        )
      process.stdout.write(`${result.data.path}\n`)
    })

  cli
    .command('profile heap', 'Write a heap snapshot of the running bot and print the .heapsnapshot path')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const result = await callBot({
        dataDir: dataDirOrDefault(options.dataDir),
        route: 'profile.heap',
        input: {},
        signal: AbortSignal.timeout(300_000),
      })
      if (result instanceof Error) fail(result)
      process.stdout.write(`${result.data.path}\n`)
    })

  cli
    .command('bot token', 'Print saved bot credentials for automation')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => process.stdout.write(`${(await discordApi(options.dataDir)).credentials.token}\n`))

  cli
    .command('bot install-url', 'Print the Discord bot install URL')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const result = await callBot({
        dataDir: dataDirOrDefault(options.dataDir),
        route: 'bot.credentials',
        input: {},
      })
      if (result instanceof Error) fail(result)
      process.stdout.write(`${result.data.installUrl}\n`)
    })
}
