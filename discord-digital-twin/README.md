# Discord Digital Twin

> **Experimental and unstable.** APIs may change without notice between versions.

`discord-digital-twin` is a local Discord API twin for tests.
It runs:

- Discord-like REST routes on `/api/v10/*`
- Discord-like Gateway WebSocket on `/gateway`
- In-memory state with Prisma + libsql

The goal is testing real `discord.js` flows without calling Discord servers.

## Use Cases

- Integration test slash command flows end-to-end
- Verify message/thread/reaction behavior with real `discord.js` clients
- Reproduce interaction bugs locally with deterministic state
- Run fast CI tests without Discord network dependency

## How It Works

```text
  ┌─────────────┐
  │ vitest test │
  └──────┬──────┘
         │ 1) login() with rest.api override
         ▼
┌────────┬────────────┐           ┌───────────────────────────┐
│  discord.js Client  │─ HTTP ───▶│  DigitalDiscord REST      │
│                     │           │  (/api/v10/*)             │
└────────┬────────────┘           └─────────┬─────────────────┘
         │ 2) Gateway events                │ 3) route handlers
         ▼                                  ▼
┌────────┬─────────┐           ┌────────────┬─────────────────┐
│  Gateway WS      │◀──────────│  Prisma + libsql (memory)    │
└──────────────────┘           └──────────────────────────────┘
```

## Quick Start

```ts
import { ChannelType } from 'discord-api-types/v10'
import { DigitalDiscord } from 'discord-digital-twin'

const discord = new DigitalDiscord({
  guild: { name: 'Test Server' },
  channels: [
    {
      name: 'general',
      type: ChannelType.GuildText,
    },
  ],
  users: [{ username: 'TestUser' }],
})

await discord.start()
// use discord.restUrl in discord.js Client rest.api
// use discord.botToken in client.login()
await discord.stop()
```

## Example Vitest Interaction Test

This example shows a full interaction flow:

1. simulate a slash command from a user actor
2. handle `interactionCreate` in `discord.js`
3. send `interaction.reply()`
4. assert ack + bot message persisted

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin'

describe('slash command interaction', () => {
  let discord: DigitalDiscord
  let client: Client
  let channelId: string
  let userId: string

  beforeAll(async () => {
    discord = new DigitalDiscord({
      channels: [{ name: 'general', type: ChannelType.GuildText }],
      users: [{ username: 'TestUser' }],
    })
    await discord.start()

    const channels = await discord.prisma.channel.findMany()
    channelId = channels[0]!.id
    userId = (await discord.getFirstNonBotUserId())!

    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      rest: { api: discord.restUrl, version: '10' },
    })
    await client.login(discord.botToken)
  })

  afterAll(async () => {
    client.destroy()
    await discord.stop()
  })

  test('acknowledges and replies to slash command', async () => {
    const commandName = 'status'

    const handled = new Promise<void>((resolve) => {
      client.once('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) {
          return
        }
        if (interaction.commandName !== commandName) {
          return
        }
        await interaction.reply({ content: 'ok' })
        resolve()
      })
    })

    const interaction = await discord.user(userId).runSlashCommand({
      channelId,
      name: commandName,
    })

    const ack = await discord.waitForInteractionAck({
      interactionId: interaction.id,
    })
    await handled

    expect(ack.acknowledged).toBe(true)

    const reply = await discord.waitForBotReply({ channelId })
    expect(reply.content).toBe('ok')
  })
})
```
