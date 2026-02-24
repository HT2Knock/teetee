// DigitalDiscord - Local Discord API test server.
// Creates a fake Discord server (REST + Gateway WebSocket) that discord.js
// can connect to. Used for automated testing of the Kimaki bot without
// hitting real Discord.

import {
  ChannelType,
  GatewayDispatchEvents,
  InteractionType,
  ComponentType,
} from 'discord-api-types/v10'
import type {
  APIMessage,
  APIChannel,
  APIEmbed,
  APIAttachment,
  APIInteraction,
} from 'discord-api-types/v10'
import { createPrismaClient, type PrismaClient } from './db.js'
import { generateSnowflake } from './snowflake.js'
import {
  createServer,
  startServer,
  stopServer,
  type ServerComponents,
} from './server.js'
import type { GatewayState } from './gateway.js'
import {
  userToAPI,
  guildToAPI,
  memberToAPI,
  channelToAPI,
  messageToAPI,
} from './serializers.js'

export interface DigitalDiscordOptions {
  guild?: {
    id?: string
    name?: string
    ownerId?: string
  }
  channels?: Array<{
    id?: string
    name: string
    type: ChannelType
    topic?: string
    parentId?: string
  }>
  users?: Array<{
    id?: string
    username: string
    bot?: boolean
  }>
  botUser?: {
    id?: string
    username?: string
  }
  botToken?: string
  // Database URL. Defaults to in-memory (file::memory:?cache=shared).
  // Pass a file: URL (e.g. "file:./test.db") for persistent storage.
  dbUrl?: string
}

export type DigitalDiscordCommandOption = {
  name: string
  type: number
  value?: string | number | boolean
  options?: DigitalDiscordCommandOption[]
}

export type DigitalDiscordSelectOption = {
  values: string[]
}

export type DigitalDiscordModalField = {
  customId: string
  value: string
}

export type DigitalDiscordMessagePredicate = (message: APIMessage) => boolean
export type DigitalDiscordThreadPredicate = (thread: APIChannel) => boolean

function compareSnowflakeDesc(a: string, b: string): number {
  try {
    const aSnowflake = BigInt(a)
    const bSnowflake = BigInt(b)
    if (aSnowflake > bSnowflake) {
      return -1
    }
    if (aSnowflake < bSnowflake) {
      return 1
    }
    return 0
  } catch {
    return b.localeCompare(a)
  }
}

export class DigitalDiscord {
  prisma: PrismaClient
  botToken: string
  botUserId: string
  guildId: string

  private server: ServerComponents | null = null
  private options: DigitalDiscordOptions
  private seeded = false

  constructor(options: DigitalDiscordOptions = {}) {
    this.options = options
    this.prisma = createPrismaClient(options.dbUrl)
    this.botToken = options.botToken ?? 'fake-bot-token'
    this.botUserId = options.botUser?.id ?? generateSnowflake()
    this.guildId = options.guild?.id ?? generateSnowflake()
  }

  get port(): number {
    return this.server?.port ?? 0
  }

  get restUrl(): string {
    return `http://localhost:${this.port}/api`
  }

  get gatewayUrl(): string {
    return `ws://localhost:${this.port}/gateway`
  }

  async start(): Promise<void> {
    // Apply migrations by pushing schema to in-memory DB
    // For libsql :memory:, we use Prisma's $executeRawUnsafe with the schema SQL
    await this.applySchema()

    if (!this.seeded) {
      await this.seed()
      this.seeded = true
    }

    this.server = createServer({
      prisma: this.prisma,
      botUserId: this.botUserId,
      botToken: this.botToken,
      loadGatewayState: () => this.loadGatewayState(),
    })

    const port = await startServer(this.server)
    this.server.port = port
  }

  async stop(): Promise<void> {
    if (this.server) {
      await stopServer(this.server)
      this.server = null
    }
  }

  // --- State queries for test assertions ---

  async getMessages(channelId: string): Promise<APIMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: { channelId },
      orderBy: { timestamp: 'asc' },
    })
    const result: APIMessage[] = []
    for (const msg of messages) {
      const author = await this.prisma.user.findUniqueOrThrow({
        where: { id: msg.authorId },
      })
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
      })
      result.push(
        (await import('./serializers.js')).messageToAPI(
          msg,
          author,
          channel?.guildId ?? undefined,
        ),
      )
    }
    return result
  }

  async getChannel(channelId: string): Promise<APIChannel | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })
    if (!channel) {
      return null
    }
    return channelToAPI(channel)
  }

  async getThreads(parentChannelId: string): Promise<APIChannel[]> {
    const threads = await this.prisma.channel.findMany({
      where: {
        parentId: parentChannelId,
        type: {
          in: [
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread,
          ],
        },
      },
    })
    return threads.map(channelToAPI)
  }

  async getFirstNonBotUserId(): Promise<string | null> {
    const firstUser = await this.prisma.user.findFirst({
      where: { bot: false },
      orderBy: { id: 'asc' },
    })
    if (!firstUser) {
      return null
    }
    return firstUser.id
  }

  user(userId: string): DigitalDiscordUserActor {
    return new DigitalDiscordUserActor({
      discord: this,
      userId,
    })
  }

  bot(): DigitalDiscordUserActor {
    return this.user(this.botUserId)
  }

  // --- Test utilities ---

  async simulateUserMessage({
    channelId,
    userId,
    content,
    embeds,
    attachments,
  }: {
    channelId: string
    userId: string
    content: string
    embeds?: APIEmbed[]
    attachments?: APIAttachment[]
  }): Promise<APIMessage> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const messageId = generateSnowflake()
    await this.prisma.message.create({
      data: {
        id: messageId,
        channelId,
        authorId: userId,
        content,
        embeds: JSON.stringify(embeds ?? []),
        attachments: JSON.stringify(attachments ?? []),
      },
    })
    await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        lastMessageId: messageId,
        messageCount: { increment: 1 },
        totalMessageSent: { increment: 1 },
      },
    })
    const dbMessage = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
    })
    const author = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    })
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })
    const guildId = channel?.guildId ?? undefined
    const member = guildId
      ? await this.prisma.guildMember.findUnique({
          where: { guildId_userId: { guildId, userId } },
          include: { user: true },
        })
      : null
    const apiMessage = messageToAPI(
      dbMessage,
      author,
      guildId,
      member ?? undefined,
    )
    this.server.gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
    return apiMessage
  }

  async simulateInteraction({
    type,
    channelId,
    userId,
    data,
    guildId,
    messageId,
  }: {
    type: InteractionType
    channelId: string
    userId: string
    data?: Record<string, unknown>
    guildId?: string
    messageId?: string
  }): Promise<{ id: string; token: string }> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const interactionId = generateSnowflake()
    const interactionToken = `test-interaction-token-${interactionId}`
    const resolvedGuildId = guildId ?? this.guildId

    // Pre-create the InteractionResponse row so the callback endpoint can find it
    await this.prisma.interactionResponse.create({
      data: {
        interactionId,
        interactionToken,
        applicationId: this.botUserId,
        channelId,
        type: 0, // placeholder, updated when callback is received
        messageId: messageId ?? null,
        acknowledged: false,
      },
    })

    // Build the INTERACTION_CREATE gateway payload
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    })
    const member = await this.prisma.guildMember.findUnique({
      where: { guildId_userId: { guildId: resolvedGuildId, userId } },
      include: { user: true },
    })
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })

    let messageData: APIMessage | undefined = undefined
    if (messageId) {
      const msg = await this.prisma.message.findUniqueOrThrow({
        where: { id: messageId },
      })
      const msgAuthor = await this.prisma.user.findUniqueOrThrow({
        where: { id: msg.authorId },
      })
      const msgMember = resolvedGuildId
        ? await this.prisma.guildMember.findUnique({
            where: {
              guildId_userId: {
                guildId: resolvedGuildId,
                userId: msg.authorId,
              },
            },
            include: { user: true },
          })
        : null
      messageData = messageToAPI(
        msg,
        msgAuthor,
        resolvedGuildId,
        msgMember ?? undefined,
      )
    }

    // APIInteraction is a discriminated union keyed by `type` -- the concrete
    // variant is only known at runtime, so `as APIInteraction` is justified
    const interactionPayload = {
      id: interactionId,
      application_id: this.botUserId,
      type,
      data: data ?? {},
      guild_id: resolvedGuildId,
      channel_id: channelId,
      channel: channel ? channelToAPI(channel) : undefined,
      message: messageData,
      member: member
        ? {
            user: userToAPI(member.user),
            nick: member.nick ?? undefined,
            roles: JSON.parse(member.roles) as string[],
            joined_at: member.joinedAt.toISOString(),
            deaf: member.deaf,
            mute: member.mute,
            flags: 0,
            permissions: member.permissions ?? '1099511627775',
          }
        : undefined,
      token: interactionToken,
      version: 1,
      app_permissions: '1099511627775',
      locale: 'en-US',
      guild_locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: {},
      context: 0,
      attachment_size_limit: 26214400,
    } as unknown as APIInteraction

    this.server.gateway.broadcast(
      GatewayDispatchEvents.InteractionCreate,
      interactionPayload,
    )

    return { id: interactionId, token: interactionToken }
  }

  async simulateSlashCommand({
    channelId,
    userId,
    name,
    commandId,
    options,
    guildId,
  }: {
    channelId: string
    userId: string
    name: string
    commandId?: string
    options?: DigitalDiscordCommandOption[]
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    return this.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId,
      guildId,
      data: {
        id: commandId ?? generateSnowflake(),
        name,
        type: 1,
        ...(options && options.length > 0 ? { options } : {}),
      },
    })
  }

  async simulateButtonClick({
    channelId,
    userId,
    messageId,
    customId,
    guildId,
  }: {
    channelId: string
    userId: string
    messageId: string
    customId: string
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    return this.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId,
      guildId,
      messageId,
      data: {
        custom_id: customId,
        component_type: ComponentType.Button,
      },
    })
  }

  async simulateSelectMenu({
    channelId,
    userId,
    messageId,
    customId,
    values,
    guildId,
  }: {
    channelId: string
    userId: string
    messageId: string
    customId: string
    values: string[]
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    return this.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId,
      guildId,
      messageId,
      data: {
        custom_id: customId,
        component_type: ComponentType.StringSelect,
        values,
      },
    })
  }

  async simulateModalSubmit({
    channelId,
    userId,
    customId,
    fields,
    guildId,
  }: {
    channelId: string
    userId: string
    customId: string
    fields: DigitalDiscordModalField[]
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    const components = fields.map((field) => {
      return {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: field.customId,
            value: field.value,
          },
        ],
      }
    })

    return this.simulateInteraction({
      type: InteractionType.ModalSubmit,
      channelId,
      userId,
      guildId,
      data: {
        custom_id: customId,
        components,
      },
    })
  }

  async getInteractionResponse(interactionId: string): Promise<{
    interactionId: string
    interactionToken: string
    applicationId: string
    channelId: string
    type: number
    messageId: string | null
    data: string | null
    acknowledged: boolean
  } | null> {
    return this.prisma.interactionResponse.findUnique({
      where: { interactionId },
    })
  }

  async waitForInteractionResponse({
    interactionId,
    timeout = 10000,
  }: {
    interactionId: string
    timeout?: number
  }): Promise<{
    interactionId: string
    interactionToken: string
    type: number
    messageId: string | null
    acknowledged: boolean
  }> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const response = await this.prisma.interactionResponse.findUnique({
        where: { interactionId },
      })
      if (response?.acknowledged) {
        return response
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for interaction response ${interactionId}`,
    )
  }

  async waitForBotMessage({
    channelId,
    timeout = 10000,
  }: {
    channelId: string
    timeout?: number
  }): Promise<APIMessage> {
    return this.waitForBotReply({
      channelId,
      timeout,
    })
  }

  async waitForThread({
    parentChannelId,
    timeout = 10000,
    predicate,
  }: {
    parentChannelId: string
    timeout?: number
    predicate?: DigitalDiscordThreadPredicate
  }): Promise<APIChannel> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const threads = await this.getThreads(parentChannelId)
      const matchedThreads = predicate
        ? threads.filter((thread) => {
            return predicate(thread)
          })
        : threads
      if (matchedThreads.length > 0) {
        const newestThread = [...matchedThreads].sort((a, b) => {
          return compareSnowflakeDesc(a.id, b.id)
        })[0]
        if (newestThread) {
          return newestThread
        }
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }

    throw new Error(
      `Timed out waiting for thread in parent channel ${parentChannelId}`,
    )
  }

  async waitForMessage({
    channelId,
    timeout = 10000,
    predicate,
  }: {
    channelId: string
    timeout?: number
    predicate?: DigitalDiscordMessagePredicate
  }): Promise<APIMessage> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const messages = await this.getMessages(channelId)
      const matchedMessage = [...messages]
        .reverse()
        .find((message) => {
          if (!predicate) {
            return true
          }
          return predicate(message)
        })
      if (matchedMessage) {
        return matchedMessage
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }

    throw new Error(`Timed out waiting for message in channel ${channelId}`)
  }

  async waitForBotReply({
    channelId,
    timeout = 10000,
  }: {
    channelId: string
    timeout?: number
  }): Promise<APIMessage> {
    return this.waitForMessage({
      channelId,
      timeout,
      predicate: (message) => {
        return message.author.id === this.botUserId
      },
    })
  }

  async waitForInteractionAck({
    interactionId,
    timeout = 10000,
  }: {
    interactionId: string
    timeout?: number
  }) {
    return this.waitForInteractionResponse({
      interactionId,
      timeout,
    })
  }

  // --- Internal ---

  private async applySchema(): Promise<void> {
    // Create tables one at a time -- libsql doesn't support multiple
    // statements in a single $executeRawUnsafe call.
    const statements = [
      `CREATE TABLE IF NOT EXISTS "Guild" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "icon" TEXT, "description" TEXT, "features" TEXT NOT NULL DEFAULT '[]', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS "User" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL, "discriminator" TEXT NOT NULL DEFAULT '0', "avatar" TEXT, "bot" BOOLEAN NOT NULL DEFAULT false, "system" BOOLEAN NOT NULL DEFAULT false, "flags" INTEGER NOT NULL DEFAULT 0, "globalName" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "Channel" ("id" TEXT NOT NULL PRIMARY KEY, "guildId" TEXT, "type" INTEGER NOT NULL, "name" TEXT, "topic" TEXT, "parentId" TEXT, "position" INTEGER NOT NULL DEFAULT 0, "ownerId" TEXT, "archived" BOOLEAN NOT NULL DEFAULT false, "locked" BOOLEAN NOT NULL DEFAULT false, "autoArchiveDuration" INTEGER NOT NULL DEFAULT 1440, "archiveTimestamp" DATETIME, "lastMessageId" TEXT, "messageCount" INTEGER NOT NULL DEFAULT 0, "memberCount" INTEGER NOT NULL DEFAULT 0, "totalMessageSent" INTEGER NOT NULL DEFAULT 0, "rateLimitPerUser" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Channel_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS "Message" ("id" TEXT NOT NULL PRIMARY KEY, "channelId" TEXT NOT NULL, "authorId" TEXT NOT NULL, "content" TEXT NOT NULL DEFAULT '', "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "editedTimestamp" DATETIME, "tts" BOOLEAN NOT NULL DEFAULT false, "mentionEveryone" BOOLEAN NOT NULL DEFAULT false, "pinned" BOOLEAN NOT NULL DEFAULT false, "type" INTEGER NOT NULL DEFAULT 0, "flags" INTEGER NOT NULL DEFAULT 0, "embeds" TEXT NOT NULL DEFAULT '[]', "components" TEXT NOT NULL DEFAULT '[]', "attachments" TEXT NOT NULL DEFAULT '[]', "mentions" TEXT NOT NULL DEFAULT '[]', "mentionRoles" TEXT NOT NULL DEFAULT '[]', "nonce" TEXT, "webhookId" TEXT, "applicationId" TEXT, "messageReference" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS "GuildMember" ("guildId" TEXT NOT NULL, "userId" TEXT NOT NULL, "nick" TEXT, "roles" TEXT NOT NULL DEFAULT '[]', "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "deaf" BOOLEAN NOT NULL DEFAULT false, "mute" BOOLEAN NOT NULL DEFAULT false, "permissions" TEXT, PRIMARY KEY ("guildId", "userId"), CONSTRAINT "GuildMember_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "GuildMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS "Role" ("id" TEXT NOT NULL PRIMARY KEY, "guildId" TEXT NOT NULL, "name" TEXT NOT NULL, "color" INTEGER NOT NULL DEFAULT 0, "hoist" BOOLEAN NOT NULL DEFAULT false, "position" INTEGER NOT NULL DEFAULT 0, "permissions" TEXT NOT NULL DEFAULT '0', "managed" BOOLEAN NOT NULL DEFAULT false, "mentionable" BOOLEAN NOT NULL DEFAULT false, "flags" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "Role_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS "Reaction" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "messageId" TEXT NOT NULL, "userId" TEXT NOT NULL, "emoji" TEXT NOT NULL, CONSTRAINT "Reaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "Reaction_messageId_userId_emoji_key" ON "Reaction"("messageId", "userId", "emoji")`,
      `CREATE TABLE IF NOT EXISTS "ThreadMember" ("channelId" TEXT NOT NULL, "userId" TEXT NOT NULL, "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("channelId", "userId"), CONSTRAINT "ThreadMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS "ApplicationCommand" ("id" TEXT NOT NULL PRIMARY KEY, "applicationId" TEXT NOT NULL, "guildId" TEXT, "name" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '', "type" INTEGER NOT NULL DEFAULT 1, "options" TEXT NOT NULL DEFAULT '[]', "defaultMemberPermissions" TEXT, "dmPermission" BOOLEAN NOT NULL DEFAULT true, "nsfw" BOOLEAN NOT NULL DEFAULT false, "version" TEXT NOT NULL)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "ApplicationCommand_applicationId_guildId_name_key" ON "ApplicationCommand"("applicationId", "guildId", "name")`,
      `CREATE TABLE IF NOT EXISTS "InteractionResponse" ("interactionId" TEXT NOT NULL PRIMARY KEY, "interactionToken" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "channelId" TEXT NOT NULL, "type" INTEGER NOT NULL, "messageId" TEXT, "data" TEXT, "acknowledged" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "InteractionResponse_interactionToken_key" ON "InteractionResponse"("interactionToken")`,
    ]
    for (const sql of statements) {
      await this.prisma.$executeRawUnsafe(sql)
    }
  }

  private async seed(): Promise<void> {
    const opts = this.options

    // Create bot user
    await this.prisma.user.create({
      data: {
        id: this.botUserId,
        username: opts.botUser?.username ?? 'TestBot',
        bot: true,
        globalName: opts.botUser?.username ?? 'TestBot',
      },
    })

    // Create guild
    const ownerId = opts.guild?.ownerId ?? generateSnowflake()
    await this.prisma.guild.create({
      data: {
        id: this.guildId,
        name: opts.guild?.name ?? 'Test Server',
        ownerId,
      },
    })

    // Create @everyone role
    await this.prisma.role.create({
      data: {
        id: this.guildId,
        guildId: this.guildId,
        name: '@everyone',
        permissions: '1071698660929',
        position: 0,
      },
    })

    // Add bot as guild member
    await this.prisma.guildMember.create({
      data: {
        guildId: this.guildId,
        userId: this.botUserId,
      },
    })

    // Create additional users
    const userIds: string[] = []
    for (const userOpts of opts.users ?? []) {
      const userId = userOpts.id ?? generateSnowflake()
      userIds.push(userId)
      await this.prisma.user.create({
        data: {
          id: userId,
          username: userOpts.username,
          bot: userOpts.bot ?? false,
          globalName: userOpts.username,
        },
      })
      await this.prisma.guildMember.create({
        data: {
          guildId: this.guildId,
          userId,
        },
      })
    }

    // Create channels
    for (const chOpts of opts.channels ?? []) {
      await this.prisma.channel.create({
        data: {
          id: chOpts.id ?? generateSnowflake(),
          guildId: this.guildId,
          type: chOpts.type,
          name: chOpts.name,
          topic: chOpts.topic,
          parentId: chOpts.parentId,
        },
      })
    }
  }

  private async loadGatewayState(): Promise<GatewayState> {
    const botUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: this.botUserId },
    })

    const guilds = await this.prisma.guild.findMany({
      include: {
        roles: true,
        members: { include: { user: true } },
        channels: true,
      },
    })

    return {
      botUser: userToAPI(botUser),
      guilds: guilds.map((guild) => ({
        id: guild.id,
        apiGuild: guildToAPI(guild),
        joinedAt: guild.createdAt.toISOString(),
        members: guild.members.map(memberToAPI),
        channels: guild.channels.map(channelToAPI),
      })),
    }
  }
}

export class DigitalDiscordUserActor {
  private readonly discord: DigitalDiscord
  private readonly userId: string

  constructor({ discord, userId }: { discord: DigitalDiscord; userId: string }) {
    this.discord = discord
    this.userId = userId
  }

  async sendMessage({
    channelId,
    content,
    embeds,
    attachments,
  }: {
    channelId: string
    content: string
    embeds?: APIEmbed[]
    attachments?: APIAttachment[]
  }) {
    return this.discord.simulateUserMessage({
      channelId,
      userId: this.userId,
      content,
      embeds,
      attachments,
    })
  }

  async runSlashCommand({
    channelId,
    name,
    commandId,
    options,
    guildId,
  }: {
    channelId: string
    name: string
    commandId?: string
    options?: DigitalDiscordCommandOption[]
    guildId?: string
  }) {
    return this.discord.simulateSlashCommand({
      channelId,
      userId: this.userId,
      name,
      commandId,
      options,
      guildId,
    })
  }

  async clickButton({
    channelId,
    messageId,
    customId,
    guildId,
  }: {
    channelId: string
    messageId: string
    customId: string
    guildId?: string
  }) {
    return this.discord.simulateButtonClick({
      channelId,
      userId: this.userId,
      messageId,
      customId,
      guildId,
    })
  }

  async selectMenu({
    channelId,
    messageId,
    customId,
    values,
    guildId,
  }: {
    channelId: string
    messageId: string
    customId: string
    values: string[]
    guildId?: string
  }) {
    return this.discord.simulateSelectMenu({
      channelId,
      userId: this.userId,
      messageId,
      customId,
      values,
      guildId,
    })
  }

  async submitModal({
    channelId,
    customId,
    fields,
    guildId,
  }: {
    channelId: string
    customId: string
    fields: DigitalDiscordModalField[]
    guildId?: string
  }) {
    return this.discord.simulateModalSubmit({
      channelId,
      userId: this.userId,
      customId,
      fields,
      guildId,
    })
  }
}

export { DiscordGateway } from './gateway.js'
export { generateSnowflake } from './snowflake.js'
export type { GatewayState } from './gateway.js'
