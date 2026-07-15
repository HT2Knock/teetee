---
'kimaki': minor
---

Allow `/new-session` command inside threads, not just text channels.

When used in a thread, the new session inherits the same working directory as the current session. This means worktree threads create sibling sessions in the same worktree folder, and workspace threads stay in the same workspace. The new thread is always created in the parent text channel.
