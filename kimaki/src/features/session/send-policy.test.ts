// The pure decisions behind a new thread and `kimaki send`. These used to be
// private to input.ts, where only an e2e run with a real OpenCode server could
// check them.

import { describe, expect, test } from 'bun:test'

import type { ModelChoice } from '../settings/model-choice.ts'

import { parsePermissions, pickModel, sessionModel, sessionThreadName, worktreeOf } from './send-policy.ts'

const model = (providerID: string, id: string, variant: string | null = null): ModelChoice => ({
  providerID,
  id,
  variant,
})

describe('pickModel', () => {
  const channel = { model_id: 'anthropic/claude-sonnet-4', variant: null }

  test('the explicit flag wins over everything', () => {
    expect(
      pickModel({
        explicitModel: { providerID: 'openai', id: 'gpt-6' },
        agentFlagModel: model('a', 'agent-flag'),
        channelModel: channel,
        agentModel: model('a', 'agent'),
        global: model('a', 'global'),
      }),
    ).toEqual({ providerID: 'openai', id: 'gpt-6', variant: null })
  })

  test('the agent flag wins over the channel default', () => {
    expect(
      pickModel({
        agentFlagModel: model('a', 'agent-flag'),
        channelModel: channel,
        agentModel: model('a', 'agent'),
        global: model('a', 'global'),
      }),
    ).toEqual({ providerID: 'a', id: 'agent-flag', variant: null })
  })

  test('a channel without a model falls back to the agent, then the global default', () => {
    expect(
      pickModel({
        channelModel: { model_id: null, variant: null },
        agentModel: model('a', 'agent'),
        global: model('g', 'x'),
      }),
    ).toEqual({ providerID: 'a', id: 'agent', variant: null })
    expect(pickModel({ channelModel: null, agentModel: null, global: model('g', 'x', 'high') })).toEqual({
      providerID: 'g',
      id: 'x',
      variant: 'high',
    })
  })

  test('nothing configured picks nothing', () => {
    expect(pickModel({ channelModel: null, agentModel: null, global: null })).toBe(null)
  })
})

describe('sessionModel', () => {
  test('drops a null variant, which session.create does not accept', () => {
    expect(sessionModel({ providerID: 'a', id: 'b', variant: null })).toEqual({ providerID: 'a', id: 'b' })
  })

  test('keeps a variant and maps nothing to undefined', () => {
    expect(sessionModel({ providerID: 'a', id: 'b', variant: 'high' })).toEqual({
      providerID: 'a',
      id: 'b',
      variant: 'high',
    })
    expect(sessionModel(null)).toBe(undefined)
  })
})

describe('sessionThreadName', () => {
  test('an explicit name wins', () => {
    expect(sessionThreadName({ explicitName: 'Deploy', useWorktree: true, slug: 'fix-auth', text: 'x' })).toBe('Deploy')
  })

  test('a worktree thread is named after its branch', () => {
    expect(sessionThreadName({ useWorktree: true, slug: 'fix-auth', text: 'fix the auth bug' })).toBe('⬦ fix-auth')
  })

  test('text is flattened and cut to 80 characters', () => {
    const long = 'a'.repeat(100)
    expect(sessionThreadName({ useWorktree: false, slug: 's', text: `  fix\n the   auth ` })).toBe('fix the auth')
    expect(sessionThreadName({ useWorktree: false, slug: 's', text: long })).toHaveLength(80)
  })

  test('empty text still names the thread', () => {
    expect(sessionThreadName({ useWorktree: false, slug: 's', text: '   ' })).toBe('Kimaki session')
  })
})

describe('worktreeOf', () => {
  test('--cwd reuses that checkout', () => {
    expect(worktreeOf({ cwd: '/repo', worktree: 'fix-auth' }, undefined)).toBe(false)
  })

  test('a scheduled run gets a fresh name per run', () => {
    const first = worktreeOf({ worktree: 'routine' }, { id: 1 })
    const second = worktreeOf({ worktree: 'routine' }, { id: 1 })
    expect(typeof first).toBe('string')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^routine-[0-9a-f]{8}$/)
  })

  test('a plain send keeps the name as given', () => {
    expect(worktreeOf({ worktree: 'fix-auth' }, undefined)).toBe('fix-auth')
    expect(worktreeOf({}, undefined)).toBe(undefined)
  })
})

describe('parsePermissions', () => {
  test('splits action, pattern and effect', () => {
    expect(parsePermissions(['shell:git *:allow', 'read:*:deny'])).toEqual([
      { action: 'shell', resource: 'git *', effect: 'allow' },
      { action: 'read', resource: '*', effect: 'deny' },
    ])
  })

  test('a pattern may contain colons', () => {
    expect(parsePermissions(['edit:src/a:b.ts:ask'])).toEqual([
      { action: 'edit', resource: 'src/a:b.ts', effect: 'ask' },
    ])
  })

  test('no rules means no permissions', () => {
    expect(parsePermissions(undefined)).toEqual([])
  })

  test('a missing effect or action is a config error', () => {
    const reasonOf = (rules: string[]) => {
      const parsed = parsePermissions(rules)
      return parsed instanceof Error ? parsed.message : ''
    }
    expect(reasonOf(['shell:git'])).toContain('Use --permission')
    expect(reasonOf(['shell'])).toContain('Use --permission')
    expect(reasonOf(['shell:*:maybe'])).toContain('Use --permission')
  })
})
