import { expect, test } from 'vitest'
import type { Question } from '../extensions/questions/types.ts'
import { assertCloudflareDecisionOptions } from './test-utils/assert-cloudflare-decision-options.ts'

const sourceOptions = [
  {
    label: 'Fold @cloudflare into this epic as the next step after per-project builds',
    recommended: true,
  },
  { label: 'Build it right away, in parallel with the current worker' },
  { label: 'Leave it for later' },
] satisfies NonNullable<Question['options']>

// Exact label/detail text reported by Q1.1 at ed560c80; the coordinator confirmed its meaning.
const capturedFirst = {
  label: 'Add it after per-project builds',
  detail: 'Recommended; fits the existing plan.',
  recommended: true,
}

test('Q1 source wording and the captured paraphrase preserve the same three choices', () => {
  assertCloudflareDecisionOptions(sourceOptions)
  assertCloudflareDecisionOptions([capturedFirst, ...sourceOptions.slice(1)])
  // Keep the precise old false negative visible without requiring another model call.
  expect(`${capturedFirst.label} ${capturedFirst.detail}`).not.toMatch(/fold|epic/i)
})

// Exhaust the closed fixture's 3^3 ordered triples: only [0, 1, 2] preserves every alternative.
for (const first of [0, 1, 2]) {
  for (const second of [0, 1, 2]) {
    for (const third of [0, 1, 2]) {
      // The valid triple is covered above; every other triple must fail with a correct recommendation.
      if (first === 0 && second === 1 && third === 2) continue
      test(`Q1 rejects option identities in order [${first}, ${second}, ${third}]`, () => {
        const options = [sourceOptions[first], sourceOptions[second], sourceOptions[third]].map(
          (option, index) => ({ ...option, recommended: index === 0 }),
        )
        expect(() => assertCloudflareDecisionOptions(options)).toThrow(/expected/)
      })
    }
  }
}

for (const omitted of [0, 1, 2]) {
  test(`Q1 cannot omit alternative ${omitted}`, () => {
    expect(() =>
      assertCloudflareDecisionOptions(
        sourceOptions.filter((option) => option !== sourceOptions[omitted]),
      ),
    ).toThrow(/expected/)
  })
}

test('Q1 cannot append a duplicated alternative', () => {
  expect(() => assertCloudflareDecisionOptions([...sourceOptions, sourceOptions[2]])).toThrow(
    /expected/,
  )
})

// All 2^3 recommendation assignments, with timing and option order held valid.
for (const mask of [0, 2, 3, 4, 5, 6, 7]) {
  test(`Q1 recommendation assignment ${mask} must mark only the first option`, () => {
    const options = sourceOptions.map((option, index) => ({
      ...option,
      recommended: Boolean(mask & (1 << index)),
    }))
    expect(() => assertCloudflareDecisionOptions(options)).toThrow(/expected/)
  })
}

test.for([
  [0, 'Add it to the existing plan'],
  [0, 'Add it after per-project builds'],
  [0, 'Fold @cloudflare into this epic right away'],
  [0, 'Fold @cloudflare into this epic before per-project builds'],
  [0, 'Do not fold @cloudflare into this epic after per-project builds'],
  [0, 'Fold @cloudflare into this epic after per-project builds, in parallel now'],
  [0, 'Fold @cloudflare into this epic after per-project builds, or leave it for later'],
  [1, 'Build it in parallel with the current worker'],
  [1, 'Build it right away with the current worker'],
  [1, 'Build it right away in parallel with another project'],
  [1, 'Build it later in parallel with the current worker'],
  [1, 'Do not build it right away in parallel with the current worker'],
  [1, 'Build it right away in parallel with the current worker after per-project builds'],
  [2, 'Build it'],
  [2, 'Leave it for later, immediately'],
  [2, 'Do not leave it for later'],
  [2, 'Leave it for later in parallel with the current worker'],
] as const)('Q1 rejects changed meaning at option %i: %s', ([index, label]) => {
  const options = sourceOptions.map((option, position) =>
    position === index ? { ...option, label } : option,
  )
  expect(() => assertCloudflareDecisionOptions(options)).toThrow(/expected/)
})
