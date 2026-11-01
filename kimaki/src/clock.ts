// The bot's only source of "now" (scheduler.ts, sleeps.ts). `Clock.now()` is an
// input, so tests drive scheduling with a manual clock and no timers.
//
// The tag lets main.ts compose the clock in the app Layer and lets a unit test
// replace it with `Layer.succeed(Clock, manualClock(t))`.

import { Context, Layer } from 'effect'

export type ClockShape = { now(): number }

export const systemClock: ClockShape = { now: () => Date.now() }

export class Clock extends Context.Service<Clock, ClockShape>()('kimaki/Clock') {
  static readonly layer: Layer.Layer<Clock> = Layer.succeed(Clock, systemClock)
}
