import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as fc from 'fast-check'
import { afterAll } from 'vitest'
import { annotationFingerprint } from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import type {
  AnnotationDraft,
  AnnotationSource,
} from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'

/** UTF-16 units include controls, combining marks and lone surrogates without rejection. */
export const annotationText = fc.oneof(
  fc.constantFrom('', '\0', '\n', 'e\u0301', '😀', 'x'.repeat(128)),
  fc
    .array(fc.integer({ min: 0, max: 65535 }), { maxLength: 128 })
    .map((units) => String.fromCharCode(...units)),
)

/** Fixed seed and bounded runs; select one test with -t when replaying FC_PATH. */
export function annotationSearch(numRuns = 200) {
  return {
    seed: Number(process.env.FC_SEED ?? 20261017),
    path: process.env.FC_PATH ?? '',
    numRuns,
  }
}

/** A raw field need not contain the rendered quote, for example rendered Markdown. */
export function annotationSource(quote: string, content: string): AnnotationSource {
  return {
    location: { kind: 'entry', conversationId: 7, entryId: 11 },
    title: 'Agent response',
    quote,
    content,
    fingerprint: annotationFingerprint(content),
  }
}

/** Stable slot identity makes persistence expectations independent of store internals. */
export function annotationDraft(
  slot: number,
  text: string,
  source: AnnotationSource,
): AnnotationDraft {
  return { id: `draft-${slot}`, threadId: `thread-${slot}`, revision: 0, source, text }
}

/** Inject only storage write failure, before changing bytes, like localStorage quota failure. */
export function annotationStorage() {
  const values = new Map<string, string>()
  return {
    failWrite: false,
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (this.failWrite) {
        throw new Error('Injected storage write failure')
      }
      values.set(key, value)
    },
  }
}

/** Optional evidence export keeps routine test output quiet and does not affect the search. */
export function annotationCounts(suite: string) {
  const counts = new Map<string, number>()
  afterAll(() => {
    const directory = process.env.ANNOTATION_PROPERTY_COUNTS
    if (directory) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, `${suite}.json`),
        JSON.stringify(Object.fromEntries(counts), null, 2),
      )
    }
  })
  return (category: string) => counts.set(category, (counts.get(category) ?? 0) + 1)
}
