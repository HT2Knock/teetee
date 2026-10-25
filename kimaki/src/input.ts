// Input that creates or targets a session: the first prompt of a new thread
// (startSession), thread input from every source (dispatch) and `kimaki send`
// with its remote form (send). This layer imports prompt.ts and sessions.ts;
// neither of those imports it, so the graph stays acyclic.

import crypto from 'node:crypto'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Events, MessageFlags, type Message, type TextChannel, type ThreadChannel } from 'discord.js'

import {cliContext, fetchThread, globalModel, oc, parseModel, projectOf, rootSession, routeText, textChannel, threadOfSession, type Author, type Bot, type ModelChoice, type PromptFile} from './bot.ts'
import {ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError} from './errors.ts'
import {NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS} from './format-parts.ts'
import {createLogger} from './logger.ts'
import type {SendInput} from './lock-routes.ts'
import type {OpenCodeClient} from './opencode-server.ts'
import {splitPromptFiles} from './prompt-files.ts'
import {cancelPendingUi, interrupt, prompt, shell, steer} from './prompt.ts'
import {formatEcho} from './queue.ts'
import {noAnswerError, parseRemoteResult, remoteEnvelope, promptFilePath, REMOTE_TIMEOUT_MS, type RemoteResult} from './remote-send.ts'
import {parseTextMessage, type Route} from './routes.ts'
import {parseFirst, type ChannelDirectoryRow} from './rows.ts'
import {disabledSkillRules} from './builtin-skills.ts'
import {
  type ChannelDefaults,
  type ChannelDefaultsRow,
  NO_QUESTION_TOOL,
  agentSelection,
  bindThread,
  channelDefaults,
  ensureSessionMarker,
  putInstructions,
  switchAgent,
  switchModel,
  threadProject,
} from './session-context.ts'
import {forkBtw} from './sessions.ts'
import {cancelSleep} from './sleep-store.ts'
import {attachmentsBlock, type ScheduledRun} from './system-prompt.ts'
import {createWorktree, resolveWorkingDirectory} from './worktrees.ts'

const logger = createLogger('INPUT')

type PermissionRules = NonNullable<NonNullable<Parameters<OpenCodeClient['session']['create']>[0]>['permissions']>

// A model as callers pass it: ModelChoice uses null for "no variant".
type ModelInput = { providerID: string; id: string; variant?: string | null }

// The model shape `session.create` takes: an absent variant, not null.
type SessionModel = { providerID: string; id: string; variant?: string }

// Channel defaults: the project directory plus the one-to-one channel model,
// agent and worktree rows.
async function channelDefaultsOf(bot: Bot, channelId: string) {
  const rows = await bot.db<ChannelDefaultsRow[]>`SELECT channel_directories.*,
      channel_models.model_id AS channel_model_id, channel_models.variant AS channel_model_variant,
      channel_agents.agent_name AS channel_agent_name, channel_worktrees.enabled AS channel_worktree_enabled
    FROM channel_directories
    LEFT JOIN channel_models ON channel_models.channel_id = channel_directories.channel_id
    LEFT JOIN channel_agents ON channel_agents.channel_id = channel_directories.channel_id
    LEFT JOIN channel_worktrees ON channel_worktrees.channel_id = channel_directories.channel_id
    WHERE channel_directories.channel_id = ${channelId} LIMIT 1`
    .catch((cause) => new DbError({ operation: 'read channel defaults', cause }))
  if (rows instanceof Error) return rows
  return channelDefaults(parseFirst<ChannelDefaultsRow>('channel_directories', rows))
}

// Discord only adds the thread creator (the bot); the user must be added to see
// the thread in the sidebar.
async function createSessionThread(
  bot: Bot,
  { channelId, threadName, startMessageId, author }: { channelId: string; threadName: string; startMessageId: string | null; author: Author },
) {
  const channel = await textChannel(bot, channelId)
  if (channel instanceof Error) return channel
  const thread = await channel.threads
    .create({ name: threadName, autoArchiveDuration: 1440, ...(startMessageId && { startMessage: startMessageId }) })
    .catch((cause) => new DiscordError({ operation: 'create thread', cause }))
  if (thread instanceof Error) return thread
  if (author.id !== bot.discord.user?.id) await thread.members.add(author.id).catch((e: Error) => logger.warn(`add member`, e))
  return { channel, thread }
}

// The checkout a new session runs in, when the channel or the flags ask for one.
async function resolveCheckout(
  bot: Bot,
  { requestedDirectory, useWorktree, slug, baseBranch, defaults }: {
    requestedDirectory: string
    useWorktree: boolean
    slug: string
    baseBranch?: string
    defaults: ChannelDefaults | undefined
  },
) {
  if (!useWorktree) return { checkout: null }
  const checkout = await createWorktree({ projectDirectory: defaults?.directory ?? requestedDirectory, dataDir: bot.dataDir, name: slug, baseBranch })
  if (checkout instanceof Error) return checkout
  return { checkout }
}

// Explicit flags win over the channel default, which wins over the agent's own
// model and then the global default.
function pickModel({
  explicitModel,
  agentFlagModel,
  channelModel,
  agentModel,
  global,
}: {
  explicitModel?: ModelInput
  agentFlagModel?: ModelChoice | null
  channelModel?: { model_id: string | null; variant: string | null } | null
  agentModel?: ModelChoice | null
  global: ModelChoice | null
}): ModelChoice | null {
  const channel = channelModel ? parseModel(channelModel.model_id, channelModel.variant) : null
  const picked = explicitModel ?? agentFlagModel ?? channel ?? agentModel ?? global
  return picked ? { providerID: picked.providerID, id: picked.id, variant: picked.variant ?? null } : null
}

// `session.create` takes the provider, id and optional variant only.
function sessionModel(choice: ModelInput | null | undefined): SessionModel | undefined {
  if (!choice) return undefined
  return { providerID: choice.providerID, id: choice.id, ...(choice.variant ? { variant: choice.variant } : {}) }
}

// The agent and model of a new session.
// CRAP here is estimated from export references, without e2e coverage.
// fallow-ignore-next-line complexity
async function resolveAgentAndModel(
  bot: Bot,
  { directory, route, explicitModel, defaults }: {
    directory: string
    route: Exclude<Route, { kind: 'btw' | 'new-session' | 'queue' }>
    explicitModel?: ModelInput
    defaults: ChannelDefaults | undefined
  },
) {
  const requestedAgent = (route.kind === 'steer' && route.agent) || defaults?.channel_agent?.agent_name
  const selected = requestedAgent ? await agentSelection(bot, { directory, agent: requestedAgent }) : null
  if (selected instanceof Error) return selected
  const global = await globalModel(bot)
  if (global instanceof Error) return global
  const choice = pickModel({
    explicitModel,
    // A voice or `--agent` message takes the model that belongs to that agent.
    agentFlagModel: route.kind === 'steer' && route.agent ? selected?.model : null,
    channelModel: defaults?.channel_model ?? null,
    agentModel: selected?.model ?? null,
    global,
  })
  return { model: sessionModel(choice), agent: selected?.agent }
}

// The checkout, plugin, agent and model a new session runs with. Runs while the
// Discord thread is being created.
async function resolveSetup(
  bot: Bot,
  {
    requestedDirectory,
    useWorktree,
    slug,
    baseBranch,
    route,
    explicitModel,
    defaults,
  }: {
    requestedDirectory: string
    useWorktree: boolean
    slug: string
    baseBranch?: string
    route: Exclude<Route, { kind: 'btw' | 'new-session' | 'queue' }>
    explicitModel?: ModelInput
    defaults: ChannelDefaults | undefined
  },
) {
  const checkout = await resolveCheckout(bot, { requestedDirectory, useWorktree, slug, baseBranch, defaults })
  if (checkout instanceof Error) return checkout
  const directory = checkout.checkout?.directory ?? requestedDirectory
  const plugin = await bot.features.waitForPlugin(directory)
  if (plugin instanceof Error) return plugin
  const picked = await resolveAgentAndModel(bot, { directory, route, explicitModel, defaults })
  if (picked instanceof Error) return picked
  return { checkout: checkout.checkout, directory, model: picked.model, agent: picked.agent }
}

// A thread that only sets up a worktree says so; every other thread shows the
// first input when the start message could not carry it.
async function announceStart(
  bot: Bot,
  {
    thread,
    run,
    checkout,
    directory,
    text,
    files,
    author,
    showInput,
  }: {
    thread: ThreadChannel
    run: boolean
    checkout: { branch?: string | null } | null
    directory: string
    text: string
    files: readonly PromptFile[]
    author: Author
    showInput: boolean
  },
) {
  if (!run) {
    return thread
      .send({
        content: `Worktree ready: \`${directory}\`\nBranch: \`${checkout?.branch ?? 'detached'}\`\nSend a message to start working.`,
        allowedMentions: { parse: [] },
        flags: SILENT_MESSAGE_FLAGS,
      })
      .catch((cause) => new DiscordError({ operation: 'post worktree ready', cause }))
  }
  if (!showInput) return
  const names = files.map((file) => file.name).join(', ')
  const shown = names ? `${text}\nFiles: ${names}` : text
  return thread
    .send({ content: formatEcho({ username: author.username, text: shown }), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
    .catch((cause) => new DiscordError({ operation: 'send first input', cause }))
}

// Creates the OpenCode session, writes its instructions entry and binds it to
// the thread. Every step can fail; a failure leaves the thread in place.
async function createBoundSession(
  bot: Bot,
  {
    thread,
    channel,
    channelId,
    directory,
    threadName,
    author,
    model,
    agent,
    permissions,
    parentSessionId,
    task,
    checkout,
  }: {
    thread: ThreadChannel
    channel: TextChannel
    channelId: string
    directory: string
    threadName: string
    author: Author
    model?: SessionModel
    agent?: string
    permissions?: PermissionRules
    parentSessionId?: string
    task?: ScheduledRun
    checkout: { branch?: string | null } | null
  },
) {
  const kimaki = {
    threadId: thread.id,
    channelId,
    source: task ? 'task' : 'discord',
    ...(task && { taskId: task.id, task }),
    ...cliContext(bot),
    ...(parentSessionId && { parentSessionId }),
  }
  const session = await oc(bot, 'session.create', (client) =>
    client.session.create({
      title: threadName,
      location: { directory },
      ...(model && { model }),
      ...(agent && { agent }),
      permissions: [NO_QUESTION_TOOL, ...disabledSkillRules(bot.disabledSkills), ...(permissions ?? [])],
      metadata: { kimaki },
    }),
  )
  if (session instanceof Error) return session
  bot.analytics.track('session_created', { has_worktree: Boolean(checkout), source: 'discord' })
  const instructions = await putInstructions(bot, {
    sessionId: session.id,
    thread,
    channel,
    directory,
    userId: author.id,
    parentSessionId,
    scheduledTask: task ?? null,
  })
  if (instructions instanceof Error) return instructions
  const bound = await bindThread(bot, { threadId: thread.id, sessionId: session.id, channelId, directory, isNew: true })
  if (bound instanceof Error) return bound
  return { sessionId: session.id }
}

// A worktree thread is named after its branch, everything else after the text.
function sessionThreadName(
  { explicitName, useWorktree, slug, text }: { explicitName?: string; useWorktree: boolean; slug: string; text: string },
) {
  if (explicitName) return explicitName
  if (useWorktree) return `⬦ ${slug}`
  return text.replace(/\s+/g, ' ').slice(0, 80) || 'Kimaki session'
}

export async function startSession(
  bot: Bot,
  {
    channelId,
    directory: requestedDirectory,
    route,
    author,
    messageId,
    startMessageId = messageId,
    showInput = startMessageId === null,
    threadName: explicitName,
    files = [],
    model: explicitModel,
    permissions,
    parentSessionId,
    task,
    worktree,
    baseBranch,
    run = true,
  }: {
    channelId: string
    directory: string
    // The first input: a prompt, a shell command or an OpenCode command.
    route: Exclude<Route, { kind: 'btw' | 'new-session' | 'queue' }>
    author: Author
    // The Discord message this input came from; it keys the prompt id.
    messageId: string
    // The thread starts from this message; null for a thread without one.
    startMessageId?: string | null
    // Post the input as the first thread message: the start message does not
    // show it (voice message, or no start message).
    showInput?: boolean
    // Default: the input text, flattened and cut to 80 chars.
    threadName?: string
    files?: readonly PromptFile[]
    // Overrides the channel model for this session.
    model?: ModelInput
    permissions?: PermissionRules
    parentSessionId?: string
    // A scheduled run (scheduler.ts): marks the session as started by this task.
    task?: ScheduledRun
    // undefined uses the channel default; false explicitly reuses an existing cwd.
    worktree?: string | false
    baseBranch?: string
    // false: only set up the thread (/new-worktree), no first input.
    run?: boolean
  },
): Promise<Error | { threadId: string; sessionId: string }> {
  const defaults = await channelDefaultsOf(bot, channelId)
  if (defaults instanceof Error) return defaults
  const text = routeText(route)
  const channelWorktrees = defaults?.channel_worktree ? defaults.channel_worktree.enabled === 1 : bot.autoWorktrees
  const useWorktree = typeof worktree === 'string' || (worktree !== false && channelWorktrees)
  const textSlug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'session'
  const slug = typeof worktree === 'string' && worktree ? worktree : `${textSlug}-${crypto.randomBytes(4).toString('hex')}`
  const threadName = sessionThreadName({ explicitName, useWorktree, slug, text })

  // The thread shows in Discord while the checkout, plugin, agent and model are resolved.
  const creating = createSessionThread(bot, { channelId, threadName, startMessageId, author })
  const setup = await resolveSetup(bot, { requestedDirectory, useWorktree, slug, baseBranch, route, explicitModel, defaults })
  const created = await creating
  if (created instanceof Error) return created
  const { channel, thread } = created
  if (setup instanceof Error) {
    await thread.delete('session setup failed').catch(() => undefined)
    return setup
  }
  const { checkout, directory, model, agent } = setup

  const createdSession = await createBoundSession(bot, {
    thread,
    channel,
    channelId,
    directory,
    threadName,
    author,
    model: sessionModel(model),
    agent,
    permissions,
    parentSessionId,
    task,
    checkout,
  })
  if (createdSession instanceof Error) return createdSession
  const { sessionId } = createdSession
  const announced = await announceStart(bot, { thread, run, checkout, directory, text, files, author, showInput })
  if (announced instanceof Error) return announced
  if (!run) return { threadId: thread.id, sessionId }

  const first = route.kind === 'steer' ? { kind: 'steer' as const, text: route.text } : route
  const sent = await runInSession(bot, {
    sessionId,
    threadId: thread.id,
    threadName,
    directory,
    route: first,
    author,
    messageId,
    files,
  })
  if (sent instanceof Error) return sent
  return { threadId: thread.id, sessionId }
}

// `/name args`: an OpenCode command when the project has it, else plain text.
async function command(
  bot: Bot,
  input: {
    sessionId: string
    threadId: string
    threadName: string
    directory: string
    route: Extract<Route, { kind: 'command' }>
    author: Author
    messageId: string
    files: readonly PromptFile[]
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const { route } = input
  const commands = await oc(bot, 'command.list', (client) => client.command.list({ location: { directory: input.directory } }))
  if (commands instanceof Error) return commands
  const typed = `/${route.name}${route.arguments ? ` ${route.arguments}` : ''}`
  if (!commands.data.some((candidate) => candidate.name === route.name)) {
    if (route.queue) return prompt(bot, { ...input, text: typed, delivery: 'queue' })
    return steer(bot, { ...input, text: typed })
  }
  if (!route.queue) {
    const cancelled = await cancelPendingUi(bot, input.threadId)
    if (cancelled instanceof Error) return cancelled
    const interrupted = await interrupt(bot, input.sessionId)
    if (interrupted instanceof Error) return interrupted
  }
  const { attached, attachments } = await splitPromptFiles(input.files)
  const block = attachmentsBlock(attachments)
  bot.eventLoop.dispatch(input.threadId, { type: 'kimaki.command', text: typed, username: input.author.username })
  const result = await oc(bot, 'session.command', (client) =>
    client.session.command({
      sessionID: input.sessionId,
      name: route.name,
      text: block ? `${route.arguments}\n\n${block}`.trim() : route.arguments,
      files: attached,
      delivery: route.queue ? 'queue' : 'steer',
    }),
  )
  if (result instanceof Error) {
    bot.eventLoop.dispatch(input.threadId, { type: 'kimaki.command-failed' })
    return result
  }
}

// A route for an existing session (every kind that stays in its thread).
async function runInSession(
  bot: Bot,
  {
    sessionId,
    threadId,
    threadName,
    directory,
    route,
    author,
    messageId,
    files,
    echo,
    model,
  }: {
    sessionId: string
    threadId: string
    threadName: string
    directory: string
    route: Exclude<Route, { kind: 'btw' | 'new-session' }>
    author: Author
    messageId: string
    files: readonly PromptFile[]
    echo?: string
    model?: ModelChoice | null
  },
) {
  const base = { sessionId, threadId, threadName, author, messageId, files, echo }
  switch (route.kind) {
    case 'shell':
      return shell(bot, { threadId, sessionId, command: route.command })
    case 'command':
      return command(bot, { ...base, directory, route })
    case 'skill':
      return steer(bot, { ...base, text: route.arguments, skills: [route.id] })
    case 'queue':
      // A queued voice message does not switch the agent: that would change the running turn.
      if (route.agent) logger.log(`ignoring agent ${route.agent} of a queued message`)
      return prompt(bot, { ...base, text: route.text, delivery: 'queue' })
    case 'steer': {
      const agent = route.agent
      if (agent) {
        const switched = await switchAgent(bot, { sessionId, directory, agent, model })
        if (switched instanceof Error) return switched
      }
      return steer(bot, { ...base, text: route.text })
    }
  }
}

// One entry point for thread input of every source (spec 9.4).
export async function dispatch(
  bot: Bot,
  {
    thread,
    route,
    author,
    messageId,
    files = [],
    echo,
    model,
  }: {
    thread: ThreadChannel
    route: Route
    author: Author
    messageId: string
    files?: readonly PromptFile[]
    echo?: string
    model?: ModelChoice | null
  },
) {
  const sessionId = rootSession(bot, thread.id)
  if (sessionId instanceof Error) return sessionId
  // New input supersedes a pending `kimaki sleep` of this session.
  await cancelSleep(bot, sessionId)
  const project = await threadProject(bot, thread)
  if (project instanceof Error) return project
  const marked = await ensureSessionMarker(bot, {
    sessionId,
    thread,
    channelId: project.channelId,
    directory: project.directory,
    userId: author.id,
  })
  if (marked instanceof Error) return marked
  switch (route.kind) {
    case 'btw':
      return forkBtw(bot, { sourceThread: thread, text: route.text, author, messageId, files, agent: route.agent })
    case 'new-session':
      // A fresh thread in the same channel, with no history.
      return startSession(bot, {
        channelId: project.channelId,
        directory: project.directory,
        route: { kind: 'steer', text: route.text, ...(route.agent && { agent: route.agent }) },
        author,
        messageId,
        startMessageId: null,
        files,
      })
    default:
      return runInSession(bot, {
        sessionId,
        threadId: thread.id,
        threadName: thread.name,
        directory: project.directory,
        route,
        author,
        messageId,
        files,
        echo,
        model,
      })
  }
}

// --- `kimaki send` and remote sends.

// The target channel belongs to another machine: post an envelope there and
// wait for that machine's bot to answer with the result (remote-send.ts).
async function remoteSend(bot: Bot, input: SendInput) {
  const targetId = input.threadId ?? input.channelId
  if (!targetId) return new ConfigError({ reason: 'Remote sends require --channel or --thread' })
  const target = await bot.discord.channels
    .fetch(targetId)
    .catch((cause) => new DiscordError({ operation: 'fetch remote target', cause }))
  if (target instanceof Error) return target
  if (!target?.isSendable()) return new ConfigError({ reason: 'Remote target is not sendable' })
  const envelope = remoteEnvelope(input)
  if (envelope instanceof Error) return envelope
  type Result = Error | RemoteResult
  return new Promise<Result>((resolve) => {
    const finish = (result: Result) => {
      clearTimeout(timer)
      bot.discord.off(Events.MessageCreate, receive)
      resolve(result)
    }
    const receive = (message: Message) => {
      if (message.author.id !== bot.discord.user?.id || message.channelId !== targetId) return
      const result = parseRemoteResult({ footer: message.embeds[0]?.footer?.text, requestId: envelope.requestId })
      if (result) finish(result)
    }
    const timer = setTimeout(() => finish(noAnswerError()), REMOTE_TIMEOUT_MS)
    bot.discord.on(Events.MessageCreate, receive)
    void target
      .send({ content: envelope.content, embeds: [{ footer: { text: envelope.footer } }], files: envelope.attachments, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications })
      .catch((cause) => finish(new DiscordError({ operation: 'send remote envelope', cause })))
  })
}

// `localOnly`: never forward to another machine (remote envelopes, scheduled runs).
// `task`: a scheduled run; its input shows as "» routine #N: prompt".
export async function send(bot: Bot, input: SendInput, { localOnly = false, task }: { localOnly?: boolean; task?: ScheduledRun } = {}) {
  const invalid = invalidSend(input)
  if (invalid) return invalid
  const built = sendContext(bot, input, { localOnly, task })
  if (built instanceof Error) return built
  const { context } = built

  // An existing session keeps its thread; everything else starts one.
  if (input.sessionId || input.threadId) return sendToThread(bot, input, context)

  const project = await sendProject(bot, input)
  if (project instanceof Error) return project
  if (!project) return input.channelId && !localOnly ? remoteSend(bot, input) : new ConfigError({ reason: 'No local project channel for this target' })

  if (input.notifyOnly) return sendNotification(bot, project, input, context)
  return sendNewSession(bot, project, input, context)
}

// The author, route and message ID every send path shares.
function sendContext(bot: Bot, input: SendInput, { localOnly, task }: { localOnly: boolean; task?: ScheduledRun }): ConfigError | { context: SendContext } {
  const userIds = (input.user ?? []).map((user) => user.replace(/[<@!>]/g, ''))
  const author = { id: userIds[0] ?? bot.discord.user!.id, username: task ? `routine #${task.id}` : 'CLI' }
  const route = parseTextMessage({ content: input.prompt })
  if (!route) return new ConfigError({ reason: 'Prompt is empty' })
  if (input.agent && (route.kind === 'steer' || route.kind === 'btw')) route.agent = input.agent
  return { context: { author, route, messageId: crypto.randomUUID(), userIds, localOnly, ...(task && { task }) } }
}

// The channel_directories row of --channel or --project; undefined when this
// machine has no channel for the target.
async function sendProject(bot: Bot, input: SendInput) {
  const rows = input.channelId
    ? await bot.db<ChannelDirectoryRow[]>`SELECT * FROM channel_directories WHERE channel_id = ${input.channelId} LIMIT 1`.catch((cause) => new DbError({ operation: 'resolve send project', cause }))
    : await bot.db<ChannelDirectoryRow[]>`SELECT * FROM channel_directories WHERE directory = ${path.resolve(input.project!)} LIMIT 1`.catch((cause) => new DbError({ operation: 'resolve send project', cause }))
  if (rows instanceof Error) return rows
  return parseFirst<ChannelDirectoryRow>('channel_directories', rows)
}

// Flags that must not be combined, checked before any work starts.
// CRAP here is estimated from export references, without e2e coverage.
// fallow-ignore-next-line complexity
function invalidSend(input: SendInput): ConfigError | null {
  if (input.worktree !== undefined && (input.cwd || input.threadId || input.sessionId || input.notifyOnly)) {
    return new ConfigError({ reason: '--worktree requires a new session without --cwd or --notify-only.' })
  }
  if (input.baseBranch && input.worktree === undefined) return new ConfigError({ reason: '--base-branch requires --worktree.' })
  if (input.permissions?.length && (input.threadId || input.sessionId || input.notifyOnly)) {
    return new ConfigError({ reason: '--permission applies only to new sessions. Start a new session without --thread, --session, or --notify-only' })
  }
  return null
}

// `--permission tool[:pattern]:allow|deny|ask`.
function parsePermissions(rules: readonly string[] | undefined): ConfigError | PermissionRules {
  const permissions: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }> = []
  for (const rule of rules ?? []) {
    const parts = rule.split(':')
    const action = parts.shift()
    const effect = parts.pop()
    if (!action || (effect !== 'allow' && effect !== 'deny' && effect !== 'ask')) {
      return new ConfigError({ reason: 'Use --permission tool[:pattern]:allow|deny|ask' })
    }
    permissions.push({ action, resource: parts.join(':') || '*', effect })
  }
  return permissions
}

// Every --user joins the thread; startSession adds the author of a new session itself.
async function addMembers(thread: ThreadChannel, ids: readonly string[]) {
  for (const id of ids) await thread.members.add(id).catch((error: Error) => logger.warn(`add thread member ${id}`, error))
}

type SendContext = {
  author: { id: string; username: string }
  route: Route
  messageId: string
  userIds: readonly string[]
  localOnly: boolean
  task?: ScheduledRun
}

// `--model` on an existing session switches it before the input arrives.
async function switchSendModel(bot: Bot, sessionId: string, requested: string | undefined) {
  if (!requested) return
  const model = parseModel(requested, null)
  if (!model) return new ConfigError({ reason: 'Use --model provider/model' })
  return switchModel(bot, { sessionId, model: { ...model, variant: null } })
}

// CRAP here is estimated from export references, without e2e coverage.
// fallow-ignore-next-line complexity
async function sendToThread(bot: Bot, input: SendInput, context: SendContext) {
  const threadId = input.threadId ?? threadOfSession(bot, input.sessionId!)
  if (!threadId) return new ConfigError({ reason: 'No local thread for this session. Use --thread on its owning machine.' })
  const thread = await fetchThread(bot, threadId)
  if (thread instanceof Error) return thread
  const sessionId = bot.store.getState().roots[thread.id]
  if (!sessionId) {
    const project = thread.parentId ? await projectOf(bot, thread.parentId) : null
    if (project instanceof Error) return project
    return !project && !context.localOnly ? remoteSend(bot, input) : new ConfigError({ reason: 'No local session for this thread' })
  }
  await addMembers(thread, context.userIds)
  const switched = await switchSendModel(bot, sessionId, input.model)
  if (switched instanceof Error) return switched
  const echo = context.task ? formatEcho({ username: context.author.username, text: routeText(context.route) }) : undefined
  const result = await dispatch(bot, { thread, route: context.route, author: context.author, messageId: context.messageId, files: input.files, echo })
  if (result instanceof Error) return result
  return result ?? { threadId, sessionId: bot.store.getState().roots[threadId]! }
}

async function sendNotification(bot: Bot, project: ChannelDirectoryRow, input: SendInput, context: SendContext) {
  const channel = await textChannel(bot, project.channel_id)
  if (channel instanceof Error) return channel
  const thread = await channel.threads
    .create({ name: (input.name ?? input.prompt).replace(/\s+/g, ' ').slice(0, 100), autoArchiveDuration: 1440 })
    .catch((cause) => new DiscordError({ operation: 'create notification thread', cause }))
  if (thread instanceof Error) return thread
  const shown = await thread
    .send({
      content: input.prompt,
      files: input.files?.map((file) => ({ attachment: promptFilePath(file), name: file.name })),
      allowedMentions: { parse: [] },
      flags: NOTIFY_MESSAGE_FLAGS,
    })
    .catch((cause) => new DiscordError({ operation: 'post notification', cause }))
  if (shown instanceof Error) return shown
  await addMembers(thread, context.userIds)
  return { threadId: thread.id, sessionId: null }
}

// --cwd reuses that checkout; a scheduled run gets a fresh worktree name per run.
function worktreeOf(input: SendInput, task: SendContext['task']) {
  if (input.cwd) return false
  if (task && input.worktree) return `${input.worktree.slice(0, 40)}-${crypto.randomBytes(4).toString('hex')}`
  return input.worktree
}

// CRAP here is estimated from export references, without e2e coverage.
// fallow-ignore-next-line complexity
async function sendNewSession(bot: Bot, project: ChannelDirectoryRow, input: SendInput, context: SendContext) {
  const directory = await resolveWorkingDirectory({ projectDirectory: project.directory, candidate: input.cwd ?? project.directory })
  if (directory instanceof Error) return directory
  const permissions = parsePermissions(input.permissions)
  if (permissions instanceof Error) return permissions
  const model = input.model ? parseModel(input.model, null) : null
  if (input.model && !model) return new ConfigError({ reason: 'Use --model provider/model' })
  const route = context.route
  const first = route.kind === 'shell' || route.kind === 'command' || route.kind === 'skill'
    ? route
    : { kind: 'steer' as const, text: route.text, agent: input.agent }
  const worktree = worktreeOf(input, context.task)
  const started = await startSession(bot, {
    channelId: project.channel_id,
    directory,
    route: first,
    author: context.author,
    messageId: context.messageId,
    startMessageId: null,
    threadName: input.name,
    files: input.files,
    permissions,
    parentSessionId: input.parentSessionId,
    task: context.task,
    worktree,
    baseBranch: input.baseBranch,
    ...(model && { model: sessionModel(model) }),
  })
  if (started instanceof Error || context.userIds.length < 2) return started
  const thread = await fetchThread(bot, started.threadId)
  if (thread instanceof Error) logger.warn(`add thread members`, thread)
  else await addMembers(thread, context.userIds.slice(1))
  return started
}
