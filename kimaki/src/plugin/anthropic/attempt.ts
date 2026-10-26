// Local helper for the Anthropic plugin: this directory imports nothing from
// kimaki outside itself, so it cannot use the shared `attempt` in `src/errors.ts`.
// Returns the thrown Error as a value, or the result. A thrown non-Error is a bug
// and is rethrown.
export function attempt<T>(run: () => T): T | Error {
  try {
    return run()
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause
    return cause
  }
}
