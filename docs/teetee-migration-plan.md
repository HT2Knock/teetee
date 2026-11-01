# Teetee migration plan

Status: draft for confirmation. This plan supersedes
`docs/kimaki-v2-rebuild-spec.md` for future work. The rebuild spec stays as
history until Phase 1 deletes it.

## 1. Decisions

| Decision | Choice |
| --- | --- |
| Test runner | Keep `bun test`. No vitest. |
| Deployment | Self-hosted Discord app only. No hosted gateway. |
| Type check | `bun check`. Build emit moves to `bun build`. |
| Analytics | Remove Strada. |
| Voice | Remove voice messages and voice calls. |
| Anthropic plugin | Remove. `/login` stays. |
| Order | Cleanup, then Effect, then cutover, then rename. |
| Agent surface | MCP endpoint, not plugin tools and not a CLI manual. |
| Client/server | Core with adapters. Two tokens: `control` and `notify`. |
| Remote sessions | Out of scope now. Future session router. |
| Scheduler | Effect service over SQLite. No Temporal. |
| Strictness | Zero warnings, zero cycles, zero dead code, no duplicate budget. |

## 2. Target architecture

### 2.1 Core and adapters

```
                      ┌──────────────────────────────────┐
Discord ◀── adapter ──┤ core (Effect services)           ├── adapter ──▶ OpenCode HTTP
                      │ sessions   scheduler   views      │
CLI     ◀── RPC ──────┤ effects    registry    settings   │
                      │                                  │
MCP     ◀── HTTP ─────┤ ports: Discord, Opencode,         │
                      │        Persistence, Notifier      │
                      └──────────────────────────────────┘
                                    ▲
                       OpenCode plugin (context + MCP registration)
```

Directory layout:

```
src/core/            no discord.js, no HTTP, no process I/O
src/adapters/discord/
src/adapters/opencode/
src/adapters/http/   local RPC and MCP
src/adapters/cli/
src/plugin/          runs inside OpenCode
src/main.ts          Layer composition only
```

### 2.2 Rules

1. The core imports no `discord.js`. The Discord adapter owns every Discord
   type. Fallow enforces the boundary on `src/core/**`.
2. Modules depend on service tags, never on another module's functions. This
   removes the 27 cycles.
3. `thread-reducer.ts` stays pure: `(view, event) => [view, effects]`. It moves
   to `src/core/` unchanged in behavior.
4. `errors.ts` keeps its `Data.TaggedError` classes. Functions return
   `Effect<T, AppError>`. Replace `attempt()` and `instanceof` checks with
   `catchTag`.
5. `main.ts` composes Layers and runs the program. Nothing else composes.
6. The OpenCode plugin stays plain TypeScript. It must not import the core.

### 2.3 MCP surface and tokens

One MCP endpoint at `/mcp` on the bot's HTTP server, next to the local RPC.
The plugin registers it for every location through `ctx.mcp.transform`, using
the `control` token from the session marker.

```
bot HTTP server
├── /rpc/*   local RPC, control token
└── /mcp     MCP, control or notify token
```

Two tokens:

| Token | Who | Can |
| --- | --- | --- |
| `control` | this machine's OpenCode, CLI, tests | read and write, start sessions |
| `notify` | other machines and clients | send messages, upload files, buttons |

A `notify` token must never start a session, read transcripts, or run shell
commands. Starting a session runs code on the bot host, so it stays local.

MCP tools, first version:

| Tool | Scope | Purpose |
| --- | --- | --- |
| `send` | control, notify | post a message or start a thread |
| `upload` | control, notify | attach files to a thread |
| `buttons` | control, notify | end a turn with action buttons |
| `user_lookup` | control, notify | resolve a Discord user ID |
| `project_list` | control | list project channels |
| `session_list` | control | list sessions and status |
| `session_read` | control | read a session as markdown |
| `session_archive` | control | archive a session |
| `sleep` | control | wake this session later |
| `routine_list` | control | list scheduled routines |

Code mode exposes these as `tools.teetee.<tool>`, so the agent can batch
several calls in one `execute` block.

### 2.4 Agent instructions: prompt to tools

`system-prompt.ts` is 849 lines and most of it is a CLI manual. Phase 5
replaces that with the MCP tools above.

- Keep in the prompt: identity, channel and thread IDs, output style, commit
  trailer, permission rules, and the "you are in Discord" framing.
- Move to tool schemas: every command name, flag, quoting rule, and ordering
  rule.
- The CLI stays for humans, scripts, and CI. The agent may still call it, but
  the prompt does not document it at length.

Target: the prompt drops from about 849 to about 150 lines.

### 2.5 Scheduler

A core service with a `Persistence` port and a `Notifier` port. It keeps the
current semantics: one-time runs, cron, pre-run command, no overlap, retries,
and session sleeps. Use `cron-parser` for expressions and Effect `Schedule`,
`Clock`, and `Queue` for the loop. Test with `TestClock`.

No Temporal. A single-user local bot does not justify a server, a database, a
worker, and workflow versioning, and it would add a second source of truth next
to `kimaki.db`. Revisit only if multi-machine workers become a requirement.

### 2.6 State

`zustand` goes. The store holds four things:

| Field | Why |
| --- | --- |
| `roots` | thread ID to root session ID |
| `sessionThreads` | session ID to thread ID, for routing events |
| `threads` | previous `ThreadView` per thread, input to the reducer |
| `verbosity` | per-channel display mode |

It has 68 `getState`/`setState` calls and one subscriber (`agent-ui.ts`). A
`ThreadRegistry` service with a `Ref` and an explicit listener list does the
same job without the dependency.

### 2.7 Persistence

Adopt `@effect/sql-sqlite-bun` and rewrite all 55 queries. This removes
`import { SQL } from 'bun'` from the core, gives typed errors, and makes the
database a Layer that tests can replace. Keep the schema and its migrations
unchanged, including columns of removed features.

## 3. Toolchain and gates

| Tool | Role | Gate |
| --- | --- | --- |
| `bun check` | type check (1.3 s today) | CI |
| `bun build` | `dist/cli.js` and the plugin entries | CI |
| `oxlint` | lint | zero warnings |
| `oxfmt` | format, width 120 | `--check` in CI |
| `fallow` | cycles, dead code, duplication, complexity | hard fail |
| `bun test` | unit and e2e | CI, retry 3 |

Hard gates, all blocking:

- Import cycles: 0.
- Dead files and unused exports: 0.
- Clone groups: 0 above the configured threshold.
- No function above 25 cognitive complexity.
- Core purity: `src/core/**` may not import `discord.js`, `src/adapters/**`, or
  `node:http`.
- CLI startup: `bun src/cli.ts --help` under 120 ms.

Gate changes:

- Remove `tsc` from `build`. Emit `dist/cli.js` with `scripts/bundle.ts` and the
  plugin entries with `bun build`. Delete `dist/.tsbuildinfo`.
- Add `.oxlintrc.json`: `correctness`, `suspicious`, and `perf` categories,
  `import`, `promise`, and `node` plugins, deny `no-explicit-any` and
  `no-unused-vars`.
- Set `printWidth: 120` in `.oxfmtrc.jsonc`. One formatting-only commit.
- Fix `.github/workflows/ci.yml`: it still builds the deleted `errore`
  workspace.
- Phase 1 fixes the 39 duplicate groups before the duplicate gate turns on.
  Most are in `discord-digital-twin/src/server.ts`.

## 4. Removal inventory

### 4.1 Hosted gateway

- 156 references in 19 files, including `credentials.ts`, `onboarding.ts`,
  `cli/bot.ts` (`--gateway`, `--gateway-callback-url`), and `harness.ts`.
- Delete `gateway-replay.e2e.test.ts` (116 lines).
- Delete `docs/gateway-architecture.md` and the gateway section of `AGENTS.md`.
- Remove `KIMAKI_GATEWAY_APP_ID`, `KIMAKI_GATEWAY_PROXY_URL`, and
  `KIMAKI_WEBSITE_URL`.
- Keep the `bot_tokens` gateway columns. Write `self_hosted` only.
- Keep `remote-send.ts`: it is a Discord envelope protocol, not gateway code.

### 4.2 Strada analytics

- Delete `analytics.ts` (245 lines), `analytics.test.ts`, and
  `analytics.e2e.test.ts`.
- Remove `@strada.sh/sdk` and the four `KIMAKI_STRADA_*` variables.
- Remove `Analytics` from `bot.ts`, `main.ts`, `event-loop.ts`, `input.ts`,
  `onboarding.ts`, `project.ts`, `cli/project.ts`, `lock-routes.ts`, and
  `harness.ts`.
- Delete `docs/strada-product-analytics.md`.
- Keep token totals in the reducer. They feed the footer.

### 4.3 Anthropic OAuth plugin

- Delete `src/plugin/anthropic/` (271 lines).
- Remove its entry from `installPluginShim` and from `plugin.e2e.test.ts`.
- `/login` stays: it uses the OpenCode integration API.

### 4.4 Voice

- Delete `voice.ts` (851), `voice-call.ts` (786), `voice-agent.ts` (198), and
  `live-call.ts` (251) = 2,086 lines.
- Delete `tts.test.ts`, `voice-attachments.e2e.test.ts`,
  `voice-call.e2e.test.ts`, and `voice-openai.e2e.test.ts`.
- Remove `@discordjs/voice`, `werift`, `opusscript`, `prism-media`, and
  `eventsource-parser`.
- Remove voice wiring from `main.ts`, `ingress.ts`, `bot.ts`, `sessions.ts`,
  `prompt.ts`, `system-prompt.ts`, `cli/*`, `project.ts`, `rows.ts`,
  `routes.ts`, `schema-sql.ts`, `event-loop.ts`, and `harness.ts`.
- Delete the voice channel row and the Discord voice channel.
- `scripts/bundle.ts` loses its whole `external` list. Every entry exists only
  because of voice.
- Keep the `bot_api_keys` and `bot_settings` tables.

### 4.5 Documentation and release leftovers

- `.changeset/` and `CHANGELOG.md`: the fork does not publish.
- `docs/kimaki-v2-rebuild-spec.md` (240 KB), `docs/opencode-v2-*.md` (52 KB),
  `docs/release-process.md`, and `docs/design.md` (references a deleted
  `website/`).
- `docs/opencode-v2-events/record-events.ts` and `summarize-events.ts` are dead
  scripts. Keep the `.jsonl` fixtures; they drive reducer tests.
- Split `AGENTS.md` into root rules, `docs/` procedures, and skills.

## 5. Phases

Each phase is one branch and reviewed commits. A phase ends only when its exit
check is green.

### Phase 0: guardrails

- Fix CI. Add `check`, `lint`, `fmt`, `fallow`, and `verify` scripts.
- Install `oxlint` and `oxfmt` at the workspace root.
- Run `oxfmt` once, in a commit that changes no logic.
- Record the fallow baseline: 39 clone groups, 2 dead files, 41 targets.
- Add an annotated tag as the rollback point.

Exit: `bun run verify` passes locally and CI is green on `main`.

### Phase 1: delete dead surface

- Gateway, Strada, Anthropic plugin, voice, legacy docs, changesets.
- Fix the 39 duplicate groups, mostly in the test twin.
- Turn the duplicate gate on.
- Update `AGENTS.md` and the README.

Exit: type check, lint, fallow, and the full suite pass. Target: about 4,000
fewer lines (2,600 production, 1,400 test) and 6 fewer dependencies.

### Phase 2: core skeleton

- `effect@4.1.1`.
- `Settings`, `Database` (Effect SQL), `ThreadRegistry`, `Scheduler`, `Clock`.
- Rewrite `main.ts` as an `Effect.gen` program with `Layer.launch`.
- Keep the existing behavior inside the layers at first.

Exit: the bot starts, the e2e suite passes, no behavior change.

### Phase 3: adapters

- `adapters/discord`: all `discord.js`.
- `adapters/opencode`: discovery, client, event stream.
- `adapters/http`: local RPC (`control` token) and MCP (`control` and `notify`).
- `adapters/cli`: pure RPC client, no direct SQLite.
- Plugin registers the MCP server and keeps context injection.

Exit: MCP contract tests pass; the CLI reads no database file.

### Phase 4: control flow

- Convert `T | Error` returns to `Effect` with tagged failures.
- Replace `instanceof` with `catchTag`. Delete `attempt()`.
- Use `Queue` for effects, `Stream` for OpenCode events, `Schedule` for retries.
- Delete `bot.ts`.

Exit: zero cycles, core imports no `discord.js`, no `instanceof Error` in
production code.

### Phase 5: agent surface

- Add the MCP tools in section 2.3.
- Shrink the system prompt to about 150 lines.
- Add MCP tests that assert Discord messages, not internal state.

Exit: the agent completes the current workflows through MCP with no CLI
manual in the prompt.

### Phase 6: self-host cutover

See section 6. This is one maintenance window.

### Phase 7: rename to teetee

See section 6. Runs after the cutover is stable, in a separate window.

## 6. Cutover and rename

### 6.1 Cutover

Today the bot runs in gateway mode from
`~/workspace/github.com/HT2Knock/kimaki` on branch `bun-runtime`, with app ID
`1477605701202481173`.

Steps, in this order:

1. Create a Discord application, enable the Message Content intent, and invite
   it to guild `1559144742220988487` with the bot and applications.commands
   scopes.
2. Stop `kimaki.service` and kick the shared Kimaki bot. Two bots in one guild
   would both answer.
3. Insert the new `bot_tokens` row with `bot_mode = 'self_hosted'` and delete or
   ignore the gateway row, so credentials never resolve to the old mode.
4. Point `kimaki.service` at this repo. Drop `--gateway`. Keep the data dir,
   the database, and the lock port.
5. Start the service and run `/status`, then send one message in an existing
   thread and confirm it continues the same OpenCode session.

Preserved: 9 channel rows, 56 thread bindings, 3 routines, 1 sleep, and every
OpenCode session. The database needs no destructive migration.

### 6.2 Rename

| Surface | Old | New | Compatibility |
| --- | --- | --- | --- |
| Data dir | `~/.kimaki` | `~/.teetee` | Use the old dir when the new one is absent, rename once on start |
| Database | `kimaki.db` | `teetee.db` | Rename with fallback to both names |
| Env vars | `KIMAKI_*` | `TEETEE_*` | Read new first, fall back for one release |
| CLI bin | `kimaki` | `teetee` | Ship both; `kimaki` prints a deprecation line |
| Lock port | 29988 | 29988 | Keep, so two bots cannot run at once |
| Plugin shims | `plugins/kimaki` | `plugins/teetee` | Remove old shim dirs on start |
| Session marker | `metadata.kimaki` | `metadata.teetee` | Dual read, write both for one release |
| Service | `kimaki.service` | `teetee.service` | Operator step, documented |

Rollback: check out the previous tag. The database stays valid because the new
code only adds tables and columns.

## 7. Testing

- Unit tests stay on `bun test` with `Effect.runPromise` and `Layer.succeed`.
- `TestClock` covers the scheduler, sleeps, and retries.
- MCP contract tests call `/mcp` and assert Discord messages.
- E2E tests keep the digital twin and the per-file OpenCode server.
- Add one startup-budget test for the CLI.
- A test that starts on the old gateway database and asserts self-host
  credentials are chosen.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Two bots answer at cutover | Stop the old service before starting the new one |
| Effect rewrite breaks behavior | Vertical slices; each phase ends green |
| MCP endpoint abused | Two tokens; `notify` cannot start sessions |
| Plugin reload drops the bot | The bot stays the host process |
| Rename loses state | Dual-read markers, data dir rename with fallback, rollback tag |
| Strict gates block work | Phase 1 fixes the debt before gates turn on |

## 9. Future: session router

MCP gives one-way cross-machine messaging now. Two-way remote sessions need a
router that maps a Discord channel to an OpenCode endpoint on another machine.
OpenCode already ships parts of this (`opencode pair`, one-time links). Build
the router after this migration, on top of the adapter boundary.
