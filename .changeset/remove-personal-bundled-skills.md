---
'kimaki': patch
---

Stop bundling personal-only skills in the Kimaki npm package.

The shipped skills list now excludes workflow-specific skills such as `jitter`, `proxyman`, `x-articles`, and state-management guidance that belongs in a personal OpenCode config. This keeps the installed package focused on Kimaki features and avoids exposing unrelated personal automation tools to users.
