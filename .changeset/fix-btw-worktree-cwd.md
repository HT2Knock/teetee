---
'kimaki': patch
---

Fix `/btw`, `. btw` suffix, and user-defined OpenCode commands running in the base project directory instead of the active worktree directory. Sessions forked or commands run from worktree threads now correctly use the worktree path.
