// Sleep rows that other modules cancel without running a wake. `kimaki sleep`
// and the wake loop live in sleeps.ts, which imports prompt.ts; this module has
// no prompt dependency, so prompt.ts can cancel a sleep without an import
// cycle.

import { Effect } from 'effect'

import type { Bot } from './bot.ts'
import { type DbError } from './errors.ts'
import { createLogger } from './logger.ts'

const logger = createLogger('SLEEP')

// Any new input in the thread ends a planned sleep: the user is here now.
export function cancelSleep(bot: Bot, sessionId: string): Effect.Effect<void, DbError> {
  return Effect.gen(function* () {
    const cancelled = yield* bot.features.withSleepLock({
      sessionId,
      run: bot.query(
        'cancel sleep',
        (sql) =>
          sql<{
            session_id: string
          }>`UPDATE session_sleeps SET status = ${'cancelled'} WHERE session_id = ${sessionId} AND status = ${'planned'} RETURNING session_id`,
      ),
    })
    if (cancelled.length > 0) logger.log(`sleep of session ${sessionId} cancelled by new input`)
  })
}
