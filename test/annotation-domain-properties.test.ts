import * as fc from 'fast-check'
import { expect, it } from 'vitest'
import {
  annotationExcerptKey,
  annotationSourceKey,
  parseAnnotationSource,
} from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import type { AnnotationLocation } from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import {
  annotationCounts,
  annotationSearch,
  annotationSource,
  annotationText,
} from './annotation-property-fixtures.ts'

// For every generated owner/location and exact quote, identity is the public tuple,
// independent of title/surroundings. No claim of fingerprint collision freedom.
// Oracle: literal key tuples and exact parser preservation, not another matcher.
// Budget: 200 cases/property, seed 20261017, native shrinking and FC_SEED/FC_PATH replay.
const count = annotationCounts('domain')
const identity = fc.record({
  owner: fc.integer({ min: 1, max: 10000 }),
  entry: fc.integer({ min: 1, max: 10000 }),
  call: annotationText.map((text) => `call-${text.slice(0, 123)}`),
  record: fc.integer({ min: 1, max: 1000 }).map((id) => `E${id}.3`),
  field: fc.constantFrom('title', 'description', 'verdict', 'notes:2026-10-17T00:00:00.000Z:0'),
  image: fc.integer({ min: 1, max: 100 }),
  quote: annotationText,
  content: annotationText,
  title: annotationText,
})

it('partitions public source/excerpt keys by kind, owner and exact quote, not views or tool entry placement', () => {
  fc.assert(
    fc.property(identity, ({ owner, entry, call, record, field, image, quote, content, title }) => {
      const locations: AnnotationLocation[] = [
        { kind: 'entry', conversationId: owner, entryId: entry },
        { kind: 'plan', conversationId: owner, document: 'ultimate.plan', record, field },
        { kind: 'tool', conversationId: owner, entryId: entry, toolCallId: call },
        { kind: 'tool', conversationId: owner, entryId: entry, toolCallId: call, imageIndex: 0 },
        {
          kind: 'tool',
          conversationId: owner,
          entryId: entry,
          toolCallId: call,
          imageIndex: image,
        },
      ]
      const expected = [
        ['entry', owner, entry],
        ['plan', owner, 'ultimate.plan', record, field],
        ['tool', owner, call, null],
        ['tool', owner, call, 0],
        ['tool', owner, call, image],
      ].map((tuple) => JSON.stringify(tuple))
      expect(locations.map(annotationSourceKey)).toEqual(expected)
      expect(new Set(locations.map(annotationSourceKey)).size).toBe(5)
      for (const [index, location] of locations.entries()) {
        count(`kind:${location.kind}`)
        const source = { ...annotationSource(quote, content), title, location }
        expect(parseAnnotationSource(source)).toEqual(source)
        expect(annotationExcerptKey(source)).toBe(JSON.stringify([expected[index], quote]))
        expect(
          annotationExcerptKey({ ...source, title: `${title}!`, content: 'other field' }),
        ).toBe(JSON.stringify([expected[index], quote]))
        expect(annotationExcerptKey({ ...source, quote: `${quote}!` })).not.toBe(
          annotationExcerptKey(source),
        )
        expect(annotationSourceKey({ ...location, conversationId: owner + 1 })).not.toBe(
          expected[index],
        )
      }
      for (const location of locations.filter((item) => item.kind === 'tool')) {
        expect(annotationSourceKey({ ...location, entryId: entry + 1 })).toBe(
          annotationSourceKey(location),
        )
        expect(annotationSourceKey({ ...location, toolCallId: `${call}!` })).not.toBe(
          annotationSourceKey(location),
        )
        count(
          `image:${location.imageIndex === undefined ? 'absent' : location.imageIndex === 0 ? 'zero' : 'positive'}`,
        )
      }
      for (const location of locations.filter((item) => item.kind === 'entry')) {
        expect(annotationSourceKey({ ...location, entryId: entry + 1 })).not.toBe(
          annotationSourceKey(location),
        )
      }
      for (const location of locations.filter((item) => item.kind === 'plan')) {
        expect(annotationSourceKey({ ...location, record: `${record}0` })).not.toBe(
          annotationSourceKey(location),
        )
        expect(annotationSourceKey({ ...location, field: `${field}!` })).not.toBe(
          annotationSourceKey(location),
        )
      }
      count(quote.length === 0 ? 'quote:empty' : 'quote:nonempty')
      count(/[\u0080-\uffff]/u.test(quote) ? 'quote:unicode' : 'quote:ascii')
    }),
    annotationSearch(),
  )
})
