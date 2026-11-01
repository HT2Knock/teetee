// The Phase 2 services: the thread registry over a Ref, the clock and the bot
// settings. Every one of them is read through the Layer, so a test replaces
// them with `Layer.succeed` and nothing else changes.

import { expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'

import { Clock, systemClock } from './clock.ts'
import { Settings, type BotSettings } from './settings.ts'
import { ThreadRegistry, createBotStore } from './store.ts'

const SETTINGS: BotSettings = {
  dataDir: '/tmp/kimaki-test',
  lockPort: 29988,
  restUrl: null,
  appId: '1422625037164350001',
  supervised: false,
  autoWorktrees: false,
  allowAllUsers: false,
  disabledSkills: [],
  kimakiCommand: 'kimaki',
  opencodeConfigDir: '/tmp/kimaki-test/opencode',
}

test('the thread registry keeps the store shape behind a Ref', async () => {
  const seen: string[] = []
  const store = createBotStore()
  expect(store.getState()).toEqual({ roots: {}, sessionThreads: {}, threads: {}, verbosity: {} })

  const off = store.subscribe((state, previous) => {
    seen.push(`${Object.keys(previous.roots).length}->${Object.keys(state.roots).length}`)
  })
  store.setState({ roots: { thread1: 'ses_1' } })
  store.setState((current) => ({ sessionThreads: { ...current.sessionThreads, ses_1: 'thread1' } }))
  off()
  store.setState({ roots: {} })

  expect({ seen, state: store.getState() }).toMatchInlineSnapshot(`
    {
      "seen": [
        "0->1",
        "1->1",
      ],
      "state": {
        "roots": {},
        "sessionThreads": {
          "ses_1": "thread1",
        },
        "threads": {},
        "verbosity": {},
      },
    }
  `)
})

test('the registry layer provides one store per program', async () => {
  const read = Effect.gen(function* () {
    const store = yield* ThreadRegistry
    store.setState({ verbosity: { channel1: 'text' } })
    return store.getState().verbosity
  })
  expect(await Effect.runPromise(Effect.provide(read, ThreadRegistry.layer))).toEqual({ channel1: 'text' })
  // A second program gets its own store.
  expect(await Effect.runPromise(Effect.provide(read, ThreadRegistry.layer))).toEqual({ channel1: 'text' })
})

test('a test layer replaces the clock and the settings', async () => {
  const manual = { now: () => 1_760_000_000_000 }
  const program = Effect.gen(function* () {
    const clock = yield* Clock
    const settings = yield* Settings
    return { now: clock.now(), port: settings.lockPort, system: clock === systemClock }
  })
  const layer = Layer.mergeAll(Layer.succeed(Clock, manual), Settings.layer(SETTINGS))
  expect(await Effect.runPromise(Effect.provide(program, layer))).toEqual({
    now: 1_760_000_000_000,
    port: 29988,
    system: false,
  })
  // The default clock layer is the system clock.
  const defaults = Effect.gen(function* () {
    const clock = yield* Clock
    return clock === systemClock
  })
  expect(await Effect.runPromise(Effect.provide(defaults, Clock.layer))).toBe(true)
})
