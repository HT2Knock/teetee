// The only shared mutable in-memory state of the bot (spec 27.4): one small
// observable store. The event loop writes bindings and views; /verbosity writes
// verbosity. State private to one module (held events, wizard picks, upload
// waits) stays in that module's closure.
//
// Phase 3 moves this behind an Effect `Ref` service. The shape stays the same,
// so call sites do not change again.

import type { Verbosity } from './db.ts'
import type { ThreadView } from './thread-reducer.ts'

export type BotState = {
  // threadId -> root session, from thread_sessions (SQLite) and new bindings.
  roots: Readonly<Record<string, string>>
  // sessionId (roots and their subagent children) -> threadId, for routing.
  sessionThreads: Readonly<Record<string, string>>
  // threadId -> view, created at bind or when a thread of an earlier run gets its first event.
  threads: Readonly<Record<string, ThreadView>>
  // channelId -> verbosity, from channel_verbosity (SQLite). Missing: the default.
  verbosity: Readonly<Record<string, Verbosity>>
}

export type BotStore = {
  getState: () => BotState
  // Merges the returned fields into the current state, then notifies listeners.
  setState: (update: Partial<BotState> | ((current: BotState) => Partial<BotState>)) => void
  // Returns the unsubscribe function.
  subscribe: (listener: (state: BotState, previous: BotState) => void) => () => void
}

export function createBotStore(): BotStore {
  let state: BotState = { roots: {}, sessionThreads: {}, threads: {}, verbosity: {} }
  const listeners = new Set<(state: BotState, previous: BotState) => void>()
  return {
    getState: () => state,
    setState: (update) => {
      const previous = state
      const patch = typeof update === 'function' ? update(previous) : update
      state = { ...previous, ...patch }
      for (const listener of listeners) listener(state, previous)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
