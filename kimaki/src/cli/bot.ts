// Bot lifecycle and setup: the root command (start + onboarding), provider
// login, and bot status, logs and credentials.
// main.ts, onboarding.ts and SQLite are loaded only by the commands that run
// them (see the note in shared.ts).

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import dedent from 'string-dedent'
import type { Goke } from 'goke'

import { distCliEntry, writeAutostartScript } from '../autostart.ts'
import { BUILTIN_SKILL_IDS, parseDisabledSkills } from '../builtin-skills.ts'
import { callBot, DEFAULT_LOCK_PORT, RESTART_EXIT_CODE, startLockServer } from '../lock-server.ts'
import { parseDuration } from '../duration.ts'
import { createLogger, setLogFile } from '../logger.ts'
import { runtimeExecutable } from '../runtime.ts'
import { action, DATA_DIR_HELP, dataDirOrDefault, discordApi, fail, printJson } from './shared.ts'

const logger = createLogger('CLI')

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
async function supervise(): Promise<never> {
  const state: { child: ChildProcess | null } = { child: null }
  // Ctrl+C reaches both processes; `kill <supervisor pid>` reaches only this one.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => state.child?.kill('SIGTERM'))
  }
  while (true) {
    // Same argv as this supervisor: the Bun runtime flags stay in execArgv,
    // and Bun runs the TypeScript entry directly.
    const child = spawn(runtimeExecutable(), [...process.execArgv, ...process.argv.slice(1)], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, KIMAKI_SUPERVISED: '1' },
    })
    state.child = child
    const code = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        process.stderr.write(`Cannot start the kimaki bot process: ${error.message}\n`)
        resolve(1)
      })
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
    })
    if (code !== RESTART_EXIT_CODE) process.exit(code)
    process.stderr.write('Restarting kimaki...\n')
  }
}

// `kimaki` with no subcommand.
export function registerStartCommand(cli: Goke) {
  cli
    .command('', 'Start the bot. Runs onboarding on first start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-g, --guild <guildId>', 'Server to onboard when the bot is in several')
    .option('--install-url', 'Print the install URL and exit (non-interactive onboarding)')
    .option('--machine-name <name>', 'Name in this machine\'s category "Kimaki <name>" (default: hostname)')
    .option('--restart-onboarding', 'Choose credentials again')
    .option('--worktrees', 'Use a fresh Git worktree for new sessions unless the channel overrides it')
    .option(
      '--allow-all-users',
      'Every server member can use the bot (role "no-kimaki" still denies; provider login stays admin-only)',
    )
    .option(
      '--disable-skills <list>',
      `Built-in Kimaki skills to turn off: "all" or a comma separated list (${BUILTIN_SKILL_IDS.join(',')})`,
    )
    .option('--if-not-running', 'Start only if no bot runs; never stop the running one (used by autostart)')
    .action(async (options) => {
      // The IPC check ignores a KIMAKI_SUPERVISED leaked into a shell by an older bot.
      if (process.env['KIMAKI_SUPERVISED'] !== '1' || !process.connected) return supervise()
      // OpenCode and agent shells inherit process.env: a bot started from a
      // session (tests) would otherwise think it is supervised and SIGTERM itself on restart.
      delete process.env['KIMAKI_SUPERVISED']
      // Bot code loads only here: the other subcommands start without it.
      const [
        { startBot },
        { ensureOpencode, kimakiShellCommand, runOnboarding, startCaffeinate },
        { emitEvent, installUrlFor, readSavedCredentials, resolveCredentials },
        { openDb },
        { opencodeConfigDir },
        { defaultMachineName },
      ] = await Promise.all([
        import('../main.ts'),
        import('../onboarding.ts'),
        import('../credentials.ts'),
        import('../db.ts'),
        import('../adapters/opencode/index.ts'),
        import('../project.ts'),
      ])
      // Non-TTY hosts get the failure as an `error` event too (programmatic onboarding).
      // Explicit type: TS narrows after a `never` call only for annotated consts.
      const failStartup: (error: Error, installUrl?: string) => never = (error, installUrl) => {
        if (!process.stdin.isTTY)
          emitEvent({ type: 'error', message: error.message, ...(installUrl && { install_url: installUrl }) })
        fail(error)
      }
      const dataDir = dataDirOrDefault(options.dataDir)
      const disabledSkills = parseDisabledSkills(options.disableSkills)
      if (disabledSkills instanceof Error) fail(disabledSkills)
      const machine = options.machineName ?? defaultMachineName()

      if (options.installUrl) {
        const opened = await openDb({ dataDir, migrate: true })
        if (opened instanceof Error) fail(opened)
        const credentials = await readSavedCredentials({ db: opened.db })
        await opened.close()
        if (credentials instanceof Error) fail(credentials)
        if (!credentials) fail(new Error('No bot configured yet. Run kimaki first.'))
        process.stdout.write(`${installUrlFor({ credentials })}\n`)
        return
      }

      // Stops a running bot of this port (V1 or V2) before the migration and
      // onboarding, which must not run while it still writes. Before the log
      // reset, so the stopped bot (or the one --if-not-running leaves running) keeps its kimaki.log.
      const lock = await startLockServer({
        port: Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT),
        dataDir,
        supervised: true,
        evict: !options.ifNotRunning,
      })
      if (lock instanceof Error) {
        // Another bot won the race after the plugin's health check.
        if (options.ifNotRunning && lock.cause instanceof Error && Reflect.get(lock.cause, 'code') === 'EADDRINUSE') {
          process.stderr.write(`Kimaki already runs on port ${lock.port}. Nothing to start.\n`)
          process.exit(0)
        }
        failStartup(lock)
      }
      const logFile = setLogFile({ dataDir })
      if (logFile instanceof Error) failStartup(logFile)
      // A crash goes to kimaki.log too (Node still prints it and exits).
      process.on('uncaughtExceptionMonitor', (error, origin) => logger.error(`crash (${origin})`, error))
      const opened = await openDb({ dataDir, migrate: true })
      if (opened instanceof Error) failStartup(opened)

      // Before onboarding: without OpenCode the bot cannot start, so fail (or install it) before the Discord install.
      const opencodeCheck = await ensureOpencode({ serviceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'] })
      if (opencodeCheck instanceof Error) {
        await opened.close()
        failStartup(opencodeCheck)
      }

      startCaffeinate()
      const resolved = await resolveCredentials({
        db: opened.db,
        restartOnboarding: Boolean(options.restartOnboarding),
      })
      // Saved in SQLite, so restarts, crashes and autostart keep it without the flag.
      await opened.close()
      if (resolved instanceof Error) failStartup(resolved)
      const { credentials } = resolved
      const installUrl = installUrlFor({ credentials })
      // The agent calls this same install. Prefer the built dist entry, so agent
      // commands work also when the bot runs from src.
      const distCli = distCliEntry()
      const kimaki = kimakiShellCommand({
        command: fs.existsSync(distCli)
          ? [runtimeExecutable(), distCli]
          : [runtimeExecutable(), ...process.execArgv, process.argv[1] ?? 'kimaki'],
      })

      const bot = await startBot({
        kimakiCommand: kimaki,
        dataDir,
        token: credentials.token,
        appId: credentials.appId,
        lock,
        opencodeServiceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'],
        ensureOpencode: true,
        opencodeConfigDir: opencodeConfigDir(),
        autoWorktrees: Boolean(options.worktrees),
        allowAllUsers: Boolean(options.allowAllUsers),
        disabledSkills,
      })
      if (bot instanceof Error) failStartup(bot)
      // exit() keeps process.exitCode: the restart route sets RESTART_EXIT_CODE before its SIGTERM.
      const shutdown = () => {
        void bot.stop().then(() => process.exit())
      }
      process.once('SIGTERM', shutdown)
      process.once('SIGINT', shutdown)
      // The supervisor died (SIGKILL, crash): nobody owns this bot anymore.
      process.once('disconnect', shutdown)

      const onboarded = await runOnboarding({
        bot,
        dataDir,
        guildId: options.guild,
        installUrl,
        kimaki,
        machine,
      })
      // The bot keeps running; the next start retries onboarding.
      if (onboarded instanceof Error) {
        logger.error(`onboarding failed`, onboarded)
        if (!process.stdin.isTTY)
          emitEvent({
            type: 'error',
            message: `Onboarding failed: ${onboarded.message}. The bot is running; restart kimaki to retry.`,
          })
        return
      }
      if (onboarded)
        process.stderr.write(
          `Onboarding thread: https://discord.com/channels/${onboarded.guildId}/${onboarded.threadId}\n`,
        )
      // Only the default port: the plugin checks that one. Runtime flags only;
      // credentials and onboarding are saved in SQLite.
      if (lock.port === DEFAULT_LOCK_PORT) {
        const autostart = await writeAutostartScript({
          dataDir,
          args: [
            ...(options.worktrees ? ['--worktrees'] : []),
            ...(options.allowAllUsers ? ['--allow-all-users'] : []),
            ...(options.disableSkills ? ['--disable-skills', options.disableSkills] : []),
            ...(options.machineName ? ['--machine-name', options.machineName] : []),
          ],
        })
        if (autostart instanceof Error) logger.warn('cannot write the autostart script', autostart)
      }
      if (!process.stdin.isTTY)
        emitEvent({ type: 'ready', app_id: credentials.appId, guild_ids: [...bot.discord.guilds.cache.keys()] })
    })
}

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
      const { installUrlFor } = await import('../credentials.ts')
      const { credentials } = await discordApi(options.dataDir)
      process.stdout.write(`${installUrlFor({ credentials })}\n`)
    })
}
