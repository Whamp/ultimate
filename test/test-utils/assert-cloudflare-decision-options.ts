import { expect } from 'vitest'
import type { Question } from '../../extensions/questions/types.ts'

/** Check the closed Q1 fixture's three Cloudflare alternatives, including timing, order and recommendation. */
export function assertCloudflareDecisionOptions(options: NonNullable<Question['options']>) {
  expect(options).toHaveLength(3)
  const texts = options.map((option) => `${option.label} ${option.detail ?? ''}`)
  // These are bounded identity checks for this fixture, not a general paraphrase classifier.
  // Reject negated/contradictory choices rather than treating their keywords as positive evidence.
  for (const text of texts) {
    expect(text).not.toMatch(
      /\b(?:not|never|don't|before|instead of|rather than|cancel|abandon)\b/i,
    )
  }
  expect(texts[0]).toMatch(/\b(?:fold|add|integrate|incorporate|next step)\b/i)
  expect(texts[0]).toMatch(/\b(?:(?:this|current|existing) (?:epic|plan)|into (?:the )?epic)\b/i)
  expect(texts[1]).toMatch(/\b(?:current|existing) worker\b/i)
  expect(
    texts.map((text) => ({
      afterBuilds: /\bafter (?:the )?per-project builds\b/i.test(text),
      immediate: /\b(?:right away|now|immediately)\b/i.test(text),
      parallel: /\bparallel\b/i.test(text),
      later: /\b(?:later|defer(?:red)?|postpone(?:d)?)\b/i.test(text),
    })),
  ).toEqual([
    { afterBuilds: true, immediate: false, parallel: false, later: false },
    { afterBuilds: false, immediate: true, parallel: true, later: false },
    { afterBuilds: false, immediate: false, parallel: false, later: true },
  ])
  expect(options.map((option) => option.recommended === true)).toEqual([true, false, false])
}
