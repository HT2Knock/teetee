---
'kimaki': minor
---

Run the bot and the CLI on Bun as well as Node.

Bun runs the TypeScript sources directly, so the CLI and the test suite need no Node loader. The published package still starts from `dist/cli.js`, which runs on both runtimes. Kimaki uses the runtime it is already running on, so `bun dist/cli.js` works without extra flags.

`kimaki status` reports which runtime the bot uses:

```
running: pid 1234, up 42s, mode "self_hosted"
runtime: bun
```

The test suite runs on either runtime. Inside `kimaki/`, `bun run bun:check` runs it on Bun with the CLI child processes on Bun too.
