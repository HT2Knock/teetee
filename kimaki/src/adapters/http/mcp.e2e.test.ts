// MCP contract: the /mcp endpoint on the bot's HTTP server registers nothing
// itself; a client calls initialize, tools/list and tools/call like OpenCode
// does. The control token sees every tool; the notify token only the tools that
// post to Discord, and never a session start or a transcript read.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'

import { send } from '../../input.ts'
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

const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle

beforeAll(async () => {
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      matchers: scriptedTurn({ marker: 'mcp-marker', steps: [], finalText: 'mcp answer' }),
    }),
    startTwin(),
  ])
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  bot = await startTestBot({ dataDir, twin, server })
  await warmUp({ server })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

type RpcResponse = { jsonrpc: string; id: unknown; result?: unknown; error?: { message: string } }

async function mcp(
  token: string,
  method: string,
  params?: unknown,
): Promise<{ status: number; body: RpcResponse | null; text: string }> {
  const response = await fetch(`http://127.0.0.1:${bot.lock.port}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as RpcResponse) : null, text }
}

function toolNames(body: RpcResponse | null): string[] {
  const result = body?.result as { tools?: { name: string }[] } | undefined
  return (result?.tools ?? []).map((tool) => tool.name).sort()
}

test('the control token lists every MCP tool and the notify token a subset', async () => {
  const control = await mcp(bot.lock.tokens.control, 'tools/list')
  const notify = await mcp(bot.lock.tokens.notify, 'tools/list')
  const anonymous = await fetch(`http://127.0.0.1:${bot.lock.port}/mcp`, { method: 'POST', body: '{}' })
  expect(anonymous.status).toBe(401)
  expect({ control: toolNames(control.body), notify: toolNames(notify.body) }).toMatchInlineSnapshot(`
    {
      "control": [
        "buttons",
        "project_list",
        "routine_list",
        "send",
        "session_archive",
        "session_list",
        "session_read",
        "sleep",
        "upload",
        "user_lookup",
      ],
      "notify": [
        "buttons",
        "send",
        "upload",
        "user_lookup",
      ],
    }
  `)
})

test('MCP send posts a Discord message and waits for the turn', async () => {
  const started = await send(bot, { channelId: twin.channelId, prompt: 'MCP first turn mcp-marker' })
  if (started instanceof Error) throw started
  if (!started.threadId) throw new Error('thread was not created')
  await waitForFooter({ discord: twin.discord, threadId: started.threadId })

  const called = await mcp(bot.lock.tokens.notify, 'tools/call', {
    name: 'send',
    arguments: { threadId: started.threadId, prompt: 'MCP second turn mcp-marker' },
  })
  expect(called.status).toBe(200)
  await waitForFooter({ discord: twin.discord, threadId: started.threadId, count: 2 })
  expect(await twin.discord.thread(started.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** MCP first turn mcp-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    mcp answer
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    mcp answer
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('the notify token cannot start a session or call a control tool', async () => {
  const start = await mcp(bot.lock.tokens.notify, 'tools/call', {
    name: 'send',
    arguments: { channelId: twin.channelId, prompt: 'notify start' },
  })
  const listed = await mcp(bot.lock.tokens.notify, 'tools/list')
  const controlOnly = ['project_list', 'session_list', 'session_read', 'session_archive', 'sleep', 'routine_list']
  const rejected: Record<string, boolean> = {}
  for (const name of controlOnly) {
    const call = await mcp(bot.lock.tokens.notify, 'tools/call', { name, arguments: {} })
    rejected[name] = Boolean((call.body?.result as { isError?: boolean } | undefined)?.isError)
  }
  expect({
    start: Boolean((start.body?.result as { isError?: boolean } | undefined)?.isError),
    rejected,
    listed: controlOnly.filter((name) => toolNames(listed.body).includes(name)),
  }).toEqual({
    start: true,
    rejected: Object.fromEntries(controlOnly.map((name) => [name, true])),
    listed: [],
  })
})
