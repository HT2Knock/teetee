// Which project channel a target belongs to. One place for the answer, because
// the rule was written six times: the slash-command context, the thread
// helpers, the CLI routes, `kimaki send`, the routine runner and the
// directory-to-channel scan.
//
// This module owns the channel_directories lookups by channel ID and by
// directory. The joined shapes (channel defaults, worktree settings,
// guild filters) stay with the feature that needs them.

import path from 'node:path'

import { Effect } from 'effect'

import { projectOf, type Bot } from './bot.ts'
import { ConfigError, type DbError } from './errors.ts'
import { parseFirst, type ChannelDirectoryRow } from './rows.ts'

// The project row of a `kimaki send` target: --channel/--thread or --project.
// null means this machine has no channel for it, which the caller reports.
export function projectOfTarget(
  bot: Bot,
  { channelId, project }: { channelId?: string; project?: string },
): Effect.Effect<ChannelDirectoryRow | null, DbError | ConfigError> {
  return Effect.gen(function* () {
    if (channelId) return yield* projectOf(bot, channelId)
    if (!project) return yield* Effect.fail(new ConfigError({ reason: 'Pass --channel, --project or --thread' }))
    const directory = path.resolve(project)
    const rows = yield* bot.query(
      'read channel_directories by directory',
      (sql) => sql<ChannelDirectoryRow[]>`SELECT * FROM channel_directories WHERE directory = ${directory} LIMIT 1`,
    )
    return parseFirst<ChannelDirectoryRow>('channel_directories', rows) ?? null
  })
}
