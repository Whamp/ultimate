import { expect, it } from 'vitest'
import { planSourceAttributes } from '../../extensions/plan/sources.tsx'

it('preserves the plan owner, record, raw field text and title without encoding the view', () => {
  const source = planSourceAttributes(
    42,
    { key: 'E1.5', title: 'Plan comments' },
    'description',
    '## Scope\nKeep **original** text & <tags>.',
  )
  expect(source).toEqual({
    'data-annotation-conversation': 42,
    'data-annotation-document': 'ultimate.plan',
    'data-annotation-record': 'E1.5',
    'data-annotation-field': 'description',
    'data-annotation-title': 'Plan comments',
    'data-annotation-content': '## Scope\nKeep **original** text & <tags>.',
  })
})

it('keeps logical identity after live edits while exposing the changed content separately', () => {
  const original = planSourceAttributes(42, { key: 'E1', title: 'Original' }, 'body', 'First plan')
  const current = planSourceAttributes(42, { key: 'E1', title: 'Updated' }, 'body', 'Changed plan')
  expect(current).toEqual({
    ...original,
    'data-annotation-title': 'Updated',
    'data-annotation-content': 'Changed plan',
  })
  expect(original['data-annotation-content']).toBe('First plan')
  expect(
    planSourceAttributes(43, { key: 'E1', title: 'Original' }, 'body', 'First plan'),
  ).not.toEqual(original)
})
