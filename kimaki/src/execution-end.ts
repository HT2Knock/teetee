// The ways an OpenCode run ends, in one place. Five call sites need this set:
// the reducer (root and child), the log line, the transcript trigger and
// session.wait.
//
// One list: adding a fourth outcome to ExecutionOutcome fails to compile until
// END_TYPE names its event, and executionOutcome's switch then fails its
// exhaustiveness check. The call sites follow from that.
//
// Type-only imports: the CLI loads this through session-events.ts, so it must
// not pull in the reducer or immer.

import type { V2Event } from '@opencode/client'

export type ExecutionOutcome = 'succeeded' | 'failed' | 'interrupted'

const END_TYPE = {
  succeeded: 'session.execution.succeeded',
  failed: 'session.execution.failed',
  interrupted: 'session.execution.interrupted',
} as const satisfies Record<ExecutionOutcome, `session.execution.${string}`>

export type ExecutionEnd = Extract<V2Event, { type: (typeof END_TYPE)[ExecutionOutcome] }>

export function isExecutionEnd(event: { type: string }): event is ExecutionEnd {
  return Object.values(END_TYPE).some((type) => type === event.type)
}

// No default: the union has exactly one member per outcome, so a new outcome
// leaves a code path without a return and tsc reports it.
export function executionOutcome(event: ExecutionEnd): ExecutionOutcome {
  switch (event.type) {
    case END_TYPE.succeeded:
      return 'succeeded'
    case END_TYPE.failed:
      return 'failed'
    case END_TYPE.interrupted:
      return 'interrupted'
  }
}

// The message of a failed run. A future event mapped to "failed" has no error
// field, so it still reports something instead of dropping the line.
export function executionErrorMessage(event: ExecutionEnd): string {
  return event.type === END_TYPE.failed ? event.data.error.message : 'run failed'
}
