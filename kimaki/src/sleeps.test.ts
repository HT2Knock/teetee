// The per-session sleep lock (sleeps.ts). Writing a sleep, cancelling it on new
// input and delivering its wake must never interleave for one session, and a
// failed run must let the next one start.

import { expect, test } from 'bun:test'

import { Effect } from 'effect'

import { ConfigError } from './errors.ts'
import { createSleepLock } from './sleeps.ts'

const tick = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    }),
)

test('the sleep lock runs one session at a time and releases after a failure', async () => {
  const withSleepLock = createSleepLock()
  const active = new Map<string, number>()
  const peak = new Map<string, number>()
  const done = new Map<string, number>()
  const body = (sessionId: string) =>
    Effect.gen(function* () {
      const now = (active.get(sessionId) ?? 0) + 1
      active.set(sessionId, now)
      peak.set(sessionId, Math.max(peak.get(sessionId) ?? 0, now))
      yield* tick
      active.set(sessionId, now - 1)
      done.set(sessionId, (done.get(sessionId) ?? 0) + 1)
    })
  const runs = [
    withSleepLock({ sessionId: 'a', run: body('a') }),
    withSleepLock({ sessionId: 'a', run: Effect.fail(new ConfigError({ reason: 'no thread on this machine' })) }),
    withSleepLock({ sessionId: 'a', run: body('a') }),
    withSleepLock({ sessionId: 'b', run: body('b') }),
    withSleepLock({ sessionId: 'b', run: body('b') }),
  ]
  const exits = await Effect.runPromise(Effect.forEach(runs, (run) => Effect.exit(run), { concurrency: 'unbounded' }))
  expect(exits.map((exit) => exit._tag)).toEqual(['Success', 'Failure', 'Success', 'Success', 'Success'])
  // Two bodies per session never overlap, and the failure did not strand the queue.
  expect(Object.fromEntries(peak)).toEqual({ a: 1, b: 1 })
  expect(Object.fromEntries(done)).toEqual({ a: 2, b: 2 })
})
