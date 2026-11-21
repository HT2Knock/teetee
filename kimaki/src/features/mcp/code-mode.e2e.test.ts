// The agent reaches Discord through the MCP server from Code Mode. The model
// returns one `execute` tool call whose code calls `tools.discord.send`, so the
// test proves the MCP registration and the tool name end to end.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'

import type { BotHandle } from '../../main.ts'
import {
  scriptedTurn,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from '../../test/harness.ts'
import { send } from '../session/input.ts'

const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle

beforeAll(async () => {
  twin = await startTwin()
  server = await startOpencodeTestServer({
    matchers: scriptedTurn({
      marker: 'code-mode-marker',
      steps: [
        {
          id: 'code-mode-call',
          tool: 'execute',
          input: {
            description: 'Send a Discord message through the MCP',
            code: `return await tools.discord.send({ channelId: '${twin.channelId}', prompt: 'code-mode-message' })`,
          },
        },
      ],
      finalText: 'code-mode done',
    }),
  })
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('the agent calls tools.discord.send from Code Mode', async () => {
  const started = await send(bot, { channelId: twin.channelId, prompt: 'code-mode-marker' })
  if (started instanceof Error) throw started
  if (!started.threadId) throw new Error('thread was not created')
  await waitForFooter({ discord: twin.discord, threadId: started.threadId })

  const sent = await twin.discord.channel(twin.channelId).waitForThread({
    predicate: (thread) => (thread.name ?? '').includes('code-mode-message'),
  })
  expect(await twin.discord.thread(sent.id).text()).toContain('code-mode-message')
  expect(await twin.discord.thread(started.threadId).text()).toContain('code-mode done')
})
