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

import type { SessionMessageInfo } from '@opencode/client'
import { Effect } from 'effect'

import type { Message } from './adapters/discord/index.ts'
import { ocEffect, projectOf, rootSession, type Author, type Bot, type PromptFile } from './bot.ts'
import { runResult } from './effect-bridge.ts'
import { ConfigError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import { formatError } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { splitPromptFiles } from './prompt-files.ts'
import { parseTextMessage, type Route } from './routes.ts'
import { allMessages } from './session-events.ts'
import { cancelSleep } from './sleep-store.ts'
import type { TurnContext } from './system-prompt.ts'
import { isBusy, type UploadFile } from './thread-reducer.ts'

const logger = createLogger('PROMPT')

// Prompt IDs map a Discord message to its inbox item without stored state (spec 9.2.2).
function promptIdForMessage(messageId: string): string {
  return `msg_discord_${messageId}`
}

export function prompt(
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
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const { attached, attachments } = yield* Effect.promise(() => splitPromptFiles(files))
    // The text stays as the user wrote it. The plugin renders the <discord-user>
    // context from this metadata into the model request only (turnContext()).
    const discord: TurnContext = {
      userId: author.id,
      username: author.username,
      messageId,
      threadId,
      threadName,
      attachments,
    }
    yield* ocEffect(bot, 'session.prompt', (client) =>
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
  })
}

// Questions and permissions of the thread (root and children) that wait for the user.
export function cancelPendingUi(bot: Bot, threadId: string): Effect.Effect<void, OpenCodeUnavailableError> {
  return Effect.gen(function* () {
    if (!bot.opencode.endpoint) return yield* Effect.fail(new OpenCodeUnavailableError({ reason: 'not connected' }))
    const view = bot.store.getState().threads[threadId]
    if (!view) return
    const forms = Object.entries(view.forms).map(([formID, form]) =>
      ocEffect(bot, 'session.form.cancel', (client) =>
        client.session.form.cancel({ sessionID: form.sessionId, formID }),
      ),
    )
    const permissions = Object.entries(view.permissions).map(([requestID, request]) =>
      ocEffect(bot, 'permission.reply', (client) =>
        client.permission.reply({ sessionID: request.sessionId, requestID, decision: 'reject' }),
      ),
    )
    // Settled meanwhile by someone else is fine: log and go on.
    const failed = yield* Effect.all(
      [...forms, ...permissions].map((call) =>
        call.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null })),
      ),
      { concurrency: 'unbounded' },
    )
    for (const error of failed) if (error) logger.warn(`cancel pending UI in ${threadId}`, error)
  })
}

export function interrupt(bot: Bot, sessionId: string): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return ocEffect(bot, 'session.interrupt', (client) =>
    client.session.interrupt({ sessionID: sessionId, resume: false }),
  ).pipe(Effect.asVoid)
}

// A plain message: it replaces whatever the session is doing.
export function steer(
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
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    yield* cancelPendingUi(bot, input.threadId)
    yield* interrupt(bot, input.sessionId)
    yield* prompt(bot, { ...input, delivery: 'steer' })
  })
}

export function cancelQueuedPrompt(
  bot: Bot,
  { threadId, inboxID }: { threadId: string; inboxID: string },
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const sessionId = rootSession(bot, threadId)
    if (typeof sessionId !== 'string') return yield* Effect.fail(sessionId)
    yield* ocEffect(bot, 'session.inbox.cancel', (client) =>
      client.session.inbox.cancel({ sessionID: sessionId, inboxID }),
    )
  })
}

// Cancels queued items: one by 1-based position, or all of them.
export function clearQueue(
  bot: Bot,
  { threadId, position }: { threadId: string; position?: number | null },
): Effect.Effect<{ cleared: number }, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const sessionId = rootSession(bot, threadId)
    if (typeof sessionId !== 'string') return yield* Effect.fail(sessionId)
    const inbox = yield* ocEffect(bot, 'session.inbox.list', (client) =>
      client.session.inbox.list({ sessionID: sessionId }),
    )
    const queued = inbox.filter((item) => item.type === 'user' && item.delivery === 'queue')
    const targets = position ? queued.slice(position - 1, position) : queued
    for (const item of targets) yield* cancelQueuedPrompt(bot, { threadId, inboxID: item.id })
    return { cleared: targets.length }
  })
}

// /abort: stop the run, drop the queue, cancel pending questions and permissions.
export function abort(
  bot: Bot,
  { threadId }: { threadId: string },
): Effect.Effect<{ cleared: number }, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const sessionId = rootSession(bot, threadId)
    if (typeof sessionId !== 'string') return yield* Effect.fail(sessionId)
    // A sleep that cannot be cancelled is worth a line, not a failed abort.
    yield* cancelSleep(bot, sessionId).pipe(
      Effect.catchTag('DbError', (error) => Effect.sync(() => logger.warn(error))),
    )
    const cleared = yield* clearQueue(bot, { threadId })
    yield* cancelPendingUi(bot, threadId)
    yield* interrupt(bot, sessionId)
    // interrupt does not stop user shells (`!cmd`): they run in the background.
    yield* killShells(bot, { sessionId })
    return cleared
  })
}

// An edit keeps the typed text, an edit that only adds files re-queues an
// empty prompt, and anything else drops the queued item.
function editedPromptText({ route, fileCount }: { route: Route | null; fileCount: number }): string | null {
  if (route?.kind === 'queue' || route?.kind === 'steer') return route.text
  return fileCount > 0 ? '' : null
}

// An edited queued message: cancel the old item, queue the new text at the end.
export function requeueEdited(
  bot: Bot,
  { message, inboxID, files }: { message: Message; inboxID: string; files: readonly PromptFile[] },
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const route = parseTextMessage({ content: message.content })
    const sessionId = rootSession(bot, message.channelId)
    if (typeof sessionId !== 'string') return yield* Effect.fail(sessionId)
    yield* cancelQueuedPrompt(bot, { threadId: message.channelId, inboxID })
    const text = editedPromptText({ route, fileCount: files.length })
    if (text === null) return
    const thread = message.channel.isThread() ? message.channel : null
    yield* prompt(bot, {
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
  })
}

// `!cmd` (spec 9.2.1): native session.shell, not interrupting and not
// queued. The request returns only when the command ends, so it is never
// awaited; output arrives as session.shell.* events.
export function shell(
  bot: Bot,
  { threadId, sessionId, command }: { threadId: string; sessionId: string; command: string },
) {
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
  return
}

// User shells of a session that still run (for /abort).
function killShells(
  bot: Bot,
  { sessionId }: { sessionId: string },
): Effect.Effect<void, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const info = yield* ocEffect(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
    const location = { directory: info.location.directory }
    const shells = yield* ocEffect(bot, 'shell.list', (client) => client.shell.list({ location }))
    const running = shells.data.filter((item) => item.status === 'running' && item.metadata['sessionID'] === sessionId)
    for (const item of running) {
      yield* ocEffect(bot, 'shell.remove', (client) => client.shell.remove({ id: item.id, location }))
    }
  })
}

// --- Session history: /undo, /redo.

// allMessages reports a failed page as a value; this puts it in the error
// channel, so /undo and /redo stay Effect end to end.
function listUserMessages(
  bot: Bot,
  sessionId: string,
): Effect.Effect<SessionMessageInfo[], OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const client = bot.opencode.endpoint?.client
    if (!client) return yield* Effect.fail(new OpenCodeUnavailableError({ reason: 'not connected' }))
    const listed = yield* Effect.promise(() => allMessages({ client, sessionId, type: 'user' }))
    if (listed instanceof OpenCodeError) return yield* Effect.fail(listed)
    return listed
  })
}

// Revert needs an idle session: stop the run first, like the OpenCode TUI.
function idleSession(
  bot: Bot,
  threadId: string,
): Effect.Effect<
  { sessionId: string; revert: string | null; messages: SessionMessageInfo[] },
  OpenCodeUnavailableError | OpenCodeError
> {
  return Effect.gen(function* () {
    const sessionId = rootSession(bot, threadId)
    if (typeof sessionId !== 'string') return yield* Effect.fail(sessionId)
    const view = bot.store.getState().threads[threadId]
    if (view && isBusy(view)) {
      yield* interrupt(bot, sessionId)
      yield* ocEffect(bot, 'session.wait', (client) => client.session.wait({ sessionID: sessionId }))
    }
    const info = yield* ocEffect(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
    // All user messages, oldest first: revert boundaries are user messages.
    const messages = yield* listUserMessages(bot, sessionId)
    return { sessionId, revert: info.revert?.messageID ?? null, messages }
  })
}

// Undo only rewinds the conversation: `files: false` makes OpenCode skip snapshot.restore,
// so the project files stay as they are.
// TODO: let users opt in to reverting files too (setting or /undo option) if they ask for it.
const revertFiles = false

// Hides the last turn. Repeating goes one turn further back.
export function undo(
  bot: Bot,
  { threadId }: { threadId: string },
): Effect.Effect<{ reverted: boolean }, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const session = yield* idleSession(bot, threadId)
    const { messages } = session
    const boundary = session.revert ? messages.findIndex((message) => message.id === session.revert) : messages.length
    const target = messages[boundary - 1]
    if (!target) return { reverted: false }
    yield* ocEffect(bot, 'session.revert.stage', (client) =>
      client.session.revert.stage({ sessionID: session.sessionId, messageID: target.id, files: revertFiles }),
    )
    return { reverted: true }
  })
}

// One turn forward again; past the last turn the revert is cleared.
export function redo(
  bot: Bot,
  { threadId }: { threadId: string },
): Effect.Effect<{ restored: 'nothing' | 'all' | 'step' }, OpenCodeUnavailableError | OpenCodeError> {
  return Effect.gen(function* () {
    const session = yield* idleSession(bot, threadId)
    if (!session.revert) return { restored: 'nothing' as const }
    const index = session.messages.findIndex((message) => message.id === session.revert)
    const next = index >= 0 ? session.messages[index + 1] : undefined
    if (!next) {
      yield* ocEffect(bot, 'session.revert.clear', (client) =>
        client.session.revert.clear({ sessionID: session.sessionId }),
      )
      return { restored: 'all' as const }
    }
    yield* ocEffect(bot, 'session.revert.stage', (client) =>
      client.session.revert.stage({ sessionID: session.sessionId, messageID: next.id, files: revertFiles }),
    )
    return { restored: 'step' as const }
  })
}

// `kimaki upload-to-discord`: posts local files into the session's thread (or the voice channel chat),
// after the output already queued there. Answers once Discord has them.
export async function upload(bot: Bot, { id, files }: { id: string; files: Array<{ path: string; name: string }> }) {
  const { sessionThreads, roots } = bot.store.getState()
  const sessionThread = sessionThreads[id] ?? (roots[id] ? id : undefined)
  // Voice calls have no session: they upload into the text chat of the voice channel.
  const voice = sessionThread ? null : await runResult(projectOf(bot, id))
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
  const error = await new Promise<Error | null>((resolve) => {
    bot.effects.run(threadId, [{ type: 'attachments', files: sized, settle: resolve }])
  })
  if (error) return error
  return { uploaded: files.map((file) => file.name) }
}
