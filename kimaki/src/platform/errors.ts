// Tagged errors shared across kimaki modules (errors as values: return, don't throw).
//
// Every class is an Effect `Data.TaggedError`, so `_tag` discriminates the union
// and an Effect program can recover with `Effect.catchTag` or yield the value
// inside `Effect.gen`. Messages are built in the constructor, which keeps the
// call sites the same as before (`new DbError({ operation, cause })`).

import { Data } from 'effect'

// Shared shape of errors that name the operation that failed.
function operationError<Tag extends string>(tag: Tag, label: string) {
  return class extends Data.TaggedError(tag)<{ operation: string; message: string; cause?: unknown }> {
    constructor({ operation, cause }: { operation: string; cause?: unknown }) {
      super({ operation, cause, message: `${label} ${operation} failed` })
    }
  }
}

// Runs `run` and turns a thrown error into `handle(cause)`; a thrown value that
// is not an Error is rethrown, because it is a bug, not a failure to report.
export function attempt<T>(run: () => T): T | Error
export function attempt<T, E>(run: () => T, handle: (cause: Error) => E): T | E
export function attempt<T, E>(run: () => T, handle?: (cause: Error) => E): T | E | Error {
  try {
    return run()
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause
    return handle ? handle(cause) : cause
  }
}

export class OpenCodeError extends operationError('OpenCodeError', 'OpenCode') {}
export class DiscordError extends operationError('DiscordError', 'Discord') {}
export class DbError extends operationError('DbError', 'Database') {}
export class FilesystemError extends operationError('FilesystemError', 'Filesystem') {}

export class OpenCodeUnavailableError extends Data.TaggedError('OpenCodeUnavailableError')<{
  reason: string
  message: string
  cause?: unknown
}> {
  constructor({ reason, cause }: { reason: string; cause?: unknown }) {
    super({ reason, cause, message: `OpenCode service not reachable (${reason})` })
  }
}

export class OpenCodeMissingError extends Data.TaggedError('OpenCodeMissingError')<{
  install: string
  message: string
  cause?: unknown
}> {
  constructor({ install, cause }: { install: string; cause?: unknown }) {
    super({
      install,
      cause,
      message: `Kimaki requires OpenCode 2, which is not installed. Install it with: ${install} (or: bun add -g @opencode/cli). Then run kimaki again`,
    })
  }
}

export class OpenCodeV1Error extends Data.TaggedError('OpenCodeV1Error')<{
  binary: string
  version: string
  install: string
  message: string
  cause?: unknown
}> {
  constructor({
    binary,
    version,
    install,
    cause,
  }: {
    binary: string
    version: string
    install: string
    cause?: unknown
  }) {
    super({
      binary,
      version,
      install,
      cause,
      message: `Kimaki now requires OpenCode 2, but ${binary} is OpenCode ${version}. Install OpenCode 2 with: ${install} (or: bun add -g @opencode/cli). Then run kimaki again. To keep using OpenCode 1, run the older Kimaki instead: bunx kimaki@0`,
    })
  }
}

export class OpenCodeVersionError extends Data.TaggedError('OpenCodeVersionError')<{
  version: string
  minimum: string
  message: string
  cause?: unknown
}> {
  constructor({ version, minimum, cause }: { version: string; minimum: string; cause?: unknown }) {
    super({
      version,
      minimum,
      cause,
      message: `OpenCode ${version} is older than the minimum ${minimum}. Run: opencode upgrade`,
    })
  }
}

// The CLI found no running bot (no lock token, or nothing answers on the lock port).
export class BotNotRunningError extends Data.TaggedError('BotNotRunningError')<{
  message: string
  cause?: unknown
}> {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({ cause, message: 'Kimaki bot is not running. Start kimaki first.' })
  }
}

export class DbNotMigratedError extends Data.TaggedError('DbNotMigratedError')<{
  missing: string
  message: string
  cause?: unknown
}> {
  constructor({ missing, cause }: { missing: string; cause?: unknown }) {
    super({
      missing,
      cause,
      message: `Kimaki database is not set up (${missing} is missing). Run kimaki once to set up the database`,
    })
  }
}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  reason: string
  message: string
  cause?: unknown
}> {
  constructor({ reason, cause }: { reason: string; cause?: unknown }) {
    super({ reason, cause, message: reason })
  }
}

export class LockPortError extends Data.TaggedError('LockPortError')<{
  port: number
  reason: string
  message: string
  cause?: unknown
}> {
  constructor({ port, reason, cause }: { port: number; reason: string; cause?: unknown }) {
    super({ port, reason, cause, message: `Could not take lock port ${port}: ${reason}` })
  }
}
