import { describe, expect, it } from 'vitest'
import {
  findSkillQuery,
  rankSkillMatches,
  skillPickerRequest,
  skillReference,
} from '../../extensions/skill-picker/skill-picker-client.tsx'
import type { SkillPickerSkill } from '../../extensions/skill-picker/skill-picker-types.ts'

function skill(
  name: string,
  description = '',
  path = `/skills/${name}/SKILL.md`,
): SkillPickerSkill {
  return { name, description, path, disableModelInvocation: false }
}

function queryAt(text: string, caret = text.length) {
  return findSkillQuery(text, { start: caret, end: caret })
}

describe('dollar skill trigger', () => {
  it('opens at whitespace/start and uses only the active query before the caret', () => {
    expect(queryAt('$')).toEqual({ start: 0, end: 1, query: '' })
    expect(queryAt('Use $cr later', 7)).toEqual({ start: 4, end: 7, query: 'cr' })
    expect(queryAt('First\n$code-review')).toEqual({ start: 6, end: 18, query: 'code-review' })
    expect(queryAt('`closed` $cr')?.query).toBe('cr')
  })

  it.each([
    '$100',
    '$HOME',
    '${HOME}',
    '$()',
    '\\$cr',
    'cost$cr',
    'a@$cr',
    'email@host $HOME',
    '`$cr',
    '``code $cr',
    '```ts\n $cr',
    '$foo_bar',
  ])('does not claim literal syntax: %s', (text) => {
    expect(queryAt(text)).toBeNull()
  })

  it('does not consume a selection or a partially traversed shell variable', () => {
    expect(findSkillQuery('$cr', { start: 1, end: 3 })).toBeNull()
    expect(queryAt('$HOME', 1)).toBeNull()
    expect(queryAt('${HOME}', 1)).toBeNull()
    expect(queryAt('$()', 1)).toBeNull()
    expect(queryAt('$cr', 2)).toBeNull()
    expect(queryAt('$cr', -1)).toBeNull()
    expect(queryAt('$cr', 4)).toBeNull()
    expect(queryAt('$cr', 1.5)).toBeNull()
  })
})

describe('skill matching and insertion', () => {
  it('finds fuzzy subsequences in either field, with all name matches before descriptions', () => {
    const skills = [
      skill('other', 'code review'),
      skill('code-review'),
      skill('cr'),
      skill('unrelated', 'nothing'),
    ]
    expect(rankSkillMatches(skills, 'cr').map((item) => item.name)).toEqual([
      'cr',
      'code-review',
      'other',
    ])
    expect(rankSkillMatches(skills, 'cR').map((item) => item.name)).toEqual([
      'cr',
      'code-review',
      'other',
    ])
  })

  it('sorts empty queries and ties deterministically without mutating inventory order', () => {
    const skills = [skill('z'), skill('a', '', '/z'), skill('a', '', '/a')]
    expect(rankSkillMatches(skills, '').map((item) => item.path)).toEqual([
      '/a',
      '/z',
      '/skills/z/SKILL.md',
    ])
    expect(skills.map((item) => item.name)).toEqual(['z', 'a', 'a'])
  })

  it('keeps manual-only skills selectable and produces explicit readable Markdown with exact path', () => {
    const manual = {
      ...skill('code-review', 'Review code', '/my skills/code-review (local)/SKILL.md'),
      disableModelInvocation: true,
    }
    expect(rankSkillMatches([manual], 'rvw')).toEqual([manual])
    expect(skillReference(manual)).toBe(
      '[$code-review](</my skills/code-review (local)/SKILL.md>) ',
    )
  })

  it('escapes Markdown label and destination delimiters without hiding the path', () => {
    expect(skillReference(skill('a[b]', '', '/skills/a<1>%/SKILL.md'))).toBe(
      '[$a\\[b\\]](</skills/a%3C1%3E%25/SKILL.md>) ',
    )
  })
})

describe('composer inventory context', () => {
  it('uses existing conversation context but never the ambient conversation for a new root/branch', () => {
    expect(skillPickerRequest('conversation', 17)).toEqual({ args: null, conversationId: 17 })
    expect(skillPickerRequest('new', 17)).toEqual({ args: null, conversationId: null })
    expect(skillPickerRequest('new', 17, 29)).toEqual({
      args: { source: 29 },
      conversationId: null,
    })
  })
})
