// Temporary bridge for callers that still return `T | Error` from an async
// function. Phase 4 deletes this once every module yields its Effect.

import { Cause, Effect, Exit } from 'effect'

// The inverse of runResult: an Effect for a promise function that still reports
// its failure as a value. A converted module uses it to call the helpers that
// have not converted yet.
export function fromResult<T>(run: () => Promise<T>): Effect.Effect<Exclude<T, Error>, Extract<T, Error>> {
  return Effect.gen(function* () {
    const result = yield* Effect.promise(run)
    if (result instanceof Error) return yield* Effect.fail(result as Extract<T, Error>)
    return result as Exclude<T, Error>
  })
}

// The failure keeps its tagged type, so a still-promise caller returns the same
// union it returned before the conversion.
export async function runResult<A, E extends Error>(effect: Effect.Effect<A, E>): Promise<E | A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const cause = Cause.squash(exit.cause)
  // A typed failure squashes back to E. A defect is not E, so it becomes a plain
  // Error with the same message, which every caller already reports.
  return (cause instanceof Error ? cause : new Error(String(cause))) as E
}
