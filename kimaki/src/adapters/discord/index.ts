// The one module that imports discord.js. Core modules and tests import the
// Discord types and builders from here, so the library stays replaceable and a
// single import site can be audited (see boundary.test.ts).
//
// `export *` keeps every discord.js type and builder reachable without
// re-listing the surface, which would drift as commands add builders.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'

import { DiscordError } from '../../errors.ts'
import { createLogger } from '../../logger.ts'

export * from 'discord.js'

const logger = createLogger('DISCORD')

const DISCORD_CLOSE_WAIT_MS = 500

export type DiscordClientOptions = {
  // discord.js REST `api` URL: the digital twin in tests, null for discord.com.
  // The WebSocket URL comes from GET /gateway/bot on that host.
  restUrl?: string | null
}

// Callers own login and destroy.
export function createDiscordClient(options: DiscordClientOptions = {}): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    ...(options.restUrl && { rest: { api: options.restUrl, version: '10' } }),
  })
  // TODO: drop this once @discordjs/rest can keep its token on 401. handleErrors()
  // calls setToken(null) on any 401, and every later request fails with "Expected
  // token to be set" until a restart. One transient 401 must not kill the bot.
  // Only Client.destroy() may clear it: it sets client.token to null first.
  // https://github.com/discordjs/discord.js/blob/main/packages/rest/src/lib/handlers/Shared.ts
  const setToken = client.rest.setToken.bind(client.rest)
  client.rest.setToken = (token) => {
    // Typed string, but handleErrors() and destroy() pass null.
    if (!token && client.token !== null) {
      logger.warn('Discord REST answered 401; keeping the bot token for the next request')
      return client.rest
    }
    return setToken(token)
  }
  // Gateway lifecycle, to debug reconnects that break event delivery.
  client.on(Events.ShardDisconnect, (event, id) =>
    logger.warn(`gateway shard ${id} disconnected with code ${event.code}`),
  )
  client.on(Events.ShardReconnecting, (id) => logger.warn(`gateway shard ${id} reconnecting`))
  client.on(Events.ShardResume, (id, replayed) =>
    logger.info(`gateway shard ${id} resumed, ${replayed} events replayed`),
  )
  client.on(Events.ShardReady, (id) => logger.info(`gateway shard ${id} ready`))
  client.on(Events.ShardError, (error, id) => logger.warn(`gateway shard ${id} error`, error))
  return client
}

export async function loginDiscord({ client, token }: { client: Client; token: string }): Promise<DiscordError | void> {
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
  const login = await client.login(token).catch((cause) => new DiscordError({ operation: 'login', cause }))
  if (login instanceof Error) return login
  await ready
}

export { DISCORD_CLOSE_WAIT_MS }
