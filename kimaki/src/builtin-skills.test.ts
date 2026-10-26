import { expect, test } from 'bun:test'

import { BUILTIN_SKILL_IDS, disabledSkillRules, parseDisabledSkills, readBuiltinSkills } from './builtin-skills.ts'

test('every built-in skill file parses', async () => {
  const skills = await readBuiltinSkills()
  if (skills instanceof Error) throw skills
  expect(skills.map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS])
  for (const skill of skills) {
    expect(skill.description, skill.id).toContain('Only for Kimaki Discord sessions')
    expect(skill.content.startsWith('# '), skill.id).toBe(true)
  }
})

test('--disable-skills accepts all, a list, and rejects unknown ids', () => {
  expect(parseDisabledSkills(undefined)).toEqual([])
  expect(parseDisabledSkills('kimaki-thread-ops, kimaki-debug')).toEqual(['kimaki-thread-ops', 'kimaki-debug'])
  expect(parseDisabledSkills('all')).toEqual([...BUILTIN_SKILL_IDS])
  expect(parseDisabledSkills('thread-ops')).toBeInstanceOf(Error)
  expect(disabledSkillRules(['kimaki-thread-ops'])).toMatchInlineSnapshot(`
    [
      {
        "action": "skill",
        "effect": "deny",
        "resource": "kimaki-thread-ops",
      },
    ]
  `)
})
