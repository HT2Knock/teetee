# teetee

The Kimaki bot workspace. It holds the Discord bot and the `kimaki` CLI, built
on OpenCode V2, plus the two packages its tests need.

This is a split of the upstream Kimaki monorepo. The website, the Slack bridge,
and the Rust gateway are not here. This branch targets OpenCode V2 only.

## Requirements

- [bun](https://bun.sh). The repo runs on bun, not Node.
- OpenCode V2 on the machine that hosts the bot.

## Build and test

```bash
bun install
bun run build     # tsc, then scripts/bundle.ts writes dist/cli.js
bun run test      # the kimaki suite, with bun test
bun run verify    # every gate the repo defines: types, lint, format, dead code, build
```

Run `bun run build` after every change. The OpenCode plugin starts the bot from
`kimaki/dist/cli.js`, so a stale `dist` runs old code.

## Layout

| Path | What it is |
|---|---|
| `kimaki/` | The bot and the `kimaki` CLI. |
| `discord-digital-twin/` | A local Discord API twin, so tests run without a real server. |
| `opencode-deterministic-provider/` | A provider that returns canned model replies for tests. |
| `docs/` | Notes on debugging, end-to-end testing, event sourcing, and the migration plan. |

## Deploy

On a machine that already runs the bot:

```bash
git pull && bun install && bun run build
```

Then restart the user service that runs the bot.

## Working rules

`AGENTS.md` at the root holds the rules for agents working in this repo. The
subdirectories `discord-digital-twin/` and `opencode-deterministic-provider/`
each add their own. Read the nearest file first.
