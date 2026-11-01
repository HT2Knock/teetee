// Sessions and their threads: the only module that creates session threads
// and binds sessions to them (spec 27.2). New sessions, /resume, /fork,
// /fork-subagent, btw forks, the session marker and the instructions entry.

import type { SessionMetadata } from '@opencode/client'
import { Effect } from 'effect'

import type { TextChannel, ThreadChannel } from './adapters/discord/index.ts'
import type { OpenCodeClient } from './adapters/opencode/index.ts'
import {
  cliContext,
  ocEffect,
  projectOf,
  readMarker,
  rootSession,
  sessionDirectory,
  textChannel,
  type Author,
  type Bot,
  type PromptFile,
} from './bot.ts'
import { disabledSkillRules } from './builtin-skills.ts'
import { fromResult } from './effect-bridge.ts'
import { ConfigError, type DbError, DiscordError, type OpenCodeError, type OpenCodeUnavailableError } from './errors.ts'
import { SILENT_MESSAGE_FLAGS } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { prompt } from './prompt.ts'
import { parseRows, type ChannelDirectoryRow } from './rows.ts'
import { NO_QUESTION_TOOL, bindThread, putInstructions, switchAgent, threadProject } from './session-context.ts'
import { type ScheduledRun } from './system-prompt.ts'
import { createWorktree, resolveWorkingDirectory } from './worktrees.ts'

const logger = createLogger('SESSIONS')

type PermissionRules = NonNullable<NonNullable<Parameters<OpenCodeClient['session']['create']>[0]>['permissions']>

// A session this module can bind to a new thread: a resumed one or a fresh fork.
type AdoptableSession = {
  id: string
  metadata?: SessionMetadata
  permissions?: PermissionRules
  location: { directory: string }
}

function discord<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, DiscordError> {
  return Effect.tryPromise({ try: run, catch: (cause) => new DiscordError({ operation, cause }) })
}

function btwPrompt({
  text,
  parentSessionId,
  sourceThreadId,
  sessionId,
  threadId,
}: {
  text: string
  parentSessionId: string
  sourceThreadId: string
  sessionId: string
  threadId: string
}): string {
  return [
    'The user asked a side question while you were working on another task.',
    'This is a forked session whose ONLY goal is to answer this question.',
    'Do NOT continue, resume, or reference the previous task. Only answer the question below.',
    '',
    `Parent session: ${parentSessionId} (thread <#${sourceThreadId}>)`,
    'Do NOT send messages to the parent session unless the user explicitly asks you to.',
    // The instructions entry is copied from the parent (prompt cache); these IDs win.
    `This fork has its own IDs: OpenCode session ${sessionId}, Discord thread ${threadId}.`,
    '',
    text,
  ].join('\n')
}

// --- Sessions that get a new thread: /resume, /fork, /fork-subagent, btw.

// Everything a thread needs before the DB batch: intro, marker, instructions,
// history. The caller deletes the thread when this fails.
function prepareAdoption({
  bot,
  thread,
  channel,
  session,
  intro,
  author,
  parentSessionId,
  scheduledTask,
}: {
  bot: Bot
  thread: ThreadChannel
  channel: TextChannel
  session: AdoptableSession
  intro: string
  author: Author
  parentSessionId: string | null
  scheduledTask: ScheduledRun | null
}) {
  return Effect.gen(function* () {
    const sessionId = session.id
    yield* discord('send intro', () =>
      thread.send({ content: intro.slice(0, 2_000), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS }),
    )
    // Merge: other metadata stays. Task fields stay only for a resumed task session.
    const { task: _task, taskId: _taskId, ...rest } = readMarker(session.metadata)?.fields ?? {}
    const marker = scheduledTask ? { ...rest, taskId: scheduledTask.id, task: scheduledTask } : rest
    const kimaki = {
      ...marker,
      source: scheduledTask ? 'task' : 'discord',
      ...cliContext(bot),
      threadId: thread.id,
      channelId: channel.id,
    }
    // A session with its own question rule (a fork, or --permission) keeps it.
    const rules = session.permissions ?? []
    const permissions = rules.some((rule) => rule.action === 'question')
      ? rules
      : [NO_QUESTION_TOOL, ...disabledSkillRules(bot.disabledSkills), ...rules]
    yield* ocEffect(bot, 'session.update', (client) =>
      client.session.update({ sessionID: sessionId, metadata: { ...session.metadata, kimaki }, permissions }),
    )
    yield* putInstructions(bot, {
      sessionId,
      thread,
      channel,
      directory: session.location.directory,
      userId: author.id,
      parentSessionId,
      scheduledTask,
    })
    const messages = yield* ocEffect(bot, 'message.list', (client) =>
      client.message.list({ sessionID: sessionId, order: 'desc', limit: 100 }),
    )
    // One thread per session: older threads of this session stop following it.
    const previous = yield* bot.query('move thread_sessions', (sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const deleted = yield* sql<{
            thread_id: string
          }>`DELETE FROM thread_sessions WHERE session_id = ${sessionId} RETURNING thread_id`
          yield* sql`INSERT INTO thread_sessions (thread_id, session_id, source) VALUES (${thread.id}, ${sessionId}, ${'kimaki'})`
          return deleted
        }),
      ),
    )
    return { history: [...messages.data].reverse(), previous: previous.map((row) => row.thread_id) }
  })
}

// The caller deletes the thread and the fork when anything before the binding fails.
function discardThread({ thread, discard }: { thread: ThreadChannel; discard?: () => Effect.Effect<void> }) {
  return Effect.gen(function* () {
    yield* Effect.promise(() => thread.delete('session adoption failed').catch(() => undefined))
    if (discard) yield* discard()
  })
}

// Binds an existing session to a new thread. Order matters:
//
//   thread + intro ─▶ metadata + instructions (new IDs) ─▶ history
//     ─▶ one DB batch: old bindings out, new one in ─▶ routing + replay (same tick)
//     ─▶ hydrate what it runs and waits on now
//
// Nothing routes to the thread before the replay, so live output follows
// it. A failure before the binding deletes the new thread (and calls
// `discard`), leaving any old binding untouched.
function adoptSession(
  bot: Bot,
  {
    channel,
    session,
    threadName,
    intro,
    note,
    author,
    parentSessionId = null,
    scheduledTask = null,
    discard,
  }: {
    channel: TextChannel
    session: AdoptableSession
    threadName: string
    intro: string
    note: string
    author: Author
    // Explicit `kimaki send --parent-session` of a resumed session; never a fork's OpenCode parent.
    parentSessionId?: string | null
    // A resumed task session keeps its task; a fork is a new user session.
    scheduledTask?: ScheduledRun | null
    // Cleanup of a session created only for this thread (a fork).
    discard?: () => Effect.Effect<void>
  },
): Effect.Effect<
  { threadId: string; sessionId: string },
  OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError
> {
  return Effect.gen(function* () {
    const sessionId = session.id
    const thread = yield* discord<ThreadChannel>('create thread', () =>
      channel.threads.create({ name: threadName.replace(/\s+/g, ' ').slice(0, 100), autoArchiveDuration: 1440 }),
    )
    const prepared = yield* prepareAdoption({
      bot,
      thread,
      channel,
      session,
      intro,
      author,
      parentSessionId,
      scheduledTask,
    }).pipe(Effect.tapError(() => discardThread({ thread, discard })))

    for (const previousThread of prepared.previous) bot.eventLoop.unbind(previousThread)
    yield* Effect.promise(() =>
      bot.eventLoop.bind({
        threadId: thread.id,
        sessionId,
        channelId: channel.id,
        directory: session.location.directory,
        isNew: false,
        first: [{ type: 'kimaki.replay', messages: prepared.history, note }],
      }),
    )
    logger.log(`session ${sessionId} bound to thread ${thread.id}`)
    yield* Effect.promise(() => thread.members.add(author.id).catch((e: Error) => logger.warn(`add member`, e)))
    yield* fromResult(() => bot.eventLoop.syncThread(thread.id)).pipe(
      Effect.match({
        onFailure: (error) => logger.warn(`hydrate ${thread.id}`, error),
        onSuccess: () => null,
      }),
    )
    return { threadId: thread.id, sessionId }
  })
}

// The project channel whose directory holds this session.
export function channelForSession(bot: Bot, sessionId: string) {
  return Effect.gen(function* () {
    const directory = yield* sessionDirectory(bot, sessionId)
    return yield* channelForDirectory(bot, directory)
  })
}

export function channelForDirectory(bot: Bot, directory: string): Effect.Effect<string, ConfigError | DbError> {
  return Effect.gen(function* () {
    const rows = yield* bot.query(
      'read channel_directories',
      (sql) => sql<ChannelDirectoryRow>`SELECT * FROM channel_directories`,
    )
    const projects = parseRows<ChannelDirectoryRow>('channel_directories', rows)
    projects.sort((a, b) => b.directory.length - a.directory.length)
    // Stored directories may be symlink aliases of the real path.
    const matches = yield* Effect.forEach(
      projects,
      (row) =>
        fromResult(() => resolveWorkingDirectory({ projectDirectory: row.directory, candidate: directory })).pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        ),
      { concurrency: 'unbounded' },
    )
    const project = projects.find((_, index) => matches[index])
    if (!project) {
      return yield* Effect.fail(new ConfigError({ reason: `No project channel for ${directory}. Pass --channel.` }))
    }
    return project.channel_id
  })
}

// Binds an existing session of the channel's project to a new thread.
export function resume(
  bot: Bot,
  { channelId, sessionId, author }: { channelId: string; sessionId: string; author: Author },
) {
  return Effect.gen(function* () {
    const [channel, project] = yield* Effect.all([textChannel(bot, channelId), projectOf(bot, channelId)], {
      concurrency: 'unbounded',
    })
    if (!project) {
      return yield* Effect.fail(new ConfigError({ reason: 'This channel is not configured with a project directory' }))
    }
    const info = yield* ocEffect(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
    const allowed = yield* fromResult(() =>
      resolveWorkingDirectory({ projectDirectory: project.directory, candidate: info.location.directory }),
    ).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
    if (!allowed) {
      return yield* Effect.fail(
        new ConfigError({
          reason: `This session belongs to a different project or worktree: \`${info.location.directory}\`. Run \`/resume\` in the channel for that directory.`,
        }),
      )
    }
    const title = info.title ?? 'Untitled'
    const marker = readMarker(info.metadata)
    const adopted = yield* adoptSession(bot, {
      channel,
      session: info,
      parentSessionId: marker?.parentSessionId ?? null,
      scheduledTask: marker?.task ?? null,
      threadName: `Resume: ${title}`,
      intro: `**Resumed session:** ${title}\n**Created:** <t:${Math.floor(info.time.created / 1_000)}:f>`,
      note: '**Session resumed!** You can now continue the conversation by sending messages in this thread.',
      author,
    })
    return { ...adopted, title }
  })
}

// Forks the thread's session (or one of its subagent sessions) into a new
// thread. `before`: a user message ID; the fork ends right before it.
export function fork(
  bot: Bot,
  {
    sourceThread,
    sessionId,
    before,
    subagent,
    name,
    author,
    worktree,
  }: {
    sourceThread: ThreadChannel
    sessionId: string
    before?: string
    // Thread name; default is OpenCode's fork title.
    name?: string
    // Set when forking a subagent session: its agent and task.
    subagent?: { agent: string; description: string }
    author: Author
    // Move the fork into a new worktree (/new-worktree in a thread).
    worktree?: { name: string; baseBranch?: string }
  },
) {
  return Effect.gen(function* () {
    const root = rootSession(bot, sourceThread.id)
    if (typeof root !== 'string') return yield* Effect.fail(root)
    if (sessionId !== root) {
      const info = yield* ocEffect(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
      if (info.parentID !== root) {
        return yield* Effect.fail(
          new ConfigError({
            reason:
              "This session is not the thread's root or a direct subagent. Run /fork or /fork-subagent in the session's own thread.",
          }),
        )
      }
    }
    const project = yield* threadProject(bot, sourceThread)
    const channel = yield* textChannel(bot, project.channelId)
    const forked = yield* ocEffect(bot, 'session.fork', (client) =>
      client.session.fork({ sessionID: sessionId, ...(before && { before }) }),
    )
    const discard = () =>
      ocEffect(bot, 'session.remove', (client) => client.session.remove({ sessionID: forked.id })).pipe(
        Effect.match({
          onFailure: (error) => logger.warn(`discard fork ${forked.id}`, error),
          onSuccess: () => null,
        }),
      )
    const relocated = yield* Effect.gen(function* () {
      if (!worktree) return forked
      const checkout = yield* fromResult(() =>
        createWorktree({
          projectDirectory: project.projectDirectory,
          dataDir: bot.dataDir,
          name: worktree.name,
          baseBranch: worktree.baseBranch,
        }),
      )
      yield* bot.features.waitForPlugin(checkout.directory)
      yield* ocEffect(bot, 'move worktree fork', (client) =>
        client.session.move({ sessionID: forked.id, directory: checkout.directory }),
      )
      yield* ocEffect(bot, 'wait for worktree fork move', (client) => client.session.wait({ sessionID: forked.id }))
      const info = yield* ocEffect(bot, 'confirm worktree fork directory', (client) =>
        client.session.get({ sessionID: forked.id }),
      )
      if (info.location.directory !== checkout.directory) {
        return yield* Effect.fail(
          new ConfigError({ reason: `Session did not move to ${checkout.directory}. No new thread was bound.` }),
        )
      }
      return info
    }).pipe(Effect.tapError(() => discard()))
    const intro = subagent
      ? `**Forked subagent session created!**\nAgent: \`${subagent.agent}\`\nTask: ${subagent.description || 'No description'}\nFrom: \`${sessionId}\`\nNew session: \`${forked.id}\``
      : `**Forked session created!**\nFrom: <#${sourceThread.id}> (\`${sessionId}\`)\nNew session: \`${forked.id}\``
    return yield* adoptSession(bot, {
      channel,
      session: relocated,
      discard,
      // OpenCode titles forks "<title> (fork #1)".
      threadName: name ?? (forked.title || `Fork: ${subagent?.description || sourceThread.name}`),
      intro,
      note: 'You can now continue the conversation from this point.',
      author,
    })
  })
}

// Fork the whole session into a new "btw:" thread that answers one side
// question (V1 /btw). The source session keeps running. The fork inherits
// messages, agent, model and instructions, so its prompt cache is warm.
export function forkBtw(
  bot: Bot,
  {
    sourceThread,
    text,
    author,
    messageId,
    files = [],
    agent,
  }: {
    sourceThread: ThreadChannel
    text: string
    author: Author
    messageId: string
    files?: readonly PromptFile[]
    // A voice message asked for this agent.
    agent?: string
  },
): Effect.Effect<
  { threadId: string; sessionId: string },
  ConfigError | OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError
> {
  return Effect.gen(function* () {
    const parentSessionId = rootSession(bot, sourceThread.id)
    if (typeof parentSessionId !== 'string') return yield* Effect.fail(parentSessionId)
    const project = yield* threadProject(bot, sourceThread)
    const channel = yield* textChannel(bot, project.channelId)

    // Either side can fail after the other exists: keep both results, then
    // remove the one that survived so nothing is left half set up.
    const [forkSide, threadSide] = yield* Effect.all(
      [
        ocEffect(bot, 'session.fork', (client) => client.session.fork({ sessionID: parentSessionId })).pipe(
          Effect.match({ onFailure: (error) => ({ error }), onSuccess: (forked) => ({ forked }) }),
        ),
        discord<ThreadChannel>('create btw thread', () =>
          channel.threads.create({
            name: `btw: ${text.replace(/\s+/g, ' ')}`.slice(0, 100),
            autoArchiveDuration: 1440,
          }),
        ).pipe(Effect.match({ onFailure: (error) => ({ error }), onSuccess: (thread) => ({ thread }) })),
      ],
      { concurrency: 'unbounded' },
    )
    if ('error' in forkSide) {
      if ('thread' in threadSide) {
        yield* Effect.promise(() => threadSide.thread.delete('btw fork failed').catch(() => undefined))
      }
      return yield* Effect.fail(forkSide.error)
    }
    const forked = forkSide.forked
    if ('error' in threadSide) {
      yield* ocEffect(bot, 'session.remove', (client) => client.session.remove({ sessionID: forked.id })).pipe(
        Effect.match({
          onFailure: (error) => logger.warn(`discard btw fork ${forked.id}`, error),
          onSuccess: () => null,
        }),
      )
      return yield* Effect.fail(threadSide.error)
    }
    const thread = threadSide.thread

    const kimaki = { threadId: thread.id, channelId: project.channelId, source: 'discord', ...cliContext(bot) }
    yield* ocEffect(bot, 'session.update', (client) =>
      client.session.update({ sessionID: forked.id, metadata: { kimaki } }),
    )
    yield* bindThread(bot, {
      threadId: thread.id,
      sessionId: forked.id,
      channelId: project.channelId,
      directory: project.directory,
      isNew: false,
    })
    yield* Effect.promise(() => thread.members.add(author.id).catch((e: Error) => logger.warn(`add btw member`, e)))
    yield* discord('send btw intro', () =>
      thread.send({
        content: `Reusing context from <#${sourceThread.id}> to answer prompt...\n${text}`.slice(0, 2_000),
        allowedMentions: { parse: [] },
        flags: SILENT_MESSAGE_FLAGS,
      }),
    )
    if (agent) {
      yield* switchAgent(bot, { sessionId: forked.id, directory: project.directory, agent })
    }
    yield* prompt(bot, {
      sessionId: forked.id,
      threadId: thread.id,
      threadName: thread.name,
      text: btwPrompt({
        text,
        parentSessionId,
        sourceThreadId: sourceThread.id,
        sessionId: forked.id,
        threadId: thread.id,
      }),
      author,
      messageId,
      delivery: 'steer',
      files,
    })
    return { threadId: thread.id, sessionId: forked.id }
  })
}
