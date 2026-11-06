// The decisions `kimaki send` and a new thread make before anything happens:
// which model wins, what the thread is called, which permission rules apply and
// which worktree name the run gets.
//
// Pure on purpose. This is the highest-traffic policy in the bot and it used to
// be private to input.ts, so only a full e2e run could check it. No Bot, no
// Discord, no OpenCode: table tests in send-policy.test.ts.

import crypto from 'node:crypto'

import { ConfigError } from '../../platform/errors.ts'
import { parseModel, type ModelChoice } from '../settings/model-choice.ts'

// A model as callers pass it: ModelChoice uses null for "no variant".
export type ModelInput = { providerID: string; id: string; variant?: string | null }

// The model shape `session.create` takes: an absent variant, not null.
export type SessionModel = { providerID: string; id: string; variant?: string }

export type PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

// Explicit flags win over the channel default, which wins over the agent's own
// model and then the global default.
export function pickModel({
  explicitModel,
  agentFlagModel,
  channelModel,
  agentModel,
  global,
}: {
  explicitModel?: ModelInput
  agentFlagModel?: ModelChoice | null
  channelModel?: { model_id: string | null; variant: string | null } | null
  agentModel?: ModelChoice | null
  global: ModelChoice | null
}): ModelChoice | null {
  const channel = channelModel ? parseModel(channelModel.model_id, channelModel.variant) : null
  const picked = explicitModel ?? agentFlagModel ?? channel ?? agentModel ?? global
  return picked ? { providerID: picked.providerID, id: picked.id, variant: picked.variant ?? null } : null
}

// `session.create` takes the provider, id and optional variant only.
export function sessionModel(choice: ModelInput | null | undefined): SessionModel | undefined {
  if (!choice) return undefined
  return { providerID: choice.providerID, id: choice.id, ...(choice.variant ? { variant: choice.variant } : {}) }
}

// A worktree thread is named after its branch, everything else after the text.
export function sessionThreadName({
  explicitName,
  useWorktree,
  slug,
  text,
}: {
  explicitName?: string
  useWorktree: boolean
  slug: string
  text: string
}): string {
  if (explicitName) return explicitName
  if (useWorktree) return `⬦ ${slug}`
  // Trim first: a whitespace-only text would otherwise name the thread " ".
  return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Kimaki session'
}

// `--cwd` reuses that checkout; a scheduled run gets a fresh worktree name per run.
export function worktreeOf(input: { cwd?: string; worktree?: string }, task: unknown): string | false | undefined {
  if (input.cwd) return false
  if (task && input.worktree) return `${input.worktree.slice(0, 40)}-${crypto.randomBytes(4).toString('hex')}`
  return input.worktree
}

// `--permission tool[:pattern]:allow|deny|ask`.
export function parsePermissions(rules: readonly string[] | undefined): ConfigError | PermissionRule[] {
  const permissions: PermissionRule[] = []
  for (const rule of rules ?? []) {
    const parts = rule.split(':')
    const action = parts.shift()
    const effect = parts.pop()
    if (!action || (effect !== 'allow' && effect !== 'deny' && effect !== 'ask')) {
      return new ConfigError({ reason: 'Use --permission tool[:pattern]:allow|deny|ask' })
    }
    permissions.push({ action, resource: parts.join(':') || '*', effect })
  }
  return permissions
}
