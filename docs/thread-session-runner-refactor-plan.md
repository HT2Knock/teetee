---
title: Thread Session Runner Refactor Plan
description: >-
  Plan to refactor Discord session handling into a per-thread runtime class
  with centralized state transitions and event-derived completion.
prompt: |
  Voice message transcription from Discord user:

  Create a plan markdown file for this refactoring. Also explain why we cannot
  do a direct copy. For example, we could create a class per thread, then send
  with a method on this class a notification when there is a new message in a
  Discord message request.

  Additional context used while planning:
  - Keep interrupt behavior correct when tool calls are running.
  - Keep session reuse semantics in Discord threads.
  - Evaluate parity with OpenCode TUI handler/event model.

  References used while planning:
  - @discord/src/session-handler.ts
  - @discord/src/session-handler/state.ts
  - @discord/src/thread-message-queue.e2e.test.ts
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
  - @opensrc/repos/github.com/sst/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
---

## Goal

Refactor the Discord session orchestration into a per-thread runtime class that:

- centralizes mutable state in one place,
- keeps interrupt + queue behavior stable,
- reduces ad-hoc lifecycle flags in `session-handler.ts`,
- keeps current behavior for typing, footer, permission/question UI, and queue.

## Why A Direct Copy From OpenCode TUI Is Not Safe

OpenCode TUI and Kimaki solve related but different problems.

1. **Lifecycle shape is different**
   - TUI keeps a long-lived global sync store fed by event streams.
   - Kimaki executes request-scoped handler calls per Discord message.
2. **Interrupt semantics are different**
   - TUI prompts are fire-and-forget from input submit.
   - Kimaki does immediate abort + queued message handoff in the same thread.
3. **Output contract is different**
   - TUI renders state from message timelines.
   - Kimaki must emit Discord typing indicators, markdown chunks, and footer
     timing in strict order.
4. **Bridging/UI obligations are different**
   - Kimaki must coordinate Discord components (permissions/questions/buttons)
     in-flight while aborting and resuming runs.

So direct code copy would drop required Discord-specific sequencing and re-create
the stale idle race in a new shape.

## Recommended Direction: Per-Thread Runtime Class

Implement a dedicated runtime object per thread and route all new incoming
messages through it.

```text
Discord message
  -> ThreadSessionRuntime.notifyIncomingMessage(...)
    -> enqueue + maybe interrupt active run
      -> run loop (single writer)
        -> session.prompt/session.command
        -> event correlation + state transitions
        -> flush output + footer + dequeue next
```

### Proposed Class Responsibilities

- Own queue for one thread (`pendingMessages`).
- Own current run token/session info (`activeRun`).
- Own main run state store (status enum transitions).
- Own typing lifecycle timers.
- Own event subscription for this thread runtime.
- Expose small API:
  - `notifyIncomingMessage(input)`
  - `shutdown()`
  - `getSnapshot()` (debug/status)

## State Model (Normalized)

Keep the store from `@discord/src/session-handler/state.ts` as a focused run
state machine, then compose that inside the class.

- Run phase: `waiting-dispatch | collecting-baseline | dispatching |
  prompt-resolved | finished | aborted`
- Idle phase: `none | deferred`
- Correlation fields:
  - `baselineAssistantIds`
  - `currentAssistantMessageId`
  - `eventSeq`, `evidenceSeq`, `deferredIdleSeq`

Important: this state tracks **runs within one session ID**, not historical
sessions.

## Refactor Steps

### 1) Introduce `ThreadSessionRuntime`

Files:

- Add `@discord/src/session-handler/thread-session-runtime.ts`
- Keep a thin entry in `@discord/src/session-handler.ts` that delegates to the
  runtime instance for `thread.id`.

Tasks:

- Move queue + interrupt logic into class methods.
- Move prompt dispatch and event loop into class.
- Move typing interval/restart timeout ownership into class.

### 2) Keep transition logic centralized

Files:

- `@discord/src/session-handler/state.ts`
- `@discord/src/session-handler/thread-session-runtime.ts`

Tasks:

- Keep all state updates via named transition helpers.
- Avoid direct field mutation from runtime methods.

### 3) Keep Discord side effects at the edge

Files:

- `@discord/src/session-handler/thread-session-runtime.ts`

Tasks:

- Restrict Discord sends/reactions/typing to small effect functions.
- Keep state transitions pure and easy to test.

### 4) Wire runtime registry

Files:

- `@discord/src/session-handler.ts`

Tasks:

- Create a `Map<threadId, ThreadSessionRuntime>` registry.
- Reuse runtime for a thread until idle + queue empty + no pending prompts.
- Cleanup registry entry on runtime shutdown.

## Test Plan

Use existing e2e file and add focused cases only when behavior changes.

Files:

- `@discord/src/thread-message-queue.e2e.test.ts`

Checks:

1. Interrupt during tool call still processes next message.
2. Deferred idle before prompt resolve does not end fresh run early.
3. Typing indicator stops on finish, abort, and error.
4. Queue drains in order under rapid message bursts.

Run:

- `pnpm vitest --run src/thread-message-queue.e2e.test.ts`
- `pnpm tsc`

## Risks And Mitigations

- **Risk:** Runtime object leaks by thread.
  - **Mitigation:** explicit `shutdown()` and registry cleanup conditions.
- **Risk:** Double-send footer on duplicate idle.
  - **Mitigation:** phase guard (`finished`) before finish side effects.
- **Risk:** Regressions in permission/question pauses.
  - **Mitigation:** keep these flows unchanged, only move ownership boundary.

## Acceptance Criteria

- No stale-idle premature completion after interrupt.
- Queue and interrupt behavior unchanged from user perspective.
- Fewer mutable locals in `session-handler.ts`.
- Runtime state readable from one normalized source of truth.
