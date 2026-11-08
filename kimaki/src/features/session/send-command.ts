// The `kimaki send` command as a value: its fields, the schema the RPC gate
// parses, and the one rule set every entry point applies.
//
// The type lives here, not in adapters/http/routes.ts, because the domain owns
// it: input.ts, scheduler.ts, remote-send.ts and ingress.ts all take a SendInput,
// and importing it from the HTTP adapter made the domain depend on transport.
//
// Two gates use the same rules:
//   RPC      parseInput(sendInput, body)   zod, reports the first issue
//   in-app   validateSend(input)           ConfigError, same rules, plain values
// Add a rule to checkSend and validateSend sees it.

import { z } from 'zod'

import { ConfigError } from '../../platform/errors.ts'
import { text } from '../../platform/zod-fields.ts'
import { worktreeName } from '../worktrees/worktree-name.ts'

export const sendFields = {
  channelId: text('channelId').optional(),
  threadId: text('threadId').optional(),
  sessionId: text('sessionId').optional(),
  project: text('project').optional(),
  name: text('name').optional(),
  agent: text('agent').optional(),
  model: text('model').optional(),
  // One ID or several (`--user` is repeatable); every user is added to the thread, the first is the author.
  user: z
    .union([
      text('user').transform((id) => [id]),
      z.array(text('user'), { error: 'user must be a string or a list of strings' }),
    ])
    .optional(),
  cwd: text('cwd').optional(),
  parentSessionId: text('parentSessionId').optional(),
  baseBranch: text('baseBranch').optional(),
  // '' asks for an automatic name.
  worktree: z.string({ error: 'worktree must be a name or an empty string for an automatic name' }).optional(),
  notifyOnly: z.boolean({ error: 'notifyOnly must be boolean' }).optional(),
  permissions: z.array(z.string(), { error: 'Permission rules must be strings' }).optional(),
  prompt: text('prompt'),
  files: z
    .array(z.object({ uri: z.string(), name: z.string() }), { error: 'files must contain uri and name strings' })
    .optional(),
}

// Derived from the schema: a hand-written copy would drift from the fields.
export type SendFields = z.output<z.ZodObject<typeof sendFields>>

// The first rule the input breaks, as a zod issue for the RPC gate.
export function checkSend(input: SendFields, ctx: z.RefinementCtx) {
  const error = sendRuleError(input)
  if (error) ctx.addIssue({ code: 'custom', message: error.reason })
}

export const sendInput = z.object(sendFields, { error: 'Expected a send object' }).superRefine(checkSend)

export type SendInput = z.output<typeof sendInput>

// The same rules as checkSend, for callers that hold a value instead of a body.
export function validateSend(input: SendFields): ConfigError | null {
  return sendRuleError(input)
}

// One list, so the two gates cannot drift. Split by concern: one function that
// held all five rules was a CRAP hotspot and harder to read than the rules are.
function sendRuleError(input: SendFields): ConfigError | null {
  return worktreeRuleError(input) ?? targetRuleError(input) ?? permissionRuleError(input)
}

// A worktree is a new session that owns a fresh checkout.
function worktreeRuleError(input: SendFields): ConfigError | null {
  if (input.worktree) {
    const valid = worktreeName(input.worktree)
    if (valid instanceof Error) return new ConfigError({ reason: valid.message })
  }
  if (input.worktree !== undefined && isNewSessionOnly(input)) {
    return new ConfigError({
      reason: '--worktree requires a new session; do not combine it with --cwd, --thread, --session or --notify-only',
    })
  }
  if (input.baseBranch !== undefined && input.worktree === undefined) {
    return new ConfigError({ reason: '--base-branch requires --worktree' })
  }
  return null
}

// Flags that name an existing thing, which a worktree cannot be added to.
function isNewSessionOnly(input: SendFields): boolean {
  return (
    input.cwd !== undefined ||
    input.threadId !== undefined ||
    input.sessionId !== undefined ||
    input.notifyOnly === true
  )
}

// Exactly one destination.
function targetRuleError(input: SendFields): ConfigError | null {
  const targets = [input.channelId, input.threadId, input.sessionId, input.project].filter(
    (value) => value !== undefined,
  )
  if (targets.length === 1) return null
  return new ConfigError({ reason: 'Use exactly one of --channel, --thread, --session, --project' })
}

// Permission rules apply at session.create, so an existing session cannot take them.
function permissionRuleError(input: SendFields): ConfigError | null {
  if (!input.permissions?.length) return null
  if (!input.threadId && !input.sessionId && !input.notifyOnly) return null
  return new ConfigError({
    reason:
      '--permission applies only to new sessions. Start a new session without --thread, --session, or --notify-only',
  })
}
