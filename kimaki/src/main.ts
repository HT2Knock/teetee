// Bot wiring. Order: lock port (bound by the caller) -> SQLite (migrate) -> OpenCode service and
// Discord login in parallel. The body is one Effect program over the app Layer
// (settings, clock, thread registry). Returns a handle so tests can drive the
// bot in-process and stop it cleanly.

import { setTimeout as sleep } from 'node:timers/promises'
import { Effect, Layer } from 'effect'

import { createDiscordClient, DISCORD_CLOSE_WAIT_MS, loginDiscord } from './adapters/discord/index.ts'

import { createAgentUi } from './agent-ui.ts'
import { oc, type Bot } from './bot.ts'
import { Clock, type ClockShape } from './clock.ts'
import { Database, openDb } from './db.ts'
import { createEffectsRunner } from './effects.ts'
import { createEventLoop } from './event-loop.ts'
import { registerIngress } from './ingress.ts'
import { handleMcp, type McpRequest } from './adapters/http/mcp.ts'
import { removeMcpState, writeMcpState } from './adapters/opencode/mcp-state.ts'
import { runLockRoute } from './adapters/http/routes.ts'
import { installShim, type LockServer } from './adapters/http/rpc.ts'
import { createLogger } from './logger.ts'
import { installPluginShim, watchOpencode, type OpencodeEndpoint } from './adapters/opencode/index.ts'
import { createScheduler } from './scheduler.ts'
import { createEventRecorder, syncSessionTranscript } from './session-events.ts'
import { createPluginWait, refreshCliContext } from './session-context.ts'
import { Settings, type BotSettings } from './settings.ts'
import { createInteractionRegistry, registerSlashCommands } from './slash-commands.ts'
import { createSleepLock } from './sleeps.ts'
import { ThreadRegistry, type BotStore } from './store.ts'

const logger = createLogger('MAIN')

export type StartBotOptions = {
  dataDir: string
  token: string
  // Credentials.appId; must have a bot_tokens row.
  appId: string
  // Bound by the caller before migration and onboarding; startBot owns it from here.
  lock: LockServer
  // discord.js REST `api` URL: the digital twin in tests, null for discord.com.
  // The WebSocket URL comes from GET /gateway/bot on that host.
  discordRestUrl?: string | null
  // Registration file of the OpenCode service. Defaults to the XDG state dir.
  opencodeServiceFile?: string
  // Start the service with Service.ensure() when none is running.
  ensureOpencode: boolean
  // Global OpenCode config dir that gets plugins/kimaki/ (opencodeConfigDir()).
  opencodeConfigDir: string
  // Shell command that runs this install (given to agents), from kimakiShellCommand().
  kimakiCommand: string
  // The scheduler's only source of time. Tests pass a manual clock.
  clock?: ClockShape
  // How often due tasks and wakes run; null: never (tests call scheduler.runDueTasks).
  schedulerIntervalMs?: number | null
  autoWorktrees?: boolean
  allowAllUsers?: boolean
  // Built-in skill ids denied in new sessions (builtin-skills.ts).
  disabledSkills?: readonly string[]
}

export type BotHandle = Bot & {
  lock: LockServer
  // Tests drive scheduling with a manual clock and call this themselves.
  scheduler: { runDueTasks: () => Promise<void> }
  stop: () => Promise<void>
}

// Reverse-order async cleanup, like an AsyncDisposableStack. An Effect
// generator cannot use `await using`, so main.ts keeps its own stack.
class Cleanup {
  private readonly steps: Array<() => unknown> = []

  defer(step: () => unknown): void {
    this.steps.push(step)
  }

  // Idempotent: a failure path and `stop()` cannot run a step twice.
  async dispose(): Promise<void> {
    let first: unknown
    for (const step of this.steps.splice(0).reverse()) {
      try {
        await step()
      } catch (cause) {
        first ??= cause
      }
    }
    if (first !== undefined) throw first
  }
}

// What the CLI options configure, as the Settings service of the app Layer.
function settingsOf(options: StartBotOptions): BotSettings {
  return {
    dataDir: options.dataDir,
    lockPort: options.lock.port,
    restUrl: options.discordRestUrl ?? null,
    appId: options.appId,
    supervised: options.lock.supervised,
    autoWorktrees: options.autoWorktrees ?? false,
    allowAllUsers: options.allowAllUsers ?? false,
    disabledSkills: options.disabledSkills ?? [],
    kimakiCommand: options.kimakiCommand,
    opencodeConfigDir: options.opencodeConfigDir,
  }
}

// Every service a bot start needs, composed here and nowhere else. The
// database is not in this layer: its file must open first, and the bot owns the
// connection until stop(), so it is provided per start (buildBot).
function appLayer(options: StartBotOptions) {
  return Layer.mergeAll(
    Settings.layer(settingsOf(options)),
    options.clock ? Layer.succeed(Clock, options.clock) : Clock.layer,
    ThreadRegistry.layer,
  )
}

type BuildInput = {
  options: StartBotOptions
  settings: BotSettings
  clock: ClockShape
  store: BotStore
  cleanup: Cleanup
  // Resolves the MCP handler that waits for the bot: the plugin may connect
  // while the bot is still starting.
  onBot: (bot: Bot) => void
}

// Everything after the Layer is in place. Errors stay values: the program
// returns them, and startBot disposes the acquired resources before handing
// the error back.
const buildBot = (input: BuildInput) =>
  Effect.gen(function* () {
    const opened = yield* Effect.promise(() => openDb({ dataDir: input.settings.dataDir, migrate: true }))
    if (opened instanceof Error) return opened
    return yield* runBot(input).pipe(Effect.provide(Database.layer(opened)))
  })

const runBot = ({ options, settings, clock, store, cleanup, onBot }: BuildInput) =>
  Effect.gen(function* () {
    const lock = options.lock
    const database = yield* Database
    cleanup.defer(() => database.close())
    const db = database.db
    const query = database.query

    const discord = createDiscordClient({ restUrl: options.discordRestUrl })
    // TODO: await destroy() fully once gateway-proxy uses Fly's `tls` handler. Fly's `http`
    // handler closes a WebSocket's client TCP ~5s after the proxy closed it, and destroy()
    // waits for that TCP close, so Ctrl+C took 5s. The close frames are exchanged by then.
    cleanup.defer(() => Promise.race([discord.destroy(), sleep(DISCORD_CLOSE_WAIT_MS, undefined, { ref: false })]))
    const recorder = createEventRecorder({ dataDir: settings.dataDir })
    cleanup.defer(() => recorder.close())
    const effects = createEffectsRunner({
      discord,
      // Viewed effects come from OpenCode events, so `opencode` below is always set by then.
      markViewed: async ({ sessionId, idle }) => {
        const result = await oc({ opencode }, 'mark session viewed', (client) =>
          client.session.view({ sessionID: sessionId, idle }),
        )
        if (result instanceof Error) return result
      },
    })
    cleanup.defer(() => effects.stop())
    const onTranscriptDue = (sessionId: string) => {
      void oc({ opencode }, 'sync transcript', (client) =>
        syncSessionTranscript({ client, dataDir: settings.dataDir, sessionId }),
      ).then((result) => {
        if (result instanceof Error) logger.warn(`transcript of ${sessionId} not synced`, result)
      })
    }
    const eventLoop = createEventLoop({
      store,
      db,
      discord,
      effects,
      recorder,
      onTranscriptDue,
    })
    const loaded = yield* Effect.promise(() => eventLoop.load())
    if (loaded instanceof Error) return loaded
    // Before the service is used, so a service started by ensure() loads it at once.
    const plugin = yield* Effect.promise(() => installPluginShim({ configDir: settings.opencodeConfigDir }))
    if (plugin instanceof Error) return plugin
    const opencode = watchOpencode({
      serviceFile: options.opencodeServiceFile,
      ensure: options.ensureOpencode,
      onConnect: eventLoop.onConnect,
      onEvent: eventLoop.onEvent,
      onDisconnect: eventLoop.onDisconnect,
    })
    cleanup.defer(() => opencode.stop())
    const shim = yield* Effect.promise(() =>
      installShim({ dataDir: settings.dataDir, command: settings.kimakiCommand }),
    )
    if (shim instanceof Error) return shim
    // The features that non-interaction code reaches through bot.features.
    const agentUi = createAgentUi({ store, eventLoop, opencode })
    cleanup.defer(() => agentUi.stop())
    const bot: Bot = {
      discord,
      db,
      query,
      store,
      opencode,
      eventLoop,
      effects,
      clock,
      dataDir: settings.dataDir,
      lockPort: settings.lockPort,
      restUrl: settings.restUrl,
      supervised: settings.supervised,
      token: options.token,
      appId: settings.appId,
      autoWorktrees: settings.autoWorktrees,
      allowAllUsers: settings.allowAllUsers,
      disabledSkills: settings.disabledSkills,
      features: { withSleepLock: createSleepLock(), waitForPlugin: createPluginWait({ opencode }), agentUi },
    }
    onBot(bot)
    const scheduler = createScheduler({
      bot,
      intervalMs: options.schedulerIntervalMs === undefined ? 5_000 : options.schedulerIntervalMs,
    })
    cleanup.defer(() => scheduler.stop())
    // The HTTP adapter strips /rpc/ (or the older /kimaki/ path).
    lock.handle((route, input, signal) =>
      runLockRoute(bot, { route: route.replace(/^\/(?:rpc|kimaki)\//, ''), input, signal }),
    )

    // Before login: gateway-proxy replays missed messages right after READY.
    registerIngress(bot)

    // Resolves with the first fatal error, or null when both sides are ready.
    // Not Promise.all: a failed side must not wait for the other (Discord login
    // or OpenCode retries can take long), and the other side's "stopped" error
    // would hide the real cause.
    const failure = yield* Effect.promise(
      () =>
        new Promise<Error | null>((resolve) => {
          const pending = { count: 2 }
          const settle = (result: Error | OpencodeEndpoint | void) => {
            if (result instanceof Error) {
              resolve(result)
              return
            }
            pending.count--
            if (pending.count === 0) resolve(null)
          }
          void opencode.ready.then(settle)
          void loginDiscord({ client: discord, token: options.token }).then(settle)
        }),
    )
    if (failure) return failure
    const refreshed = yield* Effect.promise(() => refreshCliContext(bot))
    if (refreshed instanceof Error) return refreshed
    const commands = registerSlashCommands(bot, createInteractionRegistry(), {
      globalDirectory: settings.opencodeConfigDir,
    })
    cleanup.defer(() => commands.stop())
    // Awaited so the handle is only returned once every guild has its commands.
    yield* Effect.promise(() => commands.registerAll())
    // After Discord and OpenCode are ready: a due task needs both.
    const scheduling = yield* Effect.promise(() => scheduler.start())
    if (scheduling instanceof Error) return scheduling
    logger.info(`bot ready as ${discord.user?.tag} in ${discord.guilds.cache.size} server(s)`)
    let stopping: Promise<void> | undefined
    return {
      ...bot,
      lock,
      scheduler: { runDueTasks: scheduler.runDueTasks },
      stop: () => (stopping ??= cleanup.dispose()),
    }
  })

export async function startBot(options: StartBotOptions): Promise<Error | BotHandle> {
  // Each resource registers its cleanup when acquired; dispose runs in reverse
  // (commands and scheduler first, the db and the lock port last). A startup
  // failure disposes it before returning; a started bot moves it into stop().
  const cleanup = new Cleanup()
  cleanup.defer(() => options.lock.close())
  // Before the plugin shim: a plugin that loads while this file is missing has
  // no MCP server until the next OpenCode reload.
  const state = await writeMcpState({
    configDir: options.opencodeConfigDir,
    port: options.lock.port,
    token: options.lock.tokens.control,
  })
  if (state instanceof Error) return state
  cleanup.defer(() => removeMcpState({ configDir: options.opencodeConfigDir }))
  // The plugin can connect before the bot exists. Hold the request until the
  // bot is ready instead of answering 503 and failing the MCP connection.
  const botReady = Promise.withResolvers<Bot>()
  options.lock.mcp(async ({ scope, body, signal }) => {
    const bot = await botReady.promise
    const request = body as Partial<McpRequest> | null
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
      return { status: 400, body: { error: 'Expected a JSON-RPC request with a method' } }
    }
    return handleMcp({ bot, scope, request: request as McpRequest, signal })
  })
  const program = Effect.gen(function* () {
    const settings = yield* Settings
    const clock = yield* Clock
    const store = yield* ThreadRegistry
    return yield* buildBot({ options, settings, clock, store, cleanup, onBot: botReady.resolve })
  }).pipe(
    // A thrown error is a defect and skips the value check below.
    Effect.onError(() => Effect.promise(() => cleanup.dispose())),
  )
  const result = await Effect.runPromise(Effect.provide(program, appLayer(options)))
  if (result instanceof Error) await cleanup.dispose()
  return result
}
