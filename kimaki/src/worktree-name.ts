// A Git worktree name: the one rule both the checkout code and the `kimaki send`
// schema apply. Kept apart from worktrees.ts so the send rules stay free of
// child_process and the filesystem.

import { ConfigError } from './errors.ts'

export function worktreeName(name: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    return new ConfigError({ reason: 'Use a worktree name of at most 64 lowercase letters, digits and hyphens.' })
  }
  return name
}
