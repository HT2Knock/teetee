// Input into existing sessions (spec 27.2): prompts, steering, commands,
// shells, queue edits, /abort, /undo and /redo, and `kimaki send`. Callers
// (ingress, slash commands, buttons, CLI, scheduler) get an ack back. Session
// output is never rendered here: it arrives through the event stream.
//
// A new plain message interrupts the run (spec 9.1, corrected in section 20):
//
//   cancel pending questions ─▶ reject pending permissions ─▶ interrupt(resume: false)
//     ─▶ prompt(steer)
//
// Interrupt first, then prompt: the new prompt's wake starts the next
// execution with "input" scope, which runs queued items after it. The other
// order (prompt, then interrupt with resume) parks queued items for good.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {type Message} from 'discord.js'
import * as errore from 'errore'

import {oc, projectOf, rootSession, type Author, type Bot, type PromptFile} from './bot.ts'
import {ConfigError, OpenCodeError, OpenCodeUnavailableError} from './errors.ts'
import {formatError} from './format-parts.ts'
import {createLogger} from './logger.ts'
import {splitPromptFiles} from './prompt-files.ts'
import {parseTextMessage} from './routes.ts'
import {allMessages} from './session-events.ts'
import {cancelSleep} from './sleep-store.ts'
import {type TurnContext} from './system-prompt.ts'
import {isBusy, type UploadFile} from './thread-reducer.ts'

const logger = createLogger('PROMPT')

// Prompt IDs map a Discord message to its inbox item without stored state (spec 9.2.2).
function promptIdForMessage(messageId: string): string {
  return `msg_discord_${messageId}`
}

export async function prompt(
  bot: Bot,
  {
    sessionId,
    threadId,
    threadName,
    text,
    author,
    messageId,
    delivery,
    files = [],
    skills = [],
    id = promptIdForMessage(messageId),
    echo,
  }: {
    sessionId: string
    threadId: string
    threadName: string
    text: string
    author: Author
    // The Discord message (or interaction) this prompt came from.
    messageId: string
    delivery: 'steer' | 'queue'
    files?: readonly PromptFile[]
    // Skill IDs attached to the prompt (`/<skill>-skill`).
    skills?: readonly string[]
    id?: string
    // Line the thread shows when OpenCode takes the prompt (queue.ts), for
    // inputs that have no Discord message: wakes, scheduled runs.
    echo?: string
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const { attached, attachments } = await splitPromptFiles(files)
  // The text stays as the user wrote it. The plugin renders the <discord-user>
  // context from this metadata into the model request only (turnContext()).
  const discord: TurnContext = { userId: author.id, username: author.username, messageId, threadId, threadName, attachments }
  const result = await oc(bot, 'session.prompt', (client) =>
    client.session.prompt({
      sessionID: sessionId,
      id,
      text,
      files: attached,
      ...(skills.length > 0 && { skills: skills.map((skill) => ({ id: skill })) }),
      delivery,
      metadata: { discord: { ...discord, ...(echo && { echo }) } },
    }),
  )
  if (result instanceof Error) return result
}

// Questions and permissions of the thread (root and children) that wait for the user.
export async function cancelPendingUi(bot: Bot, threadId: string): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  if (!bot.opencode.endpoint) return new OpenCodeUnavailableError({ reason: 'not connected' })
  const view = bot.store.getState().threads[threadId]
  if (!view) return
  const forms = Object.entries(view.forms).map(([formID, form]) =>
    oc(bot, 'session.form.cancel', (client) => client.session.form.cancel({ sessionID: form.sessionId, formID })),
  )
  const permissions = Object.entries(view.permissions).map(([requestID, request]) =>
    oc(bot, 'permission.reply', (client) => client.permission.reply({ sessionID: request.sessionId, requestID, decision: 'reject' })),
  )
  // Settled meanwhile by someone else is fine: log and go on.
  for (const result of await Promise.all([...forms, ...permissions])) {
    if (result instanceof Error) logger.warn(`cancel pending UI in ${threadId}`, result)
  }
}

export async function interrupt(bot: Bot, sessionId: string): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const result = await oc(bot, 'session.interrupt', (client) => client.session.interrupt({ sessionID: sessionId, resume: false }))
  if (result instanceof Error) return result
}

// A plain message: it replaces whatever the session is doing.
export async function steer(
  bot: Bot,
  input: {
    sessionId: string
    threadId: string
    threadName: string
    text: string
    author: Author
    messageId: string
    files?: readonly PromptFile[]
    skills?: readonly string[]
    echo?: string
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const cancelled = await cancelPendingUi(bot, input.threadId)
  if (cancelled instanceof Error) return cancelled
  const interrupted = await interrupt(bot, input.sessionId)
  if (interrupted instanceof Error) return interrupted
  return prompt(bot, { ...input, delivery: 'steer' })
}

export async function cancelQueuedPrompt(bot: Bot, { threadId, inboxID }: { threadId: string; inboxID: string }) {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  const result = await oc(bot, 'session.inbox.cancel', (client) => client.session.inbox.cancel({ sessionID: sessionId, inboxID }))
  if (result instanceof Error) return result
}

// Cancels queued items: one by 1-based position, or all of them.
export async function clearQueue(
  bot: Bot,
  { threadId, position }: { threadId: string; position?: number | null },
): Promise<OpenCodeUnavailableError | OpenCodeError | { cleared: number }> {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  const inbox = await oc(bot, 'session.inbox.list', (client) => client.session.inbox.list({ sessionID: sessionId }))
  if (inbox instanceof Error) return inbox
  const queued = inbox.filter((item) => item.type === 'user' && item.delivery === 'queue')
  const targets = position ? queued.slice(position - 1, position) : queued
  for (const item of targets) {
    const result = await cancelQueuedPrompt(bot, { threadId, inboxID: item.id })
    if (result instanceof Error) return result
  }
  return { cleared: targets.length }
}

// /abort: stop the run, drop the queue, cancel pending questions and permissions.
export async function abort(bot: Bot, { threadId }: { threadId: string }) {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  await cancelSleep(bot, sessionId)
  const cleared = await clearQueue(bot, { threadId })
  if (cleared instanceof Error) return cleared
  const cancelled = await cancelPendingUi(bot, threadId)
  if (cancelled instanceof Error) return cancelled
  const interrupted = await interrupt(bot, sessionId)
  if (interrupted instanceof Error) return interrupted
  // interrupt does not stop user shells (`!cmd`): they run in the background.
  const killed = await killShells(bot, { sessionId })
  if (killed instanceof Error) return killed
  return cleared
}

// An edited queued message: cancel the old item, queue the new text at the end.
export async function requeueEdited(
  bot: Bot,
  { message, inboxID, files }: { message: Message; inboxID: string; files: readonly PromptFile[] },
) {
  const route = parseTextMessage({ content: message.content })
  const sessionId = rootSession(bot, message.channelId)
  if (sessionId instanceof Error) return sessionId
  const cancelled = await cancelQueuedPrompt(bot, { threadId: message.channelId, inboxID })
  if (cancelled instanceof Error) return cancelled
  const text = route?.kind === 'queue' || route?.kind === 'steer' ? route.text : files.length > 0 ? '' : null
  if (text === null) return
  const thread = message.channel.isThread() ? message.channel : null
  return prompt(bot, {
    sessionId,
    threadId: message.channelId,
    threadName: thread?.name ?? '',
    text,
    author: { id: message.author.id, username: message.author.username },
    messageId: message.id,
    delivery: 'queue',
    files,
    // IDs are unique per item: every edit gets its own.
    id: `${promptIdForMessage(message.id)}_e${message.editedTimestamp ?? Date.now()}`,
  })
}

// `!cmd` (spec 9.2.1): native session.shell, not interrupting and not
// queued. The request returns only when the command ends, so it is never
// awaited; output arrives as session.shell.* events.
export function shell(bot: Bot, { threadId, sessionId, command }: { threadId: string; sessionId: string; command: string }) {
  const client = bot.opencode.endpoint?.client
  if (!client) return new OpenCodeUnavailableError({ reason: 'not connected' })
  void client.session
    .shell({ sessionID: sessionId, command })
    .catch((cause) => new OpenCodeError({ operation: 'session.shell', cause }))
    .then((result) => {
      if (!(result instanceof Error)) return
      logger.error(`shell in ${threadId} failed`, result)
      bot.effects.run(threadId, [{ type: 'send', text: formatError(result.message), notify: true }])
    })
}

// User shells of a session that still run (for /abort).
async function killShells(bot: Bot, { sessionId }: { sessionId: string }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  const location = { directory: info.location.directory }
  const shells = await oc(bot, 'shell.list', (client) => client.shell.list({ location }))
  if (shells instanceof Error) return shells
  const running = shells.data.filter((item) => item.status === 'running' && item.metadata['sessionID'] === sessionId)
  for (const item of running) {
    const removed = await oc(bot, 'shell.remove', (client) => client.shell.remove({ id: item.id, location }))
    if (removed instanceof Error) return removed
  }
}

// --- Session history: /undo, /redo.

// Revert needs an idle session: stop the run first, like the OpenCode TUI.
async function idleSession(bot: Bot, threadId: string) {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  const view = bot.store.getState().threads[threadId]
  if (view && isBusy(view)) {
    const interrupted = await interrupt(bot, sessionId)
    if (interrupted instanceof Error) return interrupted
    const waited = await oc(bot, 'session.wait', (client) => client.session.wait({ sessionID: sessionId }))
    if (waited instanceof Error) return waited
  }
  const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  // All user messages, oldest first: revert boundaries are user messages.
  const messages = await oc(bot, 'message.list', (client) => allMessages({ client, sessionId, type: 'user' }))
  if (messages instanceof Error) return messages
  return { sessionId, revert: info.revert?.messageID ?? null, messages }
}

// Undo only rewinds the conversation: `files: false` makes OpenCode skip snapshot.restore,
// so the project files stay as they are.
// TODO: let users opt in to reverting files too (setting or /undo option) if they ask for it.
const revertFiles = false

// Hides the last turn. Repeating goes one turn further back.
export async function undo(bot: Bot, { threadId }: { threadId: string }) {
  const session = await idleSession(bot, threadId)
  if (session instanceof Error) return session
  const { messages } = session
  const boundary = session.revert ? messages.findIndex((message) => message.id === session.revert) : messages.length
  const target = messages[boundary - 1]
  if (!target) return { reverted: false }
  const staged = await oc(bot, 'session.revert.stage', (client) =>
    client.session.revert.stage({ sessionID: session.sessionId, messageID: target.id, files: revertFiles }),
  )
  if (staged instanceof Error) return staged
  return { reverted: true }
}

// One turn forward again; past the last turn the revert is cleared.
export async function redo(bot: Bot, { threadId }: { threadId: string }) {
  const session = await idleSession(bot, threadId)
  if (session instanceof Error) return session
  if (!session.revert) return { restored: 'nothing' as const }
  const index = session.messages.findIndex((message) => message.id === session.revert)
  const next = index >= 0 ? session.messages[index + 1] : undefined
  if (!next) {
    const cleared = await oc(bot, 'session.revert.clear', (client) => client.session.revert.clear({ sessionID: session.sessionId }))
    if (cleared instanceof Error) return cleared
    return { restored: 'all' as const }
  }
  const staged = await oc(bot, 'session.revert.stage', (client) =>
    client.session.revert.stage({ sessionID: session.sessionId, messageID: next.id, files: revertFiles }),
  )
  if (staged instanceof Error) return staged
  return { restored: 'step' as const }
}

// `kimaki upload-to-discord`: posts local files into the session's thread (or the voice channel chat),
// after the output already queued there. Answers once Discord has them.
export async function upload(bot: Bot, { id, files }: { id: string; files: Array<{ path: string; name: string }> }) {
  const { sessionThreads, roots } = bot.store.getState()
  const sessionThread = sessionThreads[id] ?? (roots[id] ? id : undefined)
  // Voice calls have no session: they upload into the text chat of the voice channel.
  const voice = sessionThread ? null : await projectOf(bot, id)
  if (voice instanceof Error) return voice
  const threadId = sessionThread ?? (voice?.channel_type === 'voice' ? id : undefined)
  if (!threadId) return new ConfigError({ reason: 'No local session thread or Kimaki voice channel for this upload' })
  if (files.length === 0) return new ConfigError({ reason: 'Upload needs at least one file' })
  const sized: UploadFile[] = []
  for (const file of files) {
    const stat = await fs.promises.stat(file.path).catch(() => null)
    if (!stat?.isFile()) return new ConfigError({ reason: `File not found: ${file.path}` })
    sized.push({ ...file, size: stat.size })
  }
  const error = await new Promise<Error | null>((settle) => bot.effects.run(threadId, [{ type: 'attachments', files: sized, settle }]))
  if (error) return error
  return { uploaded: files.map((file) => file.name) }
}
