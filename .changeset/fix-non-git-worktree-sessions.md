---
'kimaki': patch
---

Fix automatic worktree sessions for project directories that are not git repository roots.

When worktrees are enabled but the configured project folder is not the git root, Kimaki now starts a normal session in that folder instead of creating a failed worktree record that makes every follow-up message reply with a worktree error.

Fixes #112
