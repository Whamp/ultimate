import * as fc from 'fast-check'
import { expect, it } from 'vitest'
import {
  annotationExcerptKey,
  annotationSourceKey,
  parseAnnotationSource,
  sameAnnotationField,
} from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import type { AnnotationLocation } from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import {
  annotationCounts,
  annotationSearch,
  annotationSource,
  annotationText,
} from './annotation-property-fixtures.ts'

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

it('matches labelled whole-field transformations without merging owners, kinds or distinct fields', () => {
  fc.assert(
    fc.property(identity, ({ owner, entry, call, record, field, image }) => {
      const tool: AnnotationLocation = {
        kind: 'tool',
        conversationId: owner,
        entryId: entry,
        toolCallId: call,
      }
      const entrySource: AnnotationLocation = {
        kind: 'entry',
        conversationId: owner,
        entryId: entry,
      }
      const plan: AnnotationLocation = {
        kind: 'plan',
        conversationId: owner,
        document: 'ultimate.plan',
        record,
        field,
      }
      const cases: {
        label: string
        left: AnnotationLocation
        right: AnnotationLocation
        matches: boolean
      }[] = [
        {
          label: 'tool:entry-placement',
          left: tool,
          right: { ...tool, entryId: entry + 1 },
          matches: true,
        },
        { label: 'tool:image-zero', left: tool, right: { ...tool, imageIndex: 0 }, matches: true },
        {
          label: 'tool:image-positive',
          left: tool,
          right: { ...tool, imageIndex: image },
          matches: true,
        },
        {
          label: 'tool:image-and-entry',
          left: { ...tool, imageIndex: 0 },
          right: { ...tool, entryId: entry + 1, imageIndex: image },
          matches: true,
        },
        {
          label: 'tool:other-call',
          left: tool,
          right: { ...tool, toolCallId: `${call}!` },
          matches: false,
        },
        { label: 'entry:same', left: entrySource, right: { ...entrySource }, matches: true },
        {
          label: 'entry:other-entry',
          left: entrySource,
          right: { ...entrySource, entryId: entry + 1 },
          matches: false,
        },
        { label: 'plan:same', left: plan, right: { ...plan }, matches: true },
        {
          label: 'plan:other-record',
          left: plan,
          right: { ...plan, record: `${record}0` },
          matches: false,
        },
        {
          label: 'plan:other-field',
          left: plan,
          right: { ...plan, field: `${field}!` },
          matches: false,
        },
        { label: 'kind:entry-tool', left: entrySource, right: tool, matches: false },
        { label: 'kind:entry-plan', left: entrySource, right: plan, matches: false },
        { label: 'kind:tool-plan', left: tool, right: plan, matches: false },
        ...[tool, entrySource, plan].map((location) => ({
          label: `${location.kind}:other-owner`,
          left: location,
          right: { ...location, conversationId: owner + 1 },
          matches: false,
        })),
      ]
      for (const { label, left, right, matches } of cases) {
        expect({ label, matches: sameAnnotationField(left, right) }).toEqual({ label, matches })
        expect({ label, matches: sameAnnotationField(right, left) }).toEqual({ label, matches })
        count(`field:${label}`)
      }
    }),
    annotationSearch(),
  )
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
