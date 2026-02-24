// DigitalDiscord - Local Discord API test server.
// Creates a fake Discord server (REST + Gateway WebSocket) that discord.js
// can connect to. Used for automated testing of the Kimaki bot without
// hitting real Discord.

import { ChannelType } from 'discord-api-types/v10'
import type { APIMessage, APIChannel, APIEmbed, APIAttachment } from 'discord-api-types/v10'
import { createPrismaClient, type PrismaClient } from './db.js'
import { generateSnowflake } from './snowflake.js'
import { createServer, startServer, stopServer, type ServerComponents } from './server.js'
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
      result.push((await import('./serializers.js')).messageToAPI(
        msg,
        author,
        channel?.guildId ?? undefined,
      ))
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
        type: { in: [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread] },
      },
    })
    return threads.map(channelToAPI)
  }

  // --- Test utilities ---

  async simulateUserMessage({ channelId, userId, content, embeds, attachments }: {
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
    const dbMessage = await this.prisma.message.findUniqueOrThrow({ where: { id: messageId } })
    const author = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } })
    const guildId = channel?.guildId ?? undefined
    const member = guildId
      ? await this.prisma.guildMember.findUnique({
          where: { guildId_userId: { guildId, userId } },
          include: { user: true },
        })
      : null
    const apiMessage = messageToAPI(dbMessage, author, guildId, member ?? undefined)
    this.server.gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
    return apiMessage
  }

  async waitForBotMessage({ channelId, timeout = 10000 }: {
    channelId: string
    timeout?: number
  }): Promise<APIMessage> {
    const start = Date.now()
    const startCount = await this.prisma.message.count({
      where: { channelId, authorId: this.botUserId },
    })
    while (Date.now() - start < timeout) {
      const currentCount = await this.prisma.message.count({
        where: { channelId, authorId: this.botUserId },
      })
      if (currentCount > startCount) {
        const msg = await this.prisma.message.findFirst({
          where: { channelId, authorId: this.botUserId },
          orderBy: { timestamp: 'desc' },
        })
        if (msg) {
          const author = await this.prisma.user.findUniqueOrThrow({ where: { id: this.botUserId } })
          const channel = await this.prisma.channel.findUnique({ where: { id: channelId } })
          return messageToAPI(msg, author, channel?.guildId ?? undefined)
        }
      }
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
    throw new Error(`Timed out waiting for bot message in channel ${channelId}`)
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

export { DiscordGateway } from './gateway.js'
export { generateSnowflake } from './snowflake.js'
export type { GatewayState } from './gateway.js'
