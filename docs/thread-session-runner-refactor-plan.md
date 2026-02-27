---
title: Thread Runtime Migration Plan
description: >-
  Concrete migration plan to a TUI-style per-thread runtime with one event
  pipeline per thread and normalized state transitions.
prompt: |
  Voice message transcription from Discord user:

  so there is only one even handler per session instead of per message?

  so what would be concrete plan to migrate? update the .md file from scratch

  Goal:
  - Migrate Kimaki Discord session handling to imitate OpenCode TUI client
    architecture (shared event stream + derived state), while keeping Discord
    behavior intact.

  References reviewed:
  - @discord/src/session-handler.ts
  - @discord/src/session-handler/state.ts
  - @discord/src/session-handler/thread-session-runtime.ts
  - @discord/src/discord-bot.ts
  - @discord/src/thread-message-queue.e2e.test.ts
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
---

## Summary

Direct code copy from OpenCode TUI is not practical, but architecture copy is.
Target shape:

- one runtime object per Discord thread,
- one event pipeline per runtime,
- fire-and-forget prompt dispatch at call site,
- completion derived from event/state timeline,
- no per-message event handler ownership.

## What Is Already Done

- Extracted run transition logic into
  `@discord/src/session-handler/state.ts`.
- Added first runtime abstraction in
  `@discord/src/session-handler/thread-session-runtime.ts`.
- Moved queue + active-handler ownership to runtime accessors in
  `@discord/src/session-handler.ts`.

## End State

```text
Discord message
  -> ThreadSessionRuntime.notifyIncomingMessage(input)
    -> enqueue input
    -> if idle: dispatch next
    -> if busy: optionally interrupt (policy)

ThreadSessionRuntime
  -> one event subscription for thread session lifecycle
  -> one normalized Zustand store
  -> derived completion + queue drain + Discord effects
```

## Concrete Migration Phases

### Phase 1: Single Ingress API (No Behavior Change)

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`
- `@discord/src/session-handler.ts`
- `@discord/src/discord-bot.ts`
- `@discord/src/commands/queue.ts`

Tasks:

1. Add `notifyIncomingMessage(...)` on runtime.
2. Route all call sites through runtime ingress:
   - thread messages from `discord-bot.ts`
   - `/queue` and `/queue-command`
   - action-button enqueue paths.
3. Remove `threadMessageQueue` from `discord-bot.ts`.

Acceptance:

- Existing e2e ordering tests still pass unchanged.

### Phase 2: Normalize Thread State Atom

Files:

- `@discord/src/session-handler/state.ts`
- `@discord/src/session-handler/thread-session-runtime.ts`

Tasks:

1. Add thread-level Zustand state (single atom), with sections:
   - `session`: `sessionId`, `projectDirectory`, `sdkDirectory`
   - `run`: current run phase (reuse existing run transition module)
   - `queue`: pending items
   - `typing`: active/stopped/restart-pending
   - `interaction`: permission/question/action-buttons pending markers.
2. Keep transitions pure and named.
3. Keep effects (Discord sends, API calls) outside transitions.

Acceptance:

- No module-level mutable maps for thread queue/handler ownership.

### Phase 3: One Event Pipeline Per Runtime

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`
- `@discord/src/session-handler.ts`

Tasks:

1. Start one long-lived event subscription in runtime.
2. Remove per-message `event.subscribe` lifecycle from
   `handleOpencodeSession`.
3. Dispatch prompt/command without binding completion to prompt response.
4. Derive completion from event/state timeline:
   - `message.updated`
   - `message.part.updated`
   - `session.status` / `session.idle`
   - `session.error`.

Acceptance:

- No per-message event handler wait chain.
- Interrupt race test still passes.

### Phase 4: Move Abort Ownership Into Runtime

Files:

- `@discord/src/session-handler.ts`
- `@discord/src/commands/abort.ts`
- `@discord/src/commands/restart-opencode-server.ts`
- `@discord/src/commands/queue.ts`
- `@discord/src/commands/action-buttons.ts`
- `@discord/src/commands/merge-worktree.ts`

Tasks:

1. Replace direct `abortControllers` reads with runtime API:
   - `runtime.abortActiveRun(reason)`
   - `runtime.isBusy()`.
2. Keep compatibility shim briefly, then remove global map.

Acceptance:

- Abort behavior unchanged for all commands.

### Phase 5: Shrink `handleOpencodeSession` to Adapter

Files:

- `@discord/src/session-handler.ts`

Tasks:

1. Keep exported function signature for callers.
2. Internally delegate to runtime ingress and return minimal metadata.
3. Remove recursive queue-drain + mixed ownership leftovers.

Acceptance:

- `session-handler.ts` becomes orchestration adapter, not state owner.

## Test Plan Per Phase

Primary suite:

- `pnpm vitest --run src/thread-message-queue.e2e.test.ts`
- `pnpm tsc`

Add focused tests during migration:

- `discord/src/session-handler/state.test.ts`
- `discord/src/session-handler/thread-session-runtime.test.ts`

Key scenarios:

1. Rapid message burst ordering.
2. Interrupt during long tool call.
3. Deferred idle before prompt resolve.
4. Typing cleanup on finish/abort/error.
5. Pending permission/question with queued follow-up message.

## Risks And Guards

- Runtime leak by thread
  - guard: cleanup when no queue + no active handler + no active typing timer.
- Duplicate footer or double completion
  - guard: terminal phase checks in transition layer.
- Regressions from mixed old/new paths
  - guard: phase-by-phase cutover, no dual ownership after each phase.

## Practical Next Commit

Implement only Phase 1 in one commit:

1. Add runtime ingress method.
2. Route `discord-bot.ts` thread path through runtime.
3. Remove `threadMessageQueue` from `discord-bot.ts`.
4. Keep existing event + transition logic otherwise untouched.

This gives immediate simplification with low risk and prepares full TUI-style
runtime migration.
