// `kimaki sleep` (spec 10.5): a one-shot wake of a session at a clock time.
//
//   kimaki sleep ─▶ createSleep ─▶ session_sleeps (wake_at = clock + duration)
//   scheduler tick ─▶ runDueWakes ─▶ wake: claim attempt ─▶ prompt (idempotent prompt ID)
//
// Any new input in the thread cancels the sleep (prompt.ts dispatch).

import crypto from 'node:crypto'

import { Effect, Semaphore } from 'effect'
import dedent from 'string-dedent'

import { fetchThread, threadOfSession, type Bot } from '../../bot.ts'
import { parseFirst, parseRows, toDbDate, type SessionSleepRow } from '../../db/rows.ts'
import { parseDuration } from '../../platform/duration.ts'
import { ConfigError, type DbError, type DiscordError } from '../../platform/errors.ts'
import { createLogger } from '../../platform/logger.ts'
import { prompt } from '../session/prompt.ts'
import { asSubtext } from '../transcript/format-parts.ts'

const logger = createLogger('TASK')

const WAKE_RETRY_MS = 30_000
const WAKE_MAX_ATTEMPTS = 5

const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/

// Also parses `--send-at` dates (scheduler.ts).
export function parseFutureUtc({
  value,
  now,
  flag,
}: {
  value: string
  now: number
  flag: string
}): ConfigError | number {
  if (!UTC_DATE.test(value)) {
    return new ConfigError({
      reason: `${flag} date must be UTC ISO format ending with Z (example: 2026-03-01T09:00:00Z). Received: ${value}`,
    })
  }
  const time = Date.parse(value)
  if (Number.isNaN(time)) return new ConfigError({ reason: `Invalid UTC date for ${flag}: ${value}` })
  if (time <= now) return new ConfigError({ reason: `${flag} must be in the future (UTC): ${value}` })
  return time
}

// `kimaki sleep`: the bot resolves the wake time with its own clock.
export function parseWakeAt({
  duration,
  until,
  now,
}: {
  duration?: string
  until?: string
  now: number
}): ConfigError | number {
  const relative = duration?.trim() ?? ''
  const absolute = until?.trim() ?? ''
  if (relative && absolute) return new ConfigError({ reason: 'Pass either --duration or --until, not both' })
  if (absolute) return parseFutureUtc({ value: absolute, now, flag: '--until' })
  if (!relative) return new ConfigError({ reason: 'Pass --duration or --until' })
  const amount = parseDuration(relative, '--duration')
  if (amount instanceof Error) return amount
  return now + amount
}

function utcLabel(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// What the agent reads after `kimaki sleep` (the V1 kimaki_sleep tool result).
function sleepOutput({ wakeAt, reason }: { wakeAt: number; reason: string | null }): string {
  return [
    `Sleeping until ${utcLabel(wakeAt)}.${reason ? ` Reason: ${reason}.` : ''}`,
    'This result is not a wake. Do not continue the waited work. Do not run more commands.',
    'Reply with one short line that you are waiting until that time, then stop.',
    'The real wake is a later message that starts with "Woke after sleeping until". Only then continue the wait reason.',
    'A new user message in this thread cancels the sleep. If you still need that later wake after answering, run kimaki sleep again with --until set to the same UTC time.',
    'When monitoring something slow (email replies, PR reviews), wait 2h or more and never post a status report on a wake where nothing changed.',
  ].join(' ')
}

export type SleepLock = <A, E>(input: { sessionId: string; run: Effect.Effect<A, E> }) => Effect.Effect<A, E>

// Writing a sleep, cancelling it on new input and delivering its wake run one
// at a time per session, so a wake never goes out after the input that cancelled it.
// One per bot (bot.features.withSleepLock); the semaphores stay in this closure.
export function createSleepLock(): SleepLock {
  // sessionId -> its write/cancel/wake lock.
  const locks = new Map<string, Semaphore.Semaphore>()
  return function withSleepLock<A, E>({ sessionId, run }: { sessionId: string; run: Effect.Effect<A, E> }) {
    let lock = locks.get(sessionId)
    if (!lock) {
      lock = Semaphore.makeUnsafe(1)
      locks.set(sessionId, lock)
    }
    return lock.withPermits(1)(run)
  }
}

// New input supersedes a pending sleep of the session (prompt.ts dispatch, /abort).
// `kimaki sleep`. One planned sleep per session; a new one replaces the old (new delivery ID).
export function createSleep(
  bot: Bot,
  { sessionId, duration, until, reason }: { sessionId: string; duration?: string; until?: string; reason?: string },
): Effect.Effect<{ sessionId: string; threadId: string; wakeAt: string; output: string }, ConfigError | DbError> {
  return Effect.gen(function* () {
    const state = bot.store.getState()
    const threadId = state.sessionThreads[sessionId]
    const root = threadId ? state.roots[threadId] : undefined
    if (!threadId || !root) {
      return yield* Effect.fail(
        new ConfigError({
          reason: `Session ${sessionId} has no Kimaki thread on this machine. Run kimaki sleep inside a Kimaki session.`,
        }),
      )
    }
    const time = bot.clock.now()
    const wakeAt = parseWakeAt({ duration, until, now: time })
    if (typeof wakeAt !== 'number') return yield* Effect.fail(wakeAt)
    const why = reason?.trim() || null
    const values = {
      wake_at: new Date(wakeAt),
      reason: why,
      status: 'planned' as const,
      delivery_id: crypto.randomUUID(),
      attempts: 0,
      last_attempt_at: null,
      created_at: new Date(time),
    }
    yield* bot.features.withSleepLock({
      sessionId: root,
      run: bot.query(
        'write session_sleeps',
        (sql) =>
          sql`INSERT INTO session_sleeps (session_id, wake_at, reason, status, delivery_id, attempts, last_attempt_at, created_at)
        VALUES (${root}, ${toDbDate(values.wake_at)}, ${values.reason}, ${values.status}, ${values.delivery_id}, ${values.attempts}, ${values.last_attempt_at}, ${toDbDate(values.created_at)})
        ON CONFLICT(session_id) DO UPDATE SET
          wake_at = ${toDbDate(values.wake_at)},
          reason = ${values.reason},
          status = ${values.status},
          delivery_id = ${values.delivery_id},
          attempts = ${values.attempts},
          last_attempt_at = ${values.last_attempt_at},
          created_at = ${toDbDate(values.created_at)}`,
      ),
    })
    bot.eventLoop.dispatch(threadId, { type: 'kimaki.sleep' })
    logger.log(`session ${root} sleeps until ${new Date(wakeAt).toISOString()}`)
    return {
      sessionId: root,
      threadId,
      wakeAt: new Date(wakeAt).toISOString(),
      output: sleepOutput({ wakeAt, reason: why }),
    }
  })
}

// Delivers a due wake if it is still the planned sleep and its retry delay
// passed. The prompt ID comes from the delivery ID, so a retried wake cannot
// deliver twice: OpenCode returns the existing inbox item for a repeated ID
// (sleep.e2e.test.ts checks this). No interrupt: a wake joins a running turn
// at its next step.
function wake(bot: Bot, row: SessionSleepRow): Effect.Effect<void, DbError | ConfigError | DiscordError> {
  return Effect.gen(function* () {
    const sessionId = row.session_id
    const deliveryId = row.delivery_id
    const wakeAt = row.wake_at.getTime()
    const reason = row.reason?.trim() || null
    const time = bot.clock.now()
    const echo = asSubtext(`Woke after sleeping until ${utcLabel(wakeAt)}${reason ? `. Reason: ${reason}` : ''}`)
    const text = dedent`
      Woke after sleeping until ${utcLabel(wakeAt)}.${reason ? `\nReason: ${reason}` : ''}
      Continue the work you were waiting for.
    `
    const settle = (status: 'consumed' | 'failed') =>
      bot
        .query(
          `settle wake of ${sessionId}`,
          (sql) =>
            sql`UPDATE session_sleeps SET status = ${status}
          WHERE session_id = ${sessionId} AND delivery_id = ${deliveryId} AND status = ${'planned'}`,
        )
        .pipe(Effect.as(status === 'consumed' ? ('woke' as const) : ('failed' as const)))

    const deliver = Effect.gen(function* () {
      const claimed = yield* bot.query(
        `claim wake of ${sessionId}`,
        (sql) =>
          sql<{ attempts: number }>`UPDATE session_sleeps
          SET attempts = attempts + 1, last_attempt_at = ${toDbDate(new Date(time))}
          WHERE session_id = ${sessionId} AND delivery_id = ${deliveryId} AND status = ${'planned'}
            AND (last_attempt_at IS NULL OR last_attempt_at <= ${toDbDate(new Date(time - WAKE_RETRY_MS))})
          RETURNING attempts`,
      )
      const attempt = parseFirst<{ attempts: number }>('session_sleeps', claimed)
      if (!attempt) return 'stale' as const
      // Resolved now, not at sleep time: /resume may have moved the session.
      const threadId = threadOfSession(bot, sessionId)
      if (!threadId) {
        logger.warn(`no thread owns session ${sessionId}, dropping its wake`)
        return yield* settle('failed')
      }
      const thread = yield* fetchThread(bot, threadId)
      const sent = yield* prompt(bot, {
        sessionId,
        threadId,
        threadName: thread.name,
        text,
        echo,
        delivery: 'steer',
        author: { id: bot.discord.user?.id ?? '', username: 'kimaki' },
        messageId: deliveryId,
        id: `msg_sleep_${deliveryId}`,
      }).pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }))
      if (!sent) return yield* settle('consumed')
      logger.warn(`wake of ${sessionId} failed (attempt ${attempt.attempts})`, sent)
      if (attempt.attempts >= WAKE_MAX_ATTEMPTS) return yield* settle('failed')
      return 'retry' as const
    })

    const result = yield* bot.features.withSleepLock({ sessionId, run: deliver })
    if (result === 'woke') logger.log(`woke session ${sessionId}`)
  })
}

// Due wakes, oldest first, one at a time. A failed attempt waits
// WAKE_RETRY_MS; the claim in wake() checks it again.
export function runDueWakes(bot: Bot, { time, limit }: { time: number; limit: number }): Effect.Effect<void> {
  return Effect.gen(function* () {
    const rows = yield* bot.query(
      'read due sleeps',
      (sql) =>
        sql<SessionSleepRow>`SELECT * FROM session_sleeps
      WHERE status = ${'planned'} AND wake_at <= ${toDbDate(new Date(time))}
        AND (last_attempt_at IS NULL OR last_attempt_at <= ${toDbDate(new Date(time - WAKE_RETRY_MS))})
      ORDER BY wake_at ASC
      LIMIT ${limit}`,
    )
    const sleeps = parseRows<SessionSleepRow>('session_sleeps', rows)
    for (const row of sleeps) {
      const failed = yield* wake(bot, row).pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }))
      if (failed) logger.warn(failed)
    }
  }).pipe(Effect.catchTag('DbError', (error) => Effect.sync(() => logger.error(error))))
}
