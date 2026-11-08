// The root `kimaki` command: the supervisor and the bot start with onboarding.
// This is the one CLI module that opens kimaki.db, because it *is* the bot host
// (migration and credential resolution happen before the bot process exists).
// Every subcommand is an RPC client instead.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'

import type { Goke } from 'goke'

import { distCliEntry, writeAutostartScript } from '../../platform/autostart.ts'
import { BUILTIN_SKILL_IDS, parseDisabledSkills } from '../../platform/builtin-skills.ts'
import { createLogger, setLogFile } from '../../platform/logger.ts'
import { runtimeExecutable } from '../../platform/runtime.ts'
import { DEFAULT_LOCK_PORT, RESTART_EXIT_CODE, startLockServer } from '../http/rpc.ts'

import { DATA_DIR_HELP, dataDirOrDefault, fail } from './shared.ts'

const logger = createLogger('CLI')

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
        import('../../main.ts'),
        import('../../features/projects/onboarding.ts'),
        import('../../features/auth/credentials.ts'),
        import('../../db/db.ts'),
        import('../opencode/index.ts'),
        import('../../features/projects/project.ts'),
      ])
      // Non-TTY hosts get the failure as an `error` event too (programmatic onboarding).
      // Explicit type: TS narrows after a `never` call only for annotated consts.
      const failStartup: (error: Error, installUrl?: string) => never = (error, installUrl) => {
        if (!process.stdin.isTTY) {
          emitEvent({ type: 'error', message: error.message, ...(installUrl && { install_url: installUrl }) })
        }
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
        if (!process.stdin.isTTY) {
          emitEvent({
            type: 'error',
            message: `Onboarding failed: ${onboarded.message}. The bot is running; restart kimaki to retry.`,
          })
        }
        return
      }
      if (onboarded) {
        process.stderr.write(
          `Onboarding thread: https://discord.com/channels/${onboarded.guildId}/${onboarded.threadId}\n`,
        )
      }
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
      if (!process.stdin.isTTY) {
        emitEvent({ type: 'ready', app_id: credentials.appId, guild_ids: [...bot.discord.guilds.cache.keys()] })
      }
    })
}
