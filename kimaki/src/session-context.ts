// Session context: the project, thread and instruction facts of a session, and
// the agent/model switches that act on it. These read and write OpenCode, but
// they never send input, so prompt.ts and input.ts can use them without an
// import cycle through sessions.ts.

import path from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import type {TextChannel, ThreadChannel} from 'discord.js'

import {cliContext, oc, projectOf, readMarker, rootSession, sessionDirectory, textChannel, type Bot, type ModelChoice} from './bot.ts'
import {ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError} from './errors.ts'
import {createLogger} from './logger.ts'
import type {OpencodeEndpoint} from './opencode-server.ts'
import {type ChannelDirectoryRow} from './rows.ts'
import {baseInstructions, INSTRUCTION_KEY, type ScheduledRun} from './system-prompt.ts'
import {resolveWorkingDirectory} from './worktrees.ts'

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
    channel_model: row.channel_model_id === null ? null : { model_id: row.channel_model_id, variant: row.channel_model_variant },
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
export async function threadProject(bot: Bot, thread: ThreadChannel) {
  const channelId = thread.parentId
  if (!channelId) return new DiscordError({ operation: `find the channel of thread ${thread.id}` })
  const row = await projectOf(bot, channelId)
  if (row instanceof Error) return row
  if (!row) return new DiscordError({ operation: `find the project of channel ${channelId}` })
  const sessionId = rootSession(bot, thread.id)
  if (sessionId instanceof Error) return sessionId
  const directory = await sessionDirectory(bot, sessionId)
  if (directory instanceof Error) return directory
  return { channelId, projectDirectory: row.directory, directory }
}

// /cwd and `kimaki session cwd`: show the cwd, or move the session to a
// project subfolder or linked worktree.
export async function sessionCwd(bot: Bot, { thread, directory }: { thread: ThreadChannel; directory?: string }) {
  const project = await threadProject(bot, thread)
  if (project instanceof Error) return project
  if (!directory) return { directory: project.directory }
  const destination = await resolveWorkingDirectory({
    projectDirectory: project.projectDirectory,
    candidate: path.resolve(project.directory, directory),
  })
  if (destination instanceof Error) return destination
  const plugin = await bot.features.waitForPlugin(destination)
  if (plugin instanceof Error) return plugin
  const sessionId = rootSession(bot, thread.id)
  if (sessionId instanceof Error) return sessionId
  const moved = await oc(bot, 'session.move', (client) => client.session.move({ sessionID: sessionId, directory: destination, delivery: 'steer' }))
  if (moved instanceof Error) return moved
  return { requestedDirectory: destination }
}

export async function bindThread(
  bot: Bot,
  { threadId, sessionId, channelId, directory, isNew }: { threadId: string; sessionId: string; channelId: string; directory: string; isNew: boolean },
): Promise<DbError | void> {
  const inserted = await bot.db<unknown[]>`INSERT INTO thread_sessions (thread_id, session_id, source) VALUES (${threadId}, ${sessionId}, ${'kimaki'})`
    .catch((cause) => new DbError({ operation: 'insert thread_sessions', cause }))
  if (inserted instanceof Error) return inserted
  await bot.eventLoop.bind({ threadId, sessionId, channelId, directory, isNew })
  logger.log(`session ${sessionId} bound to thread ${threadId}`)
}

// A cold (or evicted) location loads plugin and markdown agents a moment after
// it answers. integration.list waits for that activation.
// TODO: drop this once agent/command/skill.list wait too. https://github.com/anomalyco/opencode/issues/51282
export async function catalogReady(bot: Pick<Bot, 'opencode'>, directory: string) {
  const ready = await oc(bot, 'integration.list', (client) => client.integration.list({ location: { directory } }))
  if (ready instanceof Error) return ready
}

// Agents a session may switch to (not subagents, not hidden ones).
export async function primaryAgents(bot: Bot, directory: string) {
  const ready = await catalogReady(bot, directory)
  if (ready instanceof Error) return ready
  const agents = await oc(bot, 'agent.list', (client) => client.agent.list({ location: { directory } }))
  if (agents instanceof Error) return agents
  return agents.data.filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
}

export async function agentSelection(bot: Bot, { directory, agent }: { directory: string; agent: string }) {
  const agents = await primaryAgents(bot, directory)
  if (agents instanceof Error) return agents
  const selected = agents.find((candidate) => candidate.id.toLowerCase() === agent.toLowerCase() || candidate.name.toLowerCase() === agent.toLowerCase())
  if (!selected) return new ConfigError({ reason: `Agent \`${agent}\` is not available in this project. Use /agent to select one.` })
  const model: ModelChoice | null = selected.model ? { ...selected.model, variant: selected.model.variant ?? null } : null
  return { agent: selected.id, model }
}

// OpenCode switches the agent and model separately, including the configured variant.
export async function switchAgent(
  bot: Bot,
  { sessionId, directory, agent, model }: { sessionId: string; directory: string; agent: string; model?: ModelChoice | null },
) {
  const selected = await agentSelection(bot, { directory, agent })
  if (selected instanceof Error) return selected
  const choice = model ?? selected.model
  if (choice) {
    const switched = await oc(bot, 'session.switchModel', (client) => client.session.switchModel({
      sessionID: sessionId,
      model: { providerID: choice.providerID, id: choice.id, ...(choice.variant && { variant: choice.variant }) },
    }))
    if (switched instanceof Error) return switched
  }
  const switched = await oc(bot, 'session.switchAgent', (client) => client.session.switchAgent({ sessionID: sessionId, agent: selected.agent }))
  if (switched instanceof Error) return switched
  return { ...selected, model: choice }
}

// The one durable system instruction of a session (spec 5.4).
export async function putInstructions(
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
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  // The agent list is optional prompt context: a failure must not strand the thread.
  const found = await primaryAgents(bot, directory)
  if (found instanceof Error) logger.warn(`agent list for instructions failed`, found)
  // The ID is what switchAgent and session.create take.
  const agents = found instanceof Error ? [] : found.map((agent) => ({ name: agent.id, description: agent.description ?? '' }))
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
  const put = await oc(bot, 'instructions.entry.put', (client) =>
    client.session.instructions.entry.put({ sessionID: sessionId, key: INSTRUCTION_KEY, value }),
  )
  if (put instanceof Error) return put
}

export type PluginWait = (directory: string) => Promise<ConfigError | OpenCodeUnavailableError | OpenCodeError | void>

// The bot writes plugins/kimaki/ on start (opencode-server.ts), but
// OpenCode's watcher picks it up a moment later: wait for it, bounded.
// One per bot (bot.features.waitForPlugin).
export function createPluginWait(bot: Pick<Bot, 'opencode'>): PluginWait {
  // Directories where the plugin was seen active, per connection: a reconnect
  // may reach a new OpenCode process, so its endpoint starts with no entries.
  const active = new WeakMap<OpencodeEndpoint, Set<string>>()
  return async (directory) => {
    const endpoint = bot.opencode.endpoint
    if (endpoint && active.get(endpoint)?.has(directory)) return
    const location = { directory }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const endpoint = bot.opencode.endpoint
      if (!endpoint) return new OpenCodeUnavailableError({ reason: 'not connected' })
      // The integration catalog waits for activations OpenCode already started; plugin.list does not.
      const activated = await endpoint.client.integration.list({ location })
        .catch((cause) => new OpenCodeError({ operation: 'integration.list', cause }))
      if (activated instanceof Error) return activated
      const plugins = await endpoint.client.plugin.list({ location })
        .catch((cause) => new OpenCodeError({ operation: 'plugin.list', cause }))
      if (plugins instanceof Error) return plugins
      if (bot.opencode.endpoint !== endpoint) continue
      if (plugins.data.some((plugin) => plugin.id === 'kimaki' && plugin.state.status === 'active')) {
        active.set(endpoint, (active.get(endpoint) ?? new Set()).add(directory))
        return
      }
      await sleep(200)
    }
    return new ConfigError({
      reason: `Kimaki plugin is not active in OpenCode for ${directory}. Kimaki writes it to <OpenCode config dir>/plugins/kimaki/ on start; check \`opencode plugin list\` and the OpenCode logs`,
    })
  }
}

// The plugin and the agent's `kimaki` calls read metadata.kimaki. Sessions
// from V1 (imported thread_sessions) have no marker and no instructions
// entry; sessions of an older bot run point at its old lock port. Checked
// on each input instead of for every binding at startup (a V1 install has
// thousands of bindings).
export async function ensureSessionMarker(
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
): Promise<ConfigError | OpenCodeUnavailableError | OpenCodeError | DiscordError | void> {
  const plugin = await bot.features.waitForPlugin(directory)
  if (plugin instanceof Error) return plugin
  const info = await oc(bot, `get session ${sessionId}`, (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  const marker = readMarker(info.metadata)
  if (marker && marker.dataDir === bot.dataDir && marker.lockPort === bot.lockPort) return
  // Instructions first: the marker means "set up", so a failure here is retried on the next input.
  if (!marker) {
    logger.log(`adopting legacy session ${sessionId} of thread ${thread.id}`)
    const channel = await textChannel(bot, channelId)
    if (channel instanceof Error) return channel
    const instructions = await putInstructions(bot, { sessionId, thread, channel, directory, userId })
    if (instructions instanceof Error) return instructions
  }
  const kimaki = { ...marker?.fields, source: 'discord', ...cliContext(bot), threadId: thread.id, channelId }
  const updated = await oc(bot, 'session.update', (client) =>
    client.session.update({ sessionID: sessionId, metadata: { ...info.metadata, kimaki } }),
  )
  if (updated instanceof Error) return updated
}

// Running sessions of an older bot run point at its lock port; their agent
// can call `kimaki` before the next user input (ensureSessionMarker).
export async function refreshCliContext(bot: Bot) {
  const active = await oc(bot, 'session.active', (client) => client.session.active())
  if (active instanceof Error) return active
  const { sessionThreads } = bot.store.getState()
  for (const sessionId of Object.keys(active).filter((id) => sessionThreads[id])) {
    const info = await oc(bot, 'get bound session', (client) => client.session.get({ sessionID: sessionId }))
    if (info instanceof Error) {
      logger.warn(info)
      continue
    }
    const marker = readMarker(info.metadata)
    if (!marker) continue
    if (marker.dataDir === bot.dataDir && marker.lockPort === bot.lockPort) continue
    const metadata = { ...info.metadata, kimaki: { ...marker.fields, ...cliContext(bot) } }
    const result = await oc(bot, 'refresh Kimaki CLI context', (client) => client.session.update({ sessionID: sessionId, metadata }))
    if (result instanceof Error) return result
  }
}
// Applies a model to the running session, with its variant when it has one.
export async function switchModel(bot: Bot, { sessionId, model }: { sessionId: string; model: ModelChoice }) {
  const choice = { providerID: model.providerID, id: model.id, ...(model.variant && { variant: model.variant }) }
  const result = await oc(bot, 'session.switchModel', (client) => client.session.switchModel({ sessionID: sessionId, model: choice }))
  if (result instanceof Error) return result
}

