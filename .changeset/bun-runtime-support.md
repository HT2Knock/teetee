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

Inside `kimaki/`, `bun run test` runs the suite with `bun test` (tests import from `bun:test`), with the CLI child processes on Bun too. `bunfig.toml` preloads the test env and excludes `dist/`; `scripts/run-tests.ts` sets the test timeout and the worker cap. `vitest` is no longer a kimaki dependency. The `tsx` dev dependency is gone.

SQLite access moved from `@libsql/client` to the SQL client Bun ships. Tables live in `src/schema-sql.ts` (hand-maintained DDL) and the row types in `src/rows.ts`; queries are tagged templates, for example `await db\`SELECT * FROM thread_sessions WHERE thread_id = ${threadId}\``. There is no query builder and no `drizzle-orm`/`drizzle-kit` dependency. On a file-backed database, single-row reads are about 6.7x faster and single-row autocommit writes about 3.5x faster than the libsql client. The V1 import still reads the old file through `ATTACH DATABASE 'file:...?mode=ro'`, so its WAL is never checkpointed.

The repository now installs with `bun install`: workspace globs live in the root `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` are gone, and the lockfile is `bun.lock`. The root `prepare` and every package script call bun.
