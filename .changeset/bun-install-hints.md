---
'kimaki': patch
---

Point the install instructions at bun instead of npm.

Error messages now say `bun add -g @opencode/cli`, `bunx kimaki@0` and `bun add -g critique`. Kimaki also looks for OpenCode in `~/.bun/bin`, so a global bun install is found when the shell that starts the bot does not have that folder on PATH.
