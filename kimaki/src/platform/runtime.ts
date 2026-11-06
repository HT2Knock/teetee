// What runtime is running this process, in one place.
//
// Kimaki runs on Bun only. Bun runs TypeScript directly, so a Kimaki entrypoint
// needs no loader and there is no second runtime to switch to. Code that spawns
// a Kimaki entrypoint asks here, instead of reading `process.execPath` by hand.

// The one runtime Kimaki runs on. `kimaki status` reports it.
export const RUNTIME_NAME = 'bun'

// The executable that runs this process.
export function runtimeExecutable(): string {
  return process.execPath
}

// argv that runs `entry`: `[executable, entry, ...args]`.
export function entryArgv(
  entry: string,
  args: readonly string[] = [],
  options: { executable?: string } = {},
): string[] {
  return [options.executable ?? runtimeExecutable(), entry, ...args]
}

// argv that runs an inline module.
export function evalArgv(code: string, options: { executable?: string } = {}): string[] {
  return [options.executable ?? runtimeExecutable(), '--eval', code]
}
