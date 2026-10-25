// Sessions and their threads: the only module that creates session threads
// and binds sessions to them (spec 27.2). New sessions, /resume, /fork,
// /fork-subagent, btw forks, the session marker and the instructions entry.

import path from 'node:path'
import crypto from 'node:crypto'
import type {SessionMetadata} from '@opencode/client'
import type {TextChannel, ThreadChannel} from 'discord.js'

import {cliContext, oc, projectOf, readMarker, rootSession, sessionDirectory, textChannel, type Author, type Bot, type PromptFile} from './bot.ts'
import {ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError} from './errors.ts'
import {SILENT_MESSAGE_FLAGS} from './format-parts.ts'
import {createLogger} from './logger.ts'
import type {OpenCodeClient} from './opencode-server.ts'
import {prompt} from './prompt.ts'
import {parseRows, type ChannelDirectoryRow} from './rows.ts'
import {disabledSkillRules} from './builtin-skills.ts'
import {type ScheduledRun} from './system-prompt.ts'
import {NO_QUESTION_TOOL, bindThread, putInstructions, switchAgent, threadProject} from './session-context.ts'
import {createWorktree, resolveWorkingDirectory} from './worktrees.ts'

const logger = createLogger('SESSIONS')

type PermissionRules = NonNullable<NonNullable<Parameters<OpenCodeClient['session']['create']>[0]>['permissions']>

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

// Binds an existing session to a new thread. Order matters:
//
//   thread + intro ─▶ metadata + instructions (new IDs) ─▶ history
//     ─▶ one DB batch: old bindings out, new one in ─▶ routing + replay (same tick)
//     ─▶ hydrate what it runs and waits on now
//
// Nothing routes to the thread before the replay, so live output follows
// it. A failure before the binding deletes the new thread (and calls
// `discard`), leaving any old binding untouched.
async function adoptSession(
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
    session: { id: string; metadata?: SessionMetadata; permissions?: PermissionRules; location: { directory: string } }
    threadName: string
    intro: string
    note: string
    author: Author
    // Explicit `kimaki send --parent-session` of a resumed session; never a fork's OpenCode parent.
    parentSessionId?: string | null
    // A resumed task session keeps its task; a fork is a new user session.
    scheduledTask?: ScheduledRun | null
    // Cleanup of a session created only for this thread (a fork).
    discard?: () => Promise<void>
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }> {
  const sessionId = session.id
  const thread = await channel.threads
    .create({ name: threadName.replace(/\s+/g, ' ').slice(0, 100), autoArchiveDuration: 1440 })
    .catch((cause) => new DiscordError({ operation: 'create thread', cause }))
  if (thread instanceof Error) return thread

  const prepared = await (async () => {
    const posted = await thread
      .send({ content: intro.slice(0, 2_000), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
      .catch((cause) => new DiscordError({ operation: 'send intro', cause }))
    if (posted instanceof Error) return posted
    // Merge: other metadata stays. Task fields stay only for a resumed task session.
    const { task: _task, taskId: _taskId, ...rest } = readMarker(session.metadata)?.fields ?? {}
    const marker = scheduledTask ? { ...rest, taskId: scheduledTask.id, task: scheduledTask } : rest
    const kimaki = { ...marker, source: scheduledTask ? 'task' : 'discord', ...cliContext(bot), threadId: thread.id, channelId: channel.id }
    // A session with its own question rule (a fork, or --permission) keeps it.
    const rules = session.permissions ?? []
    const permissions = rules.some((rule) => rule.action === 'question') ? rules : [NO_QUESTION_TOOL, ...disabledSkillRules(bot.disabledSkills), ...rules]
    const marked = await oc(bot, 'session.update', (client) =>
      client.session.update({ sessionID: sessionId, metadata: { ...session.metadata, kimaki }, permissions }),
    )
    if (marked instanceof Error) return marked
    const instructions = await putInstructions(bot, {
      sessionId,
      thread,
      channel,
      directory: session.location.directory,
      userId: author.id,
      parentSessionId,
      scheduledTask,
    })
    if (instructions instanceof Error) return instructions
    const messages = await oc(bot, 'message.list', (client) => client.message.list({ sessionID: sessionId, order: 'desc', limit: 100 }))
    if (messages instanceof Error) return messages
    // One thread per session: older threads of this session stop following it.
    const moved = await (async () => {
      try {
        return await bot.db.begin(async (tx) => {
          const deleted = await tx<{ thread_id: string }[]>`DELETE FROM thread_sessions WHERE session_id = ${sessionId} RETURNING thread_id`
          await tx`INSERT INTO thread_sessions (thread_id, session_id, source) VALUES (${thread.id}, ${sessionId}, ${'kimaki'})`
          return deleted
        })
      } catch (cause) {
        return new DbError({ operation: 'move thread_sessions', cause })
      }
    })()
    if (moved instanceof Error) return moved
    return { history: [...messages.data].reverse(), previous: moved.map((row) => row.thread_id) }
  })()
  if (prepared instanceof Error) {
    await thread.delete('session adoption failed').catch(() => undefined)
    await discard?.()
    return prepared
  }

  for (const previousThread of prepared.previous) bot.eventLoop.unbind(previousThread)
  await bot.eventLoop.bind({
    threadId: thread.id,
    sessionId,
    channelId: channel.id,
    directory: session.location.directory,
    isNew: false,
    first: [{ type: 'kimaki.replay', messages: prepared.history, note }],
  })
  logger.log(`session ${sessionId} bound to thread ${thread.id}`)
  await thread.members.add(author.id).catch((e: Error) => logger.warn(`add member`, e))
  const hydrated = await bot.eventLoop.syncThread(thread.id)
  if (hydrated instanceof Error) logger.warn(`hydrate ${thread.id}`, hydrated)
  return { threadId: thread.id, sessionId }
}

// The project channel whose directory holds this session.
export async function channelForSession(bot: Bot, sessionId: string) {
  const directory = await sessionDirectory(bot, sessionId)
  if (directory instanceof Error) return directory
  return channelForDirectory(bot, directory)
}

export async function channelForDirectory(bot: Bot, directory: string) {
  const rows = await bot.db<ChannelDirectoryRow[]>`SELECT * FROM channel_directories`
    .catch((cause) => new DbError({ operation: 'read channel_directories', cause }))
  if (rows instanceof Error) return rows
  const projects = parseRows<ChannelDirectoryRow>('channel_directories', rows)
  projects.sort((a, b) => b.directory.length - a.directory.length)
  // Stored directories may be symlink aliases of the real path.
  const matches = await Promise.all(
    projects.map(async (row) => !(await resolveWorkingDirectory({ projectDirectory: row.directory, candidate: directory }) instanceof Error)),
  )
  const project = projects.find((_, index) => matches[index])
  if (!project) return new ConfigError({ reason: `No project channel for ${directory}. Pass --channel.` })
  return project.channel_id
}

// Binds an existing session of the channel's project to a new thread.
export async function resume(bot: Bot, { channelId, sessionId, author }: { channelId: string; sessionId: string; author: Author }) {
  const [channel, project] = await Promise.all([textChannel(bot, channelId), projectOf(bot, channelId)])
  if (channel instanceof Error) return channel
  if (project instanceof Error) return project
  if (!project) return new ConfigError({ reason: 'This channel is not configured with a project directory' })
  const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  if (await resolveWorkingDirectory({ projectDirectory: project.directory, candidate: info.location.directory }) instanceof Error) {
    return new ConfigError({
      reason: `This session belongs to a different project or worktree: \`${info.location.directory}\`. Run \`/resume\` in the channel for that directory.`,
    })
  }
  const title = info.title ?? 'Untitled'
  const marker = readMarker(info.metadata)
  const adopted = await adoptSession(bot, {
    channel,
    session: info,
    parentSessionId: marker?.parentSessionId ?? null,
    scheduledTask: marker?.task ?? null,
    threadName: `Resume: ${title}`,
    intro: `**Resumed session:** ${title}\n**Created:** <t:${Math.floor(info.time.created / 1_000)}:f>`,
    note: '**Session resumed!** You can now continue the conversation by sending messages in this thread.',
    author,
  })
  if (adopted instanceof Error) return adopted
  return { ...adopted, title }
}

// Forks the thread's session (or one of its subagent sessions) into a new
// thread. `before`: a user message ID; the fork ends right before it.
export async function fork(
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
  const root = rootSession(bot, sourceThread.id)
  if (root instanceof Error) return root
  if (sessionId !== root) {
    const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
    if (info instanceof Error) return info
    if (info.parentID !== root) {
      return new ConfigError({ reason: "This session is not the thread's root or a direct subagent. Run /fork or /fork-subagent in the session's own thread." })
    }
  }
  const project = await threadProject(bot, sourceThread)
  if (project instanceof Error) return project
  const channel = await textChannel(bot, project.channelId)
  if (channel instanceof Error) return channel
  const forked = await oc(bot, 'session.fork', (client) => client.session.fork({ sessionID: sessionId, ...(before && { before }) }))
  if (forked instanceof Error) return forked
  const discard = async () => {
    const removed = await oc(bot, 'session.remove', (client) => client.session.remove({ sessionID: forked.id }))
    if (removed instanceof Error) logger.warn(`discard fork ${forked.id}`, removed)
  }
  const relocated = await (async () => {
    if (!worktree) return forked
    const checkout = await createWorktree({
      projectDirectory: project.projectDirectory,
      dataDir: bot.dataDir,
      name: worktree.name,
      baseBranch: worktree.baseBranch,
    })
    if (checkout instanceof Error) return checkout
    const plugin = await bot.features.waitForPlugin(checkout.directory)
    if (plugin instanceof Error) return plugin
    const moved = await oc(bot, 'move worktree fork', (client) => client.session.move({ sessionID: forked.id, directory: checkout.directory }))
    if (moved instanceof Error) return moved
    const waited = await oc(bot, 'wait for worktree fork move', (client) => client.session.wait({ sessionID: forked.id }))
    if (waited instanceof Error) return waited
    const info = await oc(bot, 'confirm worktree fork directory', (client) => client.session.get({ sessionID: forked.id }))
    if (info instanceof Error) return info
    if (info.location.directory !== checkout.directory) {
      return new ConfigError({ reason: `Session did not move to ${checkout.directory}. No new thread was bound.` })
    }
    return info
  })()
  if (relocated instanceof Error) {
    await discard()
    return relocated
  }
  const intro = subagent
    ? `**Forked subagent session created!**\nAgent: \`${subagent.agent}\`\nTask: ${subagent.description || 'No description'}\nFrom: \`${sessionId}\`\nNew session: \`${forked.id}\``
    : `**Forked session created!**\nFrom: <#${sourceThread.id}> (\`${sessionId}\`)\nNew session: \`${forked.id}\``
  return adoptSession(bot, {
    channel,
    session: relocated,
    discard,
    // OpenCode titles forks "<title> (fork #1)".
    threadName: name ?? (forked.title || `Fork: ${subagent?.description || sourceThread.name}`),
    intro,
    note: 'You can now continue the conversation from this point.',
    author,
  })
}

// Fork the whole session into a new "btw:" thread that answers one side
// question (V1 /btw). The source session keeps running. The fork inherits
// messages, agent, model and instructions, so its prompt cache is warm.
export async function forkBtw(
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
): Promise<ConfigError | OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }> {
  const parentSessionId = rootSession(bot, sourceThread.id)
  if (parentSessionId instanceof Error) return parentSessionId
  const project = await threadProject(bot, sourceThread)
  if (project instanceof Error) return project
  const channel = await textChannel(bot, project.channelId)
  if (channel instanceof Error) return channel

  const [forked, thread] = await Promise.all([
    oc(bot, 'session.fork', (client) => client.session.fork({ sessionID: parentSessionId })),
    channel.threads
      .create({ name: `btw: ${text.replace(/\s+/g, ' ')}`.slice(0, 100), autoArchiveDuration: 1440 })
      .catch((cause) => new DiscordError({ operation: 'create btw thread', cause })),
  ])
  // Either side failed: remove the other so nothing is left half set up.
  if (forked instanceof Error) {
    if (!(thread instanceof Error)) await thread.delete('btw fork failed').catch(() => undefined)
    return forked
  }
  if (thread instanceof Error) {
    const removed = await oc(bot, 'session.remove', (client) => client.session.remove({ sessionID: forked.id }))
    if (removed instanceof Error) logger.warn(`discard btw fork ${forked.id}`, removed)
    return thread
  }

  const kimaki = { threadId: thread.id, channelId: project.channelId, source: 'discord', ...cliContext(bot) }
  const marked = await oc(bot, 'session.update', (client) => client.session.update({ sessionID: forked.id, metadata: { kimaki } }))
  if (marked instanceof Error) return marked
  const bound = await bindThread(bot, {
    threadId: thread.id,
    sessionId: forked.id,
    channelId: project.channelId,
    directory: project.directory,
    isNew: false,
  })
  if (bound instanceof Error) return bound
  await thread.members.add(author.id).catch((e: Error) => logger.warn(`add btw member`, e))
  const intro = await thread
    .send({ content: `Reusing context from <#${sourceThread.id}> to answer prompt...\n${text}`.slice(0, 2_000), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
    .catch((cause) => new DiscordError({ operation: 'send btw intro', cause }))
  if (intro instanceof Error) return intro
  if (agent) {
    const switched = await switchAgent(bot, { sessionId: forked.id, directory: project.directory, agent })
    if (switched instanceof Error) return switched
  }

  const sent = await prompt(bot, {
    sessionId: forked.id,
    threadId: thread.id,
    threadName: thread.name,
    text: btwPrompt({ text, parentSessionId, sourceThreadId: sourceThread.id, sessionId: forked.id, threadId: thread.id }),
    author,
    messageId,
    delivery: 'steer',
    files,
  })
  if (sent instanceof Error) return sent
  return { threadId: thread.id, sessionId: forked.id }
}
