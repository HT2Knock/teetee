// Sleep rows that other modules cancel without running a wake. `kimaki sleep`
// and the wake loop live in sleeps.ts, which imports prompt.ts; this module has
// no prompt dependency, so prompt.ts can cancel a sleep without an import
// cycle.

import type { Bot } from './bot.ts'
import { DbError } from './errors.ts'
import { createLogger } from './logger.ts'

const logger = createLogger('SLEEP')

// Any new input in the thread ends a planned sleep: the user is here now.
export async function cancelSleep(bot: Bot, sessionId: string): Promise<void> {
  const cancelled = await bot.features.withSleepLock({
    sessionId,
    run: () =>
      bot.db<{ session_id: string }[]>`UPDATE session_sleeps SET status = ${'cancelled'} WHERE session_id = ${sessionId} AND status = ${'planned'} RETURNING session_id`
        .catch((cause) => new DbError({ operation: 'cancel sleep', cause })),
  })
  if (cancelled instanceof Error) return logger.warn(cancelled)
  if (cancelled.length > 0) logger.log(`sleep of session ${sessionId} cancelled by new input`)
}
