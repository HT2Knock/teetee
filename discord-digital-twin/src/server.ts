// Combined HTTP (Spiceflow) + WebSocket (ws) server on a single port.
// The Spiceflow app handles REST API routes at /api/v10/*.
// The ws WebSocketServer handles Gateway connections at /gateway.
// All routes are defined inline since each is small.

import http from 'node:http'
import { Spiceflow } from 'spiceflow'
import {
  ApplicationFlags,
  ApplicationWebhookEventStatus,
  ApplicationCommandType,
} from 'discord-api-types/v10'
import type {
  APIUser,
  APIApplication,
  APIApplicationCommand,
  RESTGetAPIGatewayBotResult,
  RESTPutAPIApplicationCommandsJSONBody,
  RESTPutAPIApplicationCommandsResult,
} from 'discord-api-types/v10'
import { DiscordGateway } from './gateway.js'
import type { GatewayState } from './gateway.js'
import type { PrismaClient } from './generated/client.js'
import { userToAPI } from './serializers.js'
import { generateSnowflake } from './snowflake.js'

// Generous fake rate limit headers so discord.js never self-throttles
const RATE_LIMIT_HEADERS: Record<string, string> = {
  'X-RateLimit-Limit': '50',
  'X-RateLimit-Remaining': '49',
  'X-RateLimit-Reset-After': '60.0',
  'X-RateLimit-Bucket': 'fake-bucket',
}

export interface ServerComponents {
  httpServer: http.Server
  gateway: DiscordGateway
  app: { handleForNode: Spiceflow['handleForNode'] }
  port: number
}

export function createServer({ prisma, botUserId, botToken, loadGatewayState }: {
  prisma: PrismaClient
  botUserId: string
  botToken: string
  loadGatewayState: () => Promise<GatewayState>
}): ServerComponents {
  const state = { port: 0 }

  const app = new Spiceflow({ basePath: '/api/v10' })

    // --- Gateway ---

    .route({
      method: 'GET',
      path: '/gateway/bot',
      handler(): RESTGetAPIGatewayBotResult {
        return {
          url: `ws://localhost:${state.port}/gateway`,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 999,
            reset_after: 14400000,
            max_concurrency: 1,
          },
        }
      },
    })

    // --- Users ---

    .route({
      method: 'GET',
      path: '/users/@me',
      async handler(): Promise<APIUser> {
        const user = await prisma.user.findUniqueOrThrow({
          where: { id: botUserId },
        })
        return userToAPI(user)
      },
    })
    .route({
      method: 'GET',
      path: '/users/:user_id',
      async handler({ params }): Promise<APIUser> {
        const user = await prisma.user.findUnique({
          where: { id: params.user_id },
        })
        if (!user) {
          throw new Response(JSON.stringify({
            code: 10013,
            message: 'Unknown User',
            errors: {},
          }), { status: 404, headers: { 'Content-Type': 'application/json' } })
        }
        return userToAPI(user)
      },
    })

    // --- Applications ---

    .route({
      method: 'GET',
      path: '/applications/@me',
      handler(): APIApplication {
        return {
          id: botUserId,
          name: 'TestBot',
          icon: null,
          description: '',
          summary: '',
          bot_public: true,
          bot_require_code_grant: false,
          verify_key: 'fake-verify-key',
          team: null,
          flags: ApplicationFlags.GatewayPresence | ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayMessageContent,
          event_webhooks_status: ApplicationWebhookEventStatus.Disabled,
        }
      },
    })
    .route({
      method: 'PUT',
      path: '/applications/:application_id/commands',
      async handler({ params, request }): Promise<RESTPutAPIApplicationCommandsResult> {
        // JSON.parse of unknown request body -- `as` is the only option
        const commands = await request.json() as RESTPutAPIApplicationCommandsJSONBody

        await prisma.applicationCommand.deleteMany({
          where: {
            applicationId: params.application_id,
            guildId: null,
          },
        })

        const results: APIApplicationCommand[] = []
        for (const cmd of commands) {
          const id = generateSnowflake()
          const version = generateSnowflake()
          const description = 'description' in cmd ? (cmd.description ?? '') : ''
          const options = 'options' in cmd ? (cmd.options ?? []) : []
          const type = cmd.type ?? ApplicationCommandType.ChatInput
          await prisma.applicationCommand.create({
            data: {
              id,
              applicationId: params.application_id,
              guildId: null,
              name: cmd.name,
              description,
              type,
              options: JSON.stringify(options),
              defaultMemberPermissions: cmd.default_member_permissions ?? null,
              dmPermission: cmd.dm_permission ?? true,
              nsfw: cmd.nsfw ?? false,
              version,
            },
          })
          const command: APIApplicationCommand = {
            id,
            application_id: params.application_id,
            name: cmd.name,
            description,
            type,
            options,
            default_member_permissions: cmd.default_member_permissions ?? null,
            dm_permission: cmd.dm_permission ?? true,
            nsfw: cmd.nsfw ?? false,
            version,
          }
          results.push(command)
        }

        return results
      },
    })

  const httpServer = http.createServer((req, res) => {
    const origWriteHead = res.writeHead.bind(res)
    // Node's writeHead has complex overloads. Intercept to inject rate
    // limit headers on every response.
    res.writeHead = function writeHeadWithRateLimits(statusCode: number, ...rest: Parameters<typeof res.writeHead> extends [number, ...infer R] ? R : never[]) {
      for (const [key, value] of Object.entries(RATE_LIMIT_HEADERS)) {
        res.setHeader(key, value)
      }
      res.setHeader('X-RateLimit-Reset', String(Date.now() / 1000 + 60))
      return origWriteHead(statusCode, ...rest)
    } as typeof res.writeHead
    return app.handleForNode(req, res)
  })

  const gateway = new DiscordGateway({
    httpServer,
    port: 0,
    loadState: loadGatewayState,
    expectedToken: botToken,
  })

  return {
    httpServer,
    gateway,
    app,
    get port() { return state.port },
    set port(v) { state.port = v },
  }
}

export function startServer(components: ServerComponents): Promise<number> {
  return new Promise((resolve, reject) => {
    components.httpServer.listen(0, () => {
      const address = components.httpServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      const port = address.port
      components.port = port
      // @ts-expect-error -- updating private field after listen
      components.gateway.port = port
      resolve(port)
    })
  })
}

export function stopServer(components: ServerComponents): Promise<void> {
  return new Promise((resolve) => {
    components.gateway.close()
    components.httpServer.close(() => {
      resolve()
    })
  })
}
