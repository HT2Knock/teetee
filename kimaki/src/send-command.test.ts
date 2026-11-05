// The `kimaki send` rules, tested as a table. The RPC schema and the in-app
// check must agree: a rule that lands in only one of them is the bug this test
// exists to catch.

import { expect, test } from 'bun:test'

import { sendInput, validateSend } from './send-command.ts'

type Case = { name: string; input: Parameters<typeof validateSend>[0]; valid: boolean }

const cases: Case[] = [
  { name: 'channel target', input: { prompt: 'x', channelId: '1' }, valid: true },
  { name: 'thread target', input: { prompt: 'x', threadId: '2' }, valid: true },
  { name: 'session target', input: { prompt: 'x', sessionId: 'ses_1' }, valid: true },
  { name: 'project target', input: { prompt: 'x', project: '/repo' }, valid: true },
  { name: 'worktree name and channel', input: { prompt: 'x', channelId: '1', worktree: 'fix-auth' }, valid: true },
  {
    name: 'worktree with base branch',
    input: { prompt: 'x', channelId: '1', worktree: 'fix-auth', baseBranch: 'main' },
    valid: true,
  },
  { name: 'no target', input: { prompt: 'x' }, valid: false },
  { name: 'two targets', input: { prompt: 'x', channelId: '1', threadId: '2' }, valid: false },
  { name: 'bad worktree name', input: { prompt: 'x', channelId: '1', worktree: 'Fix Auth' }, valid: false },
  { name: 'worktree on a thread', input: { prompt: 'x', threadId: '2', worktree: 'fix-auth' }, valid: false },
  {
    name: 'worktree with cwd',
    input: { prompt: 'x', channelId: '1', worktree: 'fix-auth', cwd: '/repo' },
    valid: false,
  },
  { name: 'base branch without worktree', input: { prompt: 'x', channelId: '1', baseBranch: 'main' }, valid: false },
  {
    name: 'permissions on a thread',
    input: { prompt: 'x', threadId: '2', permissions: ['shell:*:deny'] },
    valid: false,
  },
  {
    name: 'permissions on a new session',
    input: { prompt: 'x', channelId: '1', permissions: ['shell:*:deny'] },
    valid: true,
  },
]

test('validateSend and the RPC schema agree on every rule', () => {
  const disagreement = cases
    .map((testCase) => {
      const schema = sendInput.safeParse(testCase.input).success
      const value = validateSend(testCase.input) === null
      return schema === value && value === testCase.valid ? null : { ...testCase, schema, value }
    })
    .filter((result) => result !== null)
  expect(disagreement).toEqual([])
})

test('the first broken rule wins, so the message names the fix', () => {
  expect(validateSend({ prompt: 'x', threadId: '2', worktree: 'fix-auth', baseBranch: 'main' })?.reason).toContain(
    '--worktree requires a new session',
  )
  expect(validateSend({ prompt: 'x', channelId: '1', worktree: 'Fix Auth' })?.reason).toContain(
    'at most 64 lowercase letters',
  )
  expect(validateSend({ prompt: 'x' })?.reason).toContain('Use exactly one of --channel')
})
