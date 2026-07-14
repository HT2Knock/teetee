---
'kimaki': patch
---

Fix `kimaki send --channel` to auto-create worktrees when `/toggle-worktrees` is enabled for the channel.

Previously, `kimaki send --channel` only created worktrees when the `--worktree` flag was explicitly passed.
The per-channel toggle and global `--worktrees` CLI flag were ignored, even though direct channel messages,
`/agent` quick-prompts, and user commands all respected them. Now the bot-side ThreadCreate handler checks
both `useWorktrees` (global flag) and `getChannelWorktreesEnabled` (per-channel toggle) and auto-derives
a worktree name from the thread title when enabled.
