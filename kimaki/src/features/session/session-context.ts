// Session context: the project, thread and instruction facts of a session, and
// the agent/model switches that act on it. These read and write OpenCode, but
// they never send input, so prompt.ts and input.ts can use them without an
// import cycle through sessions.ts.

import path from 'node:path'

import { Effect } from 'effect'

import type { TextChannel, ThreadChannel } from '../../adapters/discord/index.ts'
import type { OpencodeEndpoint } from '../../adapters/opencode/index.ts'
import {
  cliContext,
  ocEffect,
  projectOf,
  readMarker,
  rootSession,
  sessionDirectory,
  textChannel,
  type Bot,
} from '../../bot.ts'
import type { ChannelDirectoryRow } from '../../db/rows.ts'
import { fromResult } from '../../platform/effect-bridge.ts'
import { ConfigError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from '../../platform/errors.ts'
import { createLogger } from '../../platform/logger.ts'
import type { ScheduledRun } from '../routines/scheduled-run.ts'
import type { ModelChoice } from '../settings/model-choice.ts'
import { resolveWorkingDirectory } from '../worktrees/worktrees.ts'

import { baseInstructions, INSTRUCTION_KEY } from './system-prompt.ts'

const logger = createLogger('SESSIONS')

// channel_directories plus its one-to-one channel defaults, what the old
// `with: { channel_model, channel_agent, channel_worktree }` loaded.
export type ChannelDefaultsRow = ChannelDirectoryRow & {
  channel_model_id: string | null
  channel_model_variant: string | null
  channel_agent_name: string | null
  channel_worktree_enabled: number | null
}

// The nested one-to-one defaults the old `with: { channel_model, channel_agent,
// channel_worktree }` loader returned; null when the related row is absent.
export function channelDefaults(row: ChannelDefaultsRow | undefined) {
  if (!row) return undefined
  return {
    ...row,
    channel_model:
      row.channel_model_id === null ? null : { model_id: row.channel_model_id, variant: row.channel_model_variant },
    channel_agent: row.channel_agent_name === null ? null : { agent_name: row.channel_agent_name },
    channel_worktree: row.channel_worktree_enabled === null ? null : { enabled: row.channel_worktree_enabled },
  }
}

export type ChannelDefaults = ReturnType<typeof channelDefaults>

// Kimaki sessions ask with `kimaki buttons`. A wildcard deny removes the tool
// from the model's tool list; forks and subagents inherit it, and later rules
// (`--permission question:allow`) still win.
export const NO_QUESTION_TOOL = { action: 'question', resource: '*', effect: 'deny' } as const

// Project channel, project directory and current cwd of a session thread.
export function threadProject(bot: Bot, thread: ThreadChannel) {
  return Effect.gen(function* () {
    const channelId = thread.parentId
    if (!channelId) {
      return yield* Effect.fail(new DiscordError({ operation: `find the channel of thread ${thread.id}` }))
    }
    const row = yield* projectOf(bot, channelId)
    if (!row) return yield* Effect.fail(new DiscordError({ operation: `find the project of channel ${channelId}` }))
    const sessionId = rootSession(bot, thread.id)
    if (typeof sessionId !== 'string') return yield* Effect.fail(sessionId)
    const directory = yield* sessionDirectory(bot, sessionId)
    return { channelId, projectDirectory: row.directory, directory }
  })
}

// /cwd and `kimaki session cwd`: show the cwd, or move the session to a
// project subfolder or linked worktree.
export function sessionCwd(bot: Bot, { thread, directory }: { thread: ThreadChannel; directory?: string }) {
  return Effect.gen(function* () {
    const project = yield* threadProject(bot, thread)
    if (!directory) return { directory: project.directory }
    const destination = yield* fromResult(() =>
      resolveWorkingDirectory({
        projectDirectory: project.projectDirectory,
        candidate: path.resolve(project.directory, directory),
      }),
    )
    yield* bot.features.waitForPlugin(destination)
    const sessionId = rootSession(bot, thread.id)
    if (typeof sessionId !== 'string') return yield* Effect.fail(sessionId)
    yield* ocEffect(bot, 'session.move', (client) =>
      client.session.move({ sessionID: sessionId, directory: destination, delivery: 'steer' }),
    )
    return { requestedDirectory: destination }
  })
}

// A cold (or evicted) location loads plugin and markdown agents a moment after
// it answers. integration.list waits for that activation.
// TODO: drop this once agent/command/skill.list wait too. https://github.com/anomalyco/opencode/issues/51282
export function catalogReady(
  bot: Pick<Bot, 'opencode'>,
  directory: string,
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return ocEffect(bot, 'integration.list', (client) => client.integration.list({ location: { directory } })).pipe(
    Effect.asVoid,
  )
}

// Agents a session may switch to (not subagents, not hidden ones).
export function primaryAgents(bot: Pick<Bot, 'opencode'>, directory: string) {
  return Effect.gen(function* () {
    yield* catalogReady(bot, directory)
    const agents = yield* ocEffect(bot, 'agent.list', (client) => client.agent.list({ location: { directory } }))
    return agents.data.filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
  })
}

export function agentSelection(bot: Pick<Bot, 'opencode'>, { directory, agent }: { directory: string; agent: string }) {
  return Effect.gen(function* () {
    const agents = yield* primaryAgents(bot, directory)
    const selected = agents.find(
      (candidate) =>
        candidate.id.toLowerCase() === agent.toLowerCase() || candidate.name.toLowerCase() === agent.toLowerCase(),
    )
    if (!selected) {
      return yield* Effect.fail(
        new ConfigError({ reason: `Agent \`${agent}\` is not available in this project. Use /agent to select one.` }),
      )
    }
    const model: ModelChoice | null = selected.model
      ? { ...selected.model, variant: selected.model.variant ?? null }
      : null
    return { agent: selected.id, model }
  })
}

// OpenCode switches the agent and model separately, including the configured variant.
export function switchAgent(
  bot: Bot,
  {
    sessionId,
    directory,
    agent,
    model,
  }: { sessionId: string; directory: string; agent: string; model?: ModelChoice | null },
) {
  return Effect.gen(function* () {
    const selected = yield* agentSelection(bot, { directory, agent })
    const choice = model ?? selected.model
    if (choice) {
      yield* ocEffect(bot, 'session.switchModel', (client) =>
        client.session.switchModel({
          sessionID: sessionId,
          model: { providerID: choice.providerID, id: choice.id, ...(choice.variant && { variant: choice.variant }) },
        }),
      )
    }
    yield* ocEffect(bot, 'session.switchAgent', (client) =>
      client.session.switchAgent({ sessionID: sessionId, agent: selected.agent }),
    )
    return { ...selected, model: choice }
  })
}

// The one durable system instruction of a session (spec 5.4).
export function putInstructions(
  bot: Bot,
  {
    sessionId,
    thread,
    channel,
    directory,
    userId,
    parentSessionId = null,
    scheduledTask = null,
  }: {
    sessionId: string
    thread: ThreadChannel
    channel: TextChannel
    directory: string
    userId: string
    parentSessionId?: string | null
    scheduledTask?: ScheduledRun | null
  },
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    // The agent list is optional prompt context: a failure must not strand the thread.
    const agents = yield* primaryAgents(bot, directory).pipe(
      Effect.match({
        onFailure: (error) => {
          logger.warn(`agent list for instructions failed`, error)
          return [] as Array<{ name: string; description: string }>
        },
        onSuccess: (found) => found.map((agent) => ({ name: agent.id, description: agent.description ?? '' })),
      }),
    )
    const value = baseInstructions({
      sessionId,
      threadId: thread.id,
      channelId: channel.id,
      guildId: channel.guildId,
      userId,
      dataDir: bot.dataDir,
      channelTopic: channel.topic,
      agents,
      parentSessionId,
      scheduledTask,
    })
    yield* ocEffect(bot, 'instructions.entry.put', (client) =>
      client.session.instructions.entry.put({ sessionID: sessionId, key: INSTRUCTION_KEY, value }),
    )
  })
}

export type PluginWait = (
  directory: string,
) => Effect.Effect<void, ConfigError | OpenCodeUnavailableError | OpenCodeError>

// The bot writes plugins/kimaki/ on start (adapters/opencode/index.ts), but
// OpenCode's watcher picks it up a moment later: wait for it, bounded.
// One per bot (bot.features.waitForPlugin).
export function createPluginWait(bot: Pick<Bot, 'opencode'>): PluginWait {
  // Directories where the plugin was seen active, per connection: a reconnect
  // may reach a new OpenCode process, so its endpoint starts with no entries.
  const active = new WeakMap<OpencodeEndpoint, Set<string>>()
  // CRAP is estimated from exports because fallow cannot see e2e coverage.
  // fallow-ignore-next-line complexity
  return (directory) =>
    Effect.gen(function* () {
      const connected = bot.opencode.endpoint
      if (connected && active.get(connected)?.has(directory)) return
      const location = { directory }
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const endpoint = bot.opencode.endpoint
        if (!endpoint) return yield* Effect.fail(new OpenCodeUnavailableError({ reason: 'not connected' }))
        // The integration catalog waits for activations OpenCode already started; plugin.list does not.
        yield* Effect.tryPromise({
          try: () => endpoint.client.integration.list({ location }),
          catch: (cause) => new OpenCodeError({ operation: 'integration.list', cause }),
        })
        const plugins = yield* Effect.tryPromise({
          try: () => endpoint.client.plugin.list({ location }),
          catch: (cause) => new OpenCodeError({ operation: 'plugin.list', cause }),
        })
        const servers = yield* Effect.tryPromise({
          try: () => endpoint.client.mcp.list({ location }),
          catch: (cause) => new OpenCodeError({ operation: 'mcp.list', cause }),
        })
        if (bot.opencode.endpoint !== endpoint) continue
        const pluginActive = plugins.data.some((plugin) => plugin.id === 'kimaki' && plugin.state.status === 'active')
        // Plugin setup registers MCP after the module is active. Waiting for it
        // here keeps the transform's reload out of the first turn.
        const mcpRegistered = servers.data.some((server) => server.name === 'discord')
        if (pluginActive && mcpRegistered) {
          active.set(endpoint, (active.get(endpoint) ?? new Set()).add(directory))
          return
        }
        yield* Effect.sleep(200)
      }
      return yield* Effect.fail(
        new ConfigError({
          reason: `Kimaki plugin is not active in OpenCode for ${directory}. Kimaki writes it to <OpenCode config dir>/plugins/kimaki/ on start; check \`opencode plugin list\` and the OpenCode logs`,
        }),
      )
    })
}

// The plugin and the agent's `kimaki` calls read metadata.kimaki. Sessions
// from V1 (imported thread_sessions) have no marker and no instructions
// entry; sessions of an older bot run point at its old lock port. Checked
// on each input instead of for every binding at startup (a V1 install has
// thousands of bindings).
export function ensureSessionMarker(
  bot: Bot,
  {
    sessionId,
    thread,
    channelId,
    directory,
    userId,
  }: {
    sessionId: string
    thread: ThreadChannel
    channelId: string
    directory: string
    userId: string
  },
): Effect.Effect<void, ConfigError | OpenCodeUnavailableError | OpenCodeError | DiscordError> {
  return Effect.gen(function* () {
    yield* bot.features.waitForPlugin(directory)
    const info = yield* ocEffect(bot, `get session ${sessionId}`, (client) =>
      client.session.get({ sessionID: sessionId }),
    )
    const marker = readMarker(info.metadata)
    if (marker && marker.dataDir === bot.dataDir && marker.lockPort === bot.lockPort) return
    // Instructions first: the marker means "set up", so a failure here is retried on the next input.
    if (!marker) {
      logger.log(`adopting legacy session ${sessionId} of thread ${thread.id}`)
      const channel = yield* textChannel(bot, channelId)
      yield* putInstructions(bot, { sessionId, thread, channel, directory, userId })
    }
    const kimaki = { ...marker?.fields, source: 'discord', ...cliContext(bot), threadId: thread.id, channelId }
    yield* ocEffect(bot, 'session.update', (client) =>
      client.session.update({ sessionID: sessionId, metadata: { ...info.metadata, kimaki } }),
    )
  })
}

// Running sessions of an older bot run point at its lock port; their agent
// can call `kimaki` before the next user input (ensureSessionMarker).
export function refreshCliContext(bot: Bot): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const active = yield* ocEffect(bot, 'session.active', (client) => client.session.active())
    const { sessionThreads } = bot.store.getState()
    for (const sessionId of Object.keys(active).filter((id) => sessionThreads[id])) {
      const info = yield* ocEffect(bot, 'get bound session', (client) =>
        client.session.get({ sessionID: sessionId }),
      ).pipe(
        Effect.match({
          onFailure: (error) => {
            logger.warn(error)
            return null
          },
          onSuccess: (found) => found,
        }),
      )
      if (!info) continue
      const marker = readMarker(info.metadata)
      if (!marker) continue
      if (marker.dataDir === bot.dataDir && marker.lockPort === bot.lockPort) continue
      const metadata = { ...info.metadata, kimaki: { ...marker.fields, ...cliContext(bot) } }
      yield* ocEffect(bot, 'refresh Kimaki CLI context', (client) =>
        client.session.update({ sessionID: sessionId, metadata }),
      )
    }
  })
}

// Applies a model to the running session, with its variant when it has one.
export function switchModel(
  bot: Bot,
  { sessionId, model }: { sessionId: string; model: ModelChoice },
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  const choice = { providerID: model.providerID, id: model.id, ...(model.variant && { variant: model.variant }) }
  return ocEffect(bot, 'session.switchModel', (client) =>
    client.session.switchModel({ sessionID: sessionId, model: choice }),
  ).pipe(Effect.asVoid)
}
