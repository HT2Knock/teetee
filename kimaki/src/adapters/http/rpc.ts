// Single-instance lock on a fixed local port (KIMAKI_LOCK_PORT, default 29988).
// A new bot takes the port over from the running one (V1 or V2), like V1 did:
//
//   new bot ─GET /health─▶ old bot: { pid, wrapperPid }   (no answer: nothing to stop)
//           ─SIGTERM wrapperPid ?? pid─▶ wait for pid to exit (20s) ─▶ SIGKILL both
//           ─▶ bind the port
//
// The wrapper (V2: the supervisor in cli/bot.ts) gets the signal, not the
// bot: a killed bot alone looks like a crash. Both wrappers forward SIGTERM
// and then exit without spawning the bot again.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { DEFAULT_LOCK_PORT } from '../../autostart.ts'
import { BotNotRunningError, ConfigError, LockPortError, attempt } from '../../errors.ts'
import { createLogger } from '../../logger.ts'

import type { LockRouteInput, LockRouteName, LockRouteOutput } from './routes.ts'
import { mcpScopeFor, type BotTokens, type McpScope } from './tokens.ts'

const logger = createLogger('LOCK')

export { DEFAULT_LOCK_PORT }

// Exit code that tells the supervisor of the root `kimaki` command (cli/bot.ts) to start the bot again.
export const RESTART_EXIT_CODE = 75

export async function installShim({
  dataDir,
  command,
}: {
  dataDir: string
  command: string
}): Promise<ConfigError | void> {
  const directory = path.join(dataDir, 'bin')
  const created = await fs.promises
    .mkdir(directory, { recursive: true })
    .catch((cause) => new ConfigError({ reason: 'Cannot create Kimaki shim directory', cause }))
  if (created instanceof Error) return created
  const file = path.join(directory, process.platform === 'win32' ? 'kimaki.cmd' : 'kimaki')
  // Bind the shim to its data dir through the env: not every command takes --data-dir.
  const script =
    process.platform === 'win32'
      ? `@echo off\r\nset "KIMAKI_DATA_DIR=${dataDir}"\r\n${command} %*\r\n`
      : `#!/bin/sh\nexport KIMAKI_DATA_DIR='${dataDir.replaceAll("'", "'\\''")}'\nexec ${command} "$@"\n`
  return fs.promises
    .writeFile(file, script, { mode: 0o700 })
    .then(() => fs.promises.chmod(file, 0o700))
    .catch((cause) => new ConfigError({ reason: 'Cannot install Kimaki command shim', cause }))
}

export type { BotTokens } from './tokens.ts'

export type LockServer = {
  port: number
  // Started by the `kimaki` supervisor (cli/bot.ts): `kimaki restart` can respawn it.
  supervised: boolean
  tokens: BotTokens
  handle: (handler: LockHandler) => void
  // The MCP handler, attached once the bot exists. Requests before that get 503.
  mcp: (handler: McpHandler) => void
  close: () => Promise<void>
}

export type LockHandler = (route: string, input: unknown, signal: AbortSignal) => Promise<Error | { data: unknown }>

export type McpHandler = (request: {
  scope: McpScope
  body: unknown
  signal: AbortSignal
}) => Promise<{ status: number; body: unknown }>

function listen(server: http.Server, port: number): Promise<NodeJS.ErrnoException | void> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      resolve(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

// PID of the supervisor while it is alive (IPC connected); an orphan bot reports none.
function wrapperPid(supervised: boolean): number | null {
  if (!supervised || !process.connected) return null
  return process.ppid
}

function isAlive(pid: number): boolean {
  const probed = attempt(
    () => process.kill(pid, 0),
    (cause) => new ConfigError({ reason: `probe PID ${pid}`, cause }),
  )
  if (!(probed instanceof Error)) return true
  // EPERM: the PID exists but belongs to another user.
  return probed.cause instanceof Error && Reflect.get(probed.cause, 'code') === 'EPERM'
}

async function waitForExit({ pid, timeoutMs }: { pid: number; timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(100)
  }
  return !isAlive(pid)
}

function sendSignal({ pid, name }: { pid: number; name: NodeJS.Signals }): void {
  const sent = attempt(
    () => process.kill(pid, name),
    (cause) => new ConfigError({ reason: `${name} to PID ${pid}`, cause }),
  )
  if (sent instanceof Error) logger.warn('cannot send', sent)
}

// Stops the kimaki bot on the port, if one answers /health. Its own shutdown
// has a deadline, so a bot still alive after the grace period is stuck.
async function evictRunningBot({ port, graceMs = 20_000 }: { port: number; graceMs?: number }): Promise<void> {
  const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })
    .then((response) => response.json())
    .catch(() => null)
  const field = (name: 'pid' | 'wrapperPid') => {
    if (!health || typeof health !== 'object') return null
    const value = Reflect.get(health, name)
    return typeof value === 'number' && value > 0 ? value : null
  }
  const pid = field('pid')
  if (!pid || pid === process.pid) return
  const reportedWrapper = field('wrapperPid')
  const wrapper = reportedWrapper && reportedWrapper !== process.ppid ? reportedWrapper : null
  logger.log(`stopping the kimaki bot on port ${port} (PID ${pid}, wrapper ${wrapper ?? 'none'})`)
  sendSignal({ pid: wrapper ?? pid, name: 'SIGTERM' })
  if (await waitForExit({ pid, timeoutMs: graceMs })) return
  logger.warn(`PID ${pid} still runs after ${graceMs / 1000}s, sending SIGKILL`)
  // Wrapper first, so it cannot spawn the bot again.
  if (wrapper) sendSignal({ pid: wrapper, name: 'SIGKILL' })
  sendSignal({ pid, name: 'SIGKILL' })
  await waitForExit({ pid, timeoutMs: 5_000 })
}

// evict: false (--if-not-running) never stops a running bot; the bind fails with EADDRINUSE instead.
export async function startLockServer({
  port,
  dataDir,
  supervised = false,
  evict = true,
}: {
  port: number
  dataDir: string
  supervised?: boolean
  evict?: boolean
}): Promise<LockPortError | LockServer> {
  // A plugin loaded by OpenCode keeps the token it registered in its MCP
  // config. Regenerating on every start would leave that registration dead
  // until the next plugin reload, so reuse the saved tokens. They stay mode
  // 0600 in the data dir.
  const savedToken = async (file: string) =>
    (await fs.promises.readFile(file, 'utf8').catch(() => '')).trim() || crypto.randomBytes(32).toString('hex')
  const controlFile = path.join(dataDir, 'lock-token')
  const notifyFile = path.join(dataDir, 'notify-token')
  const tokens: BotTokens = {
    control: await savedToken(controlFile),
    notify: await savedToken(notifyFile),
  }
  const state: { handler: LockHandler | null; mcp: McpHandler | null } = { handler: null, mcp: null }
  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_048_576) return new ConfigError({ reason: 'Request is larger than 1 MiB' })
      chunks.push(Buffer.from(chunk))
    }
    return attempt(
      () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      (cause) => new ConfigError({ reason: 'Invalid JSON request', cause }),
    )
  }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers.authorization !== `Bearer ${tokens.control}`) {
      return json(res, 401, { error: 'Not authorized. Use the lock-token of this bot.' })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' })
    if (!state.handler) return json(res, 503, { error: 'Kimaki is starting. Try again.' })
    const input = await readBody(req)
    if (input instanceof Error) return json(res, 400, { error: input.message })
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    const result = await state.handler(req.url ?? '', input, controller.signal)
    if (res.destroyed) return
    if (result instanceof Error) return json(res, result instanceof ConfigError ? 400 : 500, { error: result.message })
    json(res, 200, result.data)
  }
  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const scope = mcpScopeFor({ authorization: req.headers.authorization, tokens })
    if (!scope) return json(res, 401, { error: 'Not authorized. Use the control or notify token of this bot.' })
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' })
    if (!state.mcp) return json(res, 503, { error: 'Kimaki is starting. Try again.' })
    const body = await readBody(req)
    if (body instanceof Error) return json(res, 400, { error: body.message })
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    const result = await state.mcp({ scope, body, signal: controller.signal })
    if (res.destroyed) return
    if (result.body === null) {
      res.writeHead(result.status)
      res.end()
      return
    }
    json(res, result.status, result.body)
  }
  // Two routers on one port: /mcp for MCP, /rpc/* (and the older /kimaki/*) for the CLI.
  function handlerFor(pathname: string) {
    if (pathname === '/mcp') return handleMcp
    if (pathname.startsWith('/rpc/') || pathname.startsWith('/kimaki/')) return handle
    return null
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, wrapperPid: wrapperPid(supervised) }))
      return
    }
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    const handler = handlerFor(pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res).catch((cause) => {
      logger.error('http request failed', cause)
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: 'Kimaki request failed. Check kimaki logs.' }))
    })
  })

  // Before listening, not on EADDRINUSE: on macOS 127.0.0.1:port binds even
  // while a V1 bot holds 0.0.0.0:port (KIMAKI_INTERNET_REACHABLE_URL).
  if (evict) await evictRunningBot({ port })
  const bound = await listen(server, port)
  if (bound instanceof Error) {
    const reason =
      bound.code === 'EADDRINUSE'
        ? 'port is in use and the process on it did not stop. Stop it or set KIMAKI_LOCK_PORT to a free port'
        : bound.message
    return new LockPortError({ port, reason, cause: bound })
  }

  logger.info(`lock server listening on 127.0.0.1:${port}`)
  const written = await fs.promises
    .mkdir(dataDir, { recursive: true, mode: 0o700 })
    .then(async () => {
      await fs.promises.writeFile(controlFile, tokens.control, { mode: 0o600 })
      await fs.promises.chmod(controlFile, 0o600)
      await fs.promises.writeFile(notifyFile, tokens.notify, { mode: 0o600 })
      await fs.promises.chmod(notifyFile, 0o600)
    })
    .catch((cause) => new LockPortError({ port, reason: 'cannot write the bot tokens', cause }))
  if (written instanceof Error) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    return written
  }
  return {
    port,
    supervised,
    tokens,
    handle: (handler) => {
      state.handler = handler
    },
    mcp: (handler) => {
      state.mcp = handler
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      // Keep the tokens: a plugin (or a still-running MCP client) may hold a
      // registration, and the next start reuses the same values.
    },
  }
}

// Typed by the route table; imports only its types, so the CLI loads no bot code.
export async function callBot<N extends LockRouteName>({
  dataDir,
  route,
  input,
  signal: abortSignal,
}: {
  dataDir: string
  route: N
  input: LockRouteInput<N>
  signal?: AbortSignal
}): Promise<BotNotRunningError | ConfigError | { data: LockRouteOutput<N> }> {
  const token = await fs.promises
    .readFile(path.join(dataDir, 'lock-token'), 'utf8')
    .catch((cause) => new BotNotRunningError({ cause }))
  if (token instanceof Error) return token
  const port = Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT)
  const response = await fetch(`http://127.0.0.1:${port}/rpc/${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: abortSignal ?? AbortSignal.timeout(30_000),
  }).catch((cause: Error) =>
    // A timeout means the bot runs but is slow: only a refused connection means no bot.
    cause.name === 'TimeoutError' || cause.name === 'AbortError'
      ? new ConfigError({ reason: `Kimaki bot did not answer ${route} in time. Check kimaki logs`, cause })
      : new BotNotRunningError({ cause }),
  )
  if (response instanceof Error) return response
  const body = await response
    .json()
    .then((data: unknown) => ({ data }))
    .catch((cause) => new ConfigError({ reason: 'Invalid bot response. Check kimaki logs.', cause }))
  if (body instanceof Error) return body
  if (!response.ok) {
    const value = body.data
    const reason =
      value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
        ? value.error
        : `Bot returned HTTP ${response.status}`
    return new ConfigError({ reason })
  }
  // The bot answered this route with its run() result.
  return { data: body.data as LockRouteOutput<N> }
}
