---
'kimaki': major
---

Run the bot and the CLI on Bun only.

Bun runs the TypeScript sources directly, so the CLI and the test suite need no Node loader and no runtime switch. `dist/cli.js` starts with `#!/usr/bin/env bun`, so the `kimaki` command needs Bun on PATH. This is a personal fork: Node is no longer supported.

`kimaki status` reports the runtime, which is always `bun`:

```
running: pid 1234, up 42s, mode "self_hosted"
runtime: bun
```

Inside `kimaki/`, `bun run test` runs the suite with the CLI child processes on Bun too. The `tsx` dev dependency is gone, and `bun run generate` regenerates the schema SQL through `bun x drizzle-kit`.
