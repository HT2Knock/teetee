# discord-digital-twin

fake Discord for the kimaki e2e tests. these rules win over the root `AGENTS.md` for files in this package.

- import from `discord-digital-twin/src`, never from `dist`: the package does not need a build before a kimaki test runs.
- add reusable methods to `DigitalDiscord` in `src/index.ts`. kimaki tests call them, so a helper used by one test belongs in the twin instead.
- actor methods act (`sendMessage`, `runSlashCommand`, `clickButton`), wait methods assert (`waitForThread`, `waitForBotReply`, `waitForInteractionAck`). keep that split when you add one.
- cover every new interaction primitive in `tests/*` with its own test.
- `src/schema.sql` and `src/generated` come from prisma: edit `schema.prisma`, then run `bun run generate`. never hand-edit generated files.
- run `bunx vitest run` in this package after a change.
