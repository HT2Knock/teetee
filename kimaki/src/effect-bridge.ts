// Temporary bridge for callers that still return `T | Error` from an async
// function. Phase 4 deletes this once every module yields its Effect.

import { Cause, Effect, Exit } from 'effect'

export async function runResult<A>(effect: Effect.Effect<A, Error>): Promise<Error | A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const cause = Cause.squash(exit.cause)
  return cause instanceof Error ? cause : new Error(String(cause))
}
