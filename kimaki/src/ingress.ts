// Discord ingress (spec 4): gates every messageCreate, parses it into a Route
// and calls actions. Gates, in order: bots (including ourselves), channel
// ownership (only channels mapped in this machine's SQLite), permission.
// Messages of one channel are handled in arrival order, after OpenCode is ready.
//
// Messages sent while the bot was offline are not fetched here: discord.js
// RESUME replays short drops.
//
// Attachments become prompt files; voice messages are transcribed into the
// same Route as text. Edits and deletes of queued messages update the queue.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Data } from 'effect'

import {
  Events,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type Attachment,
  type Guild,
  type Message,
} from './adapters/discord/index.ts'
import { parseInput, sendInput, type SendInput } from './adapters/http/routes.ts'
import { projectOf, type Bot, type PromptFile } from './bot.ts'
import { runResult } from './effect-bridge.ts'
import { attempt } from './errors.ts'
import { formatError, NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS } from './format-parts.ts'
import { dispatch, send, startSession } from './input.ts'
import { createLogger } from './logger.ts'
import { cancelQueuedPrompt, requeueEdited } from './prompt.ts'
import { queuedItemFor } from './queue.ts'
import { REMOTE_PROMPT_FILE, REMOTE_RESULT_PREFIX, REMOTE_SEND_PREFIX } from './remote-send.ts'
import { parseTextMessage, type Route } from './routes.ts'

const logger = createLogger('INGRESS')

// Owner, Administrator, Manage Server, or a role named "Kimaki"; with
// --allow-all-users every member. A role named "no-kimaki" always denies.
// Missing member data fails closed.
export async function canUseKimaki(
  bot: Pick<Bot, 'allowAllUsers'>,
  { guild, userId }: { guild: Guild; userId: string },
): Promise<boolean> {
  const member = await guild.members.fetch({ user: userId, force: true }).catch((error: Error) => error)
  if (member instanceof Error) {
    // Still denied, but say why: a REST failure must not look like a missing role.
    logger.warn(`cannot check Kimaki permission of ${userId}`, member)
    return false
  }
  if (!(member instanceof GuildMember)) return false
  return memberCanUseKimaki(bot, member)
}

// MESSAGE_CREATE carries the author's current roles: no REST fetch on the hot path.
// Discord omits the member only for webhook and ephemeral messages, which never get here.
function authorCanUseKimaki(bot: Bot, message: Message<true>): Promise<boolean> {
  if (message.member instanceof GuildMember) return Promise.resolve(memberCanUseKimaki(bot, message.member))
  return canUseKimaki(bot, { guild: message.guild, userId: message.author.id })
}

function memberCanUseKimaki(bot: Pick<Bot, 'allowAllUsers'>, member: GuildMember): boolean {
  const roleNames = member.roles.cache.map((role) => role.name.toLowerCase())
  if (roleNames.includes('no-kimaki')) return false
  if (bot.allowAllUsers) return true
  if (member.guild.ownerId === member.id) return true
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true
  return roleNames.includes('kimaki')
}

// Attachments are saved under <dataDir>/attachments/<messageId>/ and sent as
// file:// URIs; OpenCode reads them into the prompt (images are resized there).
async function saveAttachments({
  dataDir,
  messageId,
  attachments,
}: {
  dataDir: string
  messageId: string
  attachments: readonly Attachment[]
}): Promise<AttachmentError | PromptFile[]> {
  if (attachments.length === 0) return []
  const directory = path.join(dataDir, 'attachments', messageId)
  const created = await fs.promises
    .mkdir(directory, { recursive: true })
    .catch((e) => new AttachmentError({ file: directory, cause: e }))
  if (created instanceof Error) return created
  const saved: PromptFile[] = []
  for (const [index, attachment] of attachments.entries()) {
    const bytes = await download(attachment.url)
    if (bytes instanceof Error) return bytes
    // Index prefix: two attachments may share a name.
    const file = path.join(directory, `${index}-${path.basename(attachment.name) || 'attachment'}`)
    const written = await fs.promises
      .writeFile(file, bytes)
      .catch((e) => new AttachmentError({ file: attachment.name, cause: e }))
    if (written instanceof Error) return written
    saved.push({ uri: pathToFileURL(file).href, name: attachment.name })
  }
  return saved
}

class AttachmentError extends Data.TaggedError('AttachmentError')<{ file: string; message: string; cause?: unknown }> {
  constructor({ file, cause }: { file: string; cause?: unknown }) {
    super({ file, cause, message: `Could not download attachment ${file}` })
  }
}

async function remotePromptText(url: string) {
  const response = await fetch(url).catch((cause) => new AttachmentError({ file: REMOTE_PROMPT_FILE, cause }))
  if (response instanceof Error) return response
  if (!response.ok)
    return new AttachmentError({ file: REMOTE_PROMPT_FILE, cause: new Error(`HTTP ${response.status}`) })
  return response.text().catch((cause) => new AttachmentError({ file: REMOTE_PROMPT_FILE, cause }))
}

// The envelope carries the full prompt in a file when Discord truncated the content.
async function envelopePrompt(attachment: Attachment | undefined) {
  if (!attachment) {
    return new AttachmentError({ file: REMOTE_PROMPT_FILE, cause: new Error('missing from the remote envelope') })
  }
  return remotePromptText(attachment.url)
}

// A bad payload or an unsaved attachment never reaches a session.
async function deliverEnvelope({
  bot,
  input,
  files,
}: {
  bot: Bot
  input: SendInput | Error
  files: PromptFile[] | Error
}) {
  if (input instanceof Error) return input
  if (files instanceof Error) return files
  return send(bot, { ...input, files }, { localOnly: true })
}

// Only commands and skills have a name worth echoing; a plain prompt echoes its text.
function routeDetail(route: Route): string {
  if (route.kind === 'command') return ` /${route.name}`
  if (route.kind === 'skill') return ` ${route.id}`
  return ''
}

async function download(url: string): Promise<AttachmentError | Buffer> {
  const response = await fetch(url).catch((e) => new AttachmentError({ file: url, cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) return new AttachmentError({ file: `${url} (HTTP ${response.status})` })
  const body = await response.arrayBuffer().catch((e) => new AttachmentError({ file: url, cause: e }))
  if (body instanceof Error) return body
  return Buffer.from(body)
}

// Voice: transcribe first. The transcription picks the route (spec 9.4).
// A remote send envelope another machine's `kimaki send` posted in a channel this bot owns.
async function handleRemoteEnvelope(
  bot: Bot,
  { message, channelId, threadId }: { message: Message; channelId: string; threadId: string | null },
) {
  const footer = message.embeds[0]?.footer?.text
  if (!footer?.startsWith(REMOTE_SEND_PREFIX)) return
  const decoded = attempt(
    () => ({ value: JSON.parse(footer.slice(REMOTE_SEND_PREFIX.length)) as unknown }),
    (cause) => new AttachmentError({ file: 'remote envelope', cause }),
  )
  if (decoded instanceof Error) return
  const value = decoded.value
  if (!value || typeof value !== 'object') return
  if (!('requestId' in value) || typeof value.requestId !== 'string' || !/^[0-9a-f]{16}$/.test(value.requestId)) return
  if (!('options' in value) || !value.options || typeof value.options !== 'object' || Array.isArray(value.options))
    return
  const promptInFile = 'promptFile' in value && value.promptFile === REMOTE_PROMPT_FILE
  const first = message.attachments.first()
  const promptAttachment = promptInFile && first?.name === REMOTE_PROMPT_FILE ? first : undefined
  // Never fall back to the truncated preview in the message content.
  const prompt = promptInFile ? await envelopePrompt(promptAttachment) : message.content
  const target = threadId ? { threadId } : { channelId }
  const input = prompt instanceof Error ? prompt : parseInput(sendInput, { ...value.options, ...target, prompt })
  const attachments = [...message.attachments.values()].filter((attachment) => attachment !== promptAttachment)
  const files = await saveAttachments({ dataDir: bot.dataDir, messageId: message.id, attachments })
  const result = await deliverEnvelope({ bot, input, files })
  const answer = JSON.stringify(result instanceof Error ? { error: result.message } : result)
  await message
    .reply({
      content: result instanceof Error ? result.message : `Delivered to <#${result.threadId}>`,
      embeds: [{ footer: { text: `${REMOTE_RESULT_PREFIX}${value.requestId}:${answer}` } }],
      allowedMentions: { parse: [] },
      // The data is in the embed: SuppressEmbeds would hide it.
      flags: MessageFlags.SuppressNotifications,
    })
    .catch((error: Error) => logger.warn(`remote acknowledgment`, error))
}

async function handleMessage(bot: Bot, message: Message) {
  const channel = message.channel
  const thread = channel.isThread() ? channel : null
  const channelId = thread ? thread.parentId : channel.id
  if (!channelId || !message.inGuild()) return

  const project = await runResult(projectOf(bot, channelId))
  if (project instanceof Error) return logger.warn(project)
  if (!project) return
  if (message.author.bot) {
    if (message.author.id !== bot.discord.user?.id) return
    return handleRemoteEnvelope(bot, { message, channelId, threadId: thread?.id ?? null })
  }
  if (!(await authorCanUseKimaki(bot, message))) {
    logger.log(`ignoring ${message.author.username}: no Kimaki permission`)
    return
  }
  const sessionId = thread ? bot.store.getState().roots[thread.id] : undefined
  if (thread && !sessionId) return
  const author = { id: message.author.id, username: message.author.username }
  const reportError = async (error: Error) => {
    logger.error(`message ${message.id} failed`, error)
    await message.reply({ content: formatError(error.message), flags: NOTIFY_MESSAGE_FLAGS }).catch(() => undefined)
  }

  const attachments = [...message.attachments.values()]
  const files = await saveAttachments({
    dataDir: bot.dataDir,
    messageId: message.id,
    attachments,
  })
  if (files instanceof Error) return reportError(files)
  const route =
    parseTextMessage({ content: message.content }) ?? (files.length > 0 ? { kind: 'steer' as const, text: '' } : null)
  if (route instanceof Error) return reportError(route)
  if (!route) return
  const detail = routeDetail(route)
  const attached = files.length > 0 ? `, ${files.length} file(s)` : ''
  logger.log(
    `${route.kind}${detail} from ${author.username} in ${thread ? `thread ${thread.id}` : `channel ${channelId}`}${attached}`,
  )
  // The transcription is not visible anywhere else.

  if (!thread) {
    // A channel message starts a session. Queue and btw need one to wait
    // for or fork from: here they are plain prompts.
    const first =
      route.kind === 'shell' || route.kind === 'command' || route.kind === 'skill'
        ? route
        : { ...route, kind: 'steer' as const }
    const started = await startSession(bot, {
      channelId,
      directory: project.directory,
      route: first,
      author,
      messageId: message.id,
      files,
    })
    if (started instanceof Error) return reportError(started)
    return
  }

  const result = await dispatch(bot, { thread, route, author, messageId: message.id, files })
  if (result instanceof Error) return reportError(result)
  if (!result) return
  const note =
    route.kind === 'btw'
      ? `Session forked! Continue in <#${result.threadId}>`
      : `Started a new session in <#${result.threadId}>`
  await message
    .reply({ content: note, allowedMentions: { repliedUser: false }, flags: SILENT_MESSAGE_FLAGS })
    .catch(() => undefined)
}

// Registers the message listeners. Messages of one channel are handled in arrival order.
export function registerIngress(bot: Bot) {
  const chains = new Map<string, Promise<void>>()

  function serialize(channelId: string, task: () => Promise<void>) {
    const previous = chains.get(channelId) ?? Promise.resolve()
    const next = previous.then(async () => {
      // gateway-proxy replays messages missed while offline right after READY,
      // often before the OpenCode connection and hydration are done.
      const ready = await bot.opencode.ready
      if (ready instanceof Error) return logger.warn(`ingress skipped, OpenCode not ready`, ready)
      await task().catch((error: Error) => logger.error(`ingress failed`, error))
    })
    chains.set(channelId, next)
  }

  bot.discord.on(Events.MessageCreate, (message) => {
    if (message.author.bot && !message.embeds[0]?.footer?.text.startsWith(REMOTE_SEND_PREFIX)) return
    serialize(message.channelId, () => handleMessage(bot, message))
  })
  // Deleting a queued Discord message removes it from the queue.
  bot.discord.on(Events.MessageDelete, (message) => {
    serialize(message.channelId, async () => {
      const item = queuedItemFor(bot, { threadId: message.channelId, messageId: message.id })
      if (!item) return
      const result = await runResult(cancelQueuedPrompt(bot, { threadId: message.channelId, inboxID: item.inboxID }))
      if (result instanceof Error) logger.warn(`delete of queued ${message.id} failed`, result)
    })
  })
  // Editing a queued message re-queues the new text at the end (spec 9.2.2
  // option A: the inbox has no API to change an item's text).
  bot.discord.on(Events.MessageUpdate, (_old, message) => {
    if (message.author?.bot) return
    serialize(message.channelId, async () => {
      const full = message.partial ? await message.fetch().catch(() => null) : message
      if (!full?.guild || !queuedItemFor(bot, { threadId: full.channelId, messageId: full.id })) return
      if (!(await canUseKimaki(bot, { guild: full.guild, userId: full.author.id }))) return
      // The re-queued prompt must carry the message's attachments again.
      const files = await saveAttachments({
        dataDir: bot.dataDir,
        messageId: full.id,
        attachments: [...full.attachments.values()],
      })
      if (files instanceof Error) {
        logger.error(`edit of ${full.id}`, files)
        return
      }
      // Read again: the item may have started while the files were saved.
      const item = queuedItemFor(bot, { threadId: full.channelId, messageId: full.id })
      if (!item) return
      const result = await runResult(requeueEdited(bot, { message: full, inboxID: item.inboxID, files }))
      if (result instanceof Error) logger.warn(`edit of queued ${full.id} failed`, result)
    })
  })
}
