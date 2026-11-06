// The only shared mutable in-memory state of the bot (plan section 2.6): one
// small store held in an Effect `Ref`. The event loop writes bindings and
// views; /verbosity writes verbosity. State private to one module (held events,
// wizard picks, upload waits) stays in that module's closure.
//
// The public shape stays `getState`/`setState`/`subscribe`, so the 40 call
// sites read state synchronously. Phase 4 can move them to `Ref` effects one
// slice at a time without a second rewrite.

import { Context, Layer, Ref } from 'effect'

import type { Verbosity } from '../../db/db.ts'
import type { ThreadView } from '../transcript/thread-reducer.ts'

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

// The store as a service: main.ts provides one per bot, tests provide their own
// with `Layer.succeed(ThreadRegistry, createBotStore())`.
export class ThreadRegistry extends Context.Service<ThreadRegistry, BotStore>()('kimaki/ThreadRegistry') {
  static readonly layer: Layer.Layer<ThreadRegistry> = Layer.sync(ThreadRegistry, () => createBotStore())
}

function initialState(): BotState {
  return { roots: {}, sessionThreads: {}, threads: {}, verbosity: {} }
}

export function createBotStore(): BotStore {
  // A Ref is Effect's mutable cell; `getUnsafe` and a direct `.ref.current`
  // write keep the synchronous shape the call sites need. Every write goes
  // through `setState`, so listeners still see each transition.
  const ref = Ref.makeUnsafe<BotState>(initialState())
  const listeners = new Set<(state: BotState, previous: BotState) => void>()
  return {
    getState: () => Ref.getUnsafe(ref),
    setState: (update) => {
      const previous = Ref.getUnsafe(ref)
      const patch = typeof update === 'function' ? update(previous) : update
      const next = { ...previous, ...patch }
      ref.ref.current = next
      for (const listener of listeners) listener(next, previous)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
