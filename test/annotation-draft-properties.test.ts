import * as fc from 'fast-check'
import { expect, it } from 'vitest'
import type { AnnotationBatchInput } from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import { createAnnotationDraftStore } from '../.ultimate/extensions/conversation-annotations/annotation-drafts.ts'
import {
  annotationCounts,
  annotationDraft,
  annotationSearch,
  annotationSource,
  annotationStorage,
  annotationText,
} from './annotation-property-fixtures.ts'

const count = annotationCounts('drafts')
const composer = fc.record({
  text: annotationText,
  images: fc.array(
    fc.record({
      data: fc.constantFrom('AAAA', 'AA==', 'AQID'),
      mimeType: fc.constantFrom('image/png', 'image/jpeg'),
    }),
    { maxLength: 3 },
  ),
  whenBusy: fc.option(fc.constantFrom('steer', 'followUp'), { nil: undefined }),
})
const fates = fc.array(
  fc.record({
    fate: fc.constantFrom('unchanged', 'changed', 'removed', 'new', 'reverted'),
    text: annotationText.map((text) => `comment ${text.slice(0, 120)}`),
    revision: fc.integer({ min: 0, max: 20 }),
  }),
  { minLength: 1, maxLength: 8 },
)

it('persists exact edits/removal/reload and rolls back failed writes before notifying subscribers', () => {
  fc.assert(
    fc.property(annotationText, annotationText, annotationText, (quote, content, text) => {
      const persistence = annotationStorage()
      const source = annotationSource(quote, content)
      const original = [annotationDraft(1, text, source), annotationDraft(2, '', source)]
      const store = createAnnotationDraftStore(persistence, 'pending')
      store.edit(structuredClone(original))
      const edited = [{ ...original[0], text: `${text}!` }]
      store.edit(structuredClone(edited))
      expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
        drafts: edited,
        sending: false,
      })
      const before = store.getSnapshot()
      const bytes = persistence.getItem('pending')
      let notifications = 0
      const unsubscribe = store.subscribe(() => {
        notifications++
      })
      persistence.failWrite = true
      expect(() => store.edit(original)).toThrow('Injected storage write failure')
      expect(store.getSnapshot()).toBe(before)
      expect(persistence.getItem('pending')).toBe(bytes)
      expect(notifications).toBe(0)
      expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
        drafts: edited,
        sending: false,
      })
      persistence.failWrite = false
      store.edit(original)
      expect(notifications).toBe(1)
      unsubscribe()
      expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
        drafts: original,
        sending: false,
      })
      count(text === '' ? 'pending:blank' : 'pending:text')
      count('write:rollback-and-recovery')
    }),
    annotationSearch(),
  )
})

it('rolls back a failed freeze write without publishing, sending or losing the pending draft', async () => {
  await fc.assert(
    fc.asyncProperty(annotationText, annotationText, composer, async (quote, content, input) => {
      const persistence = annotationStorage()
      const pending = [annotationDraft(1, 'comment', annotationSource(quote, content))]
      const store = createAnnotationDraftStore(persistence, 'pending')
      store.edit(pending)
      const before = store.getSnapshot()
      const bytes = persistence.getItem('pending')
      let calls = 0
      let notifications = 0
      const unsubscribe = store.subscribe(() => {
        notifications++
      })
      persistence.failWrite = true
      await expect(
        store.submit(input, async () => {
          calls++
        }),
      ).rejects.toThrow('Injected storage write failure')
      unsubscribe()
      expect(calls).toBe(0)
      expect(notifications).toBe(0)
      expect(store.getSnapshot()).toBe(before)
      expect(persistence.getItem('pending')).toBe(bytes)
      expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
        drafts: pending,
        sending: false,
      })
      count('freeze:write-rollback')
    }),
    annotationSearch(),
  )
})

it('freezes before await and acknowledges only unchanged JSON-equivalent drafts from generated literal fates', async () => {
  await fc.assert(
    fc.asyncProperty(
      annotationText,
      annotationText,
      composer,
      fates,
      async (quote, content, input, rows) => {
        const persistence = annotationStorage()
        const source = annotationSource(quote, content)
        const drafts = rows.map((row, slot) => ({
          ...annotationDraft(slot, row.text, source),
          revision: row.revision,
        }))
        const anchor = annotationDraft(99, 'anchor', source)
        const initial = [
          anchor,
          ...rows.flatMap((row, slot) => (row.fate === 'new' ? [] : [drafts[slot]])),
        ]
        const store = createAnnotationDraftStore(persistence, 'pending')
        const editable = structuredClone(initial)
        const composerInput = structuredClone(input)
        store.edit(editable)
        const gate = Promise.withResolvers<void>()
        let request: AnnotationBatchInput | undefined
        const send = store.submit(composerInput, async (batch) => {
          request = structuredClone(batch)
          expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot().frozen).toEqual({
            ...input,
            id: batch.id,
            drafts: initial,
          })
          await gate.promise
        })
        expect(request).toEqual({ ...input, id: expect.any(String), drafts: initial })
        expect(store.getSnapshot().sending).toBe(true)
        editable[0].text = 'caller mutation after freeze'
        editable[0].source.quote = 'caller quote mutation'
        composerInput.images.push({ data: 'AAAA', mimeType: 'image/png' })
        const during = drafts.flatMap((draft, slot) => {
          const fate = rows[slot].fate
          count(`fate:${fate}`)
          if (fate === 'removed') {
            return []
          }
          if (fate === 'changed') {
            return [{ ...draft, text: `${draft.text}!` }]
          }
          return [structuredClone(draft)]
        })
        store.edit([
          anchor,
          ...rows.flatMap((row, slot) => {
            if (row.fate === 'new') {
              return []
            }
            return [
              row.fate === 'reverted' ? { ...drafts[slot], text: 'temporary edit' } : drafts[slot],
            ]
          }),
        ])
        store.edit(during)
        expect(store.getSnapshot().frozen).toEqual(request)
        expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
          drafts: during,
          frozen: request,
          sending: false,
        })
        gate.resolve()
        await send
        const survivors = store.getSnapshot().drafts
        const expected = rows.flatMap((row, slot) => {
          if (row.fate === 'new') {
            return [drafts[slot]]
          }
          if (row.fate !== 'changed') {
            return []
          }
          return [
            {
              ...drafts[slot],
              text: `${row.text}!`,
              revision: row.revision + 1,
              id: expect.any(String),
            },
          ]
        })
        expect(store.getSnapshot()).toEqual({ drafts: expected, sending: false })
        const changedSlots = rows.flatMap((row, slot) => (row.fate === 'changed' ? [slot] : []))
        for (const slot of changedSlots) {
          const survivor = survivors.find((draft) => draft.threadId === drafts[slot].threadId)
          expect(survivor?.id).not.toBe(drafts[slot].id)
          expect(survivor?.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          )
        }
        expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
          drafts: survivors,
          sending: false,
        })
      },
    ),
    annotationSearch(),
  )
})

it('retains the full uncertain request and original busy mode through edits/reload/retry', async () => {
  await fc.assert(
    fc.asyncProperty(annotationText, annotationText, composer, async (quote, content, input) => {
      const persistence = annotationStorage()
      const source = annotationSource(quote, content)
      const initial = [annotationDraft(1, 'first', source)]
      let store = createAnnotationDraftStore(persistence, 'pending')
      store.edit(initial)
      let first: AnnotationBatchInput | undefined
      await expect(
        store.submit(structuredClone(input), async (batch) => {
          first = structuredClone(batch)
          throw new Error('Uncertain response')
        }),
      ).rejects.toThrow('Uncertain response')
      expect(first).toEqual({ ...input, id: expect.any(String), drafts: initial })
      const edited = [
        { ...initial[0], text: 'edited after uncertainty' },
        annotationDraft(2, '', source),
      ]
      store.edit(edited)
      store = createAnnotationDraftStore(persistence, 'pending')
      expect(store.getSnapshot()).toEqual({ drafts: edited, frozen: first, sending: false })
      let invalidCalls = 0
      const forbidden = async () => {
        invalidCalls++
      }
      await expect(store.submit({ ...input, text: `${input.text}!` }, forbidden)).rejects.toThrow(
        'retry the saved batch first',
      )
      await expect(
        store.submit(
          { ...input, images: [...input.images, { data: 'AAAA', mimeType: 'image/png' }] },
          forbidden,
        ),
      ).rejects.toThrow('retry the saved batch first')
      expect(invalidCalls).toBe(0)
      const retryInput: AnnotationBatchInput['whenBusy'] =
        input.whenBusy === 'steer' ? 'followUp' : 'steer'
      let retried: AnnotationBatchInput | undefined
      await expect(
        store.submit({ ...input, whenBusy: retryInput }, async (batch) => {
          retried = structuredClone(batch)
          throw new Error('Still uncertain')
        }),
      ).rejects.toThrow('Still uncertain')
      expect(retried).toEqual(first)
      expect(retried?.whenBusy).toBe(input.whenBusy)
      store = createAnnotationDraftStore(persistence, 'pending')
      await store.retry(async (batch) => {
        expect(batch).toEqual(first)
      })
      const survivors = store.getSnapshot().drafts
      expect(survivors).toEqual([{ ...edited[0], id: expect.any(String), revision: 1 }, edited[1]])
      expect(survivors[0].id).not.toBe(initial[0].id)
      expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
        drafts: survivors,
        sending: false,
      })
      count(`retry:original-${input.whenBusy}`)
      count('retry:changed-text-and-images-rejected')
    }),
    annotationSearch(),
  )
})

it.each([
  {
    label: 'blank',
    drafts: (source: ReturnType<typeof annotationSource>) => [annotationDraft(1, ' \n', source)],
  },
  {
    label: 'duplicate id',
    drafts: (source: ReturnType<typeof annotationSource>) => [
      annotationDraft(1, 'one', source),
      { ...annotationDraft(2, 'two', source), id: 'draft-1' },
    ],
  },
  {
    label: 'duplicate thread',
    drafts: (source: ReturnType<typeof annotationSource>) => [
      annotationDraft(1, 'one', source),
      { ...annotationDraft(2, 'two', source), threadId: 'thread-1' },
    ],
  },
  {
    label: '31 drafts',
    drafts: (source: ReturnType<typeof annotationSource>) =>
      Array.from({ length: 31 }, (value, slot) => annotationDraft(slot, 'comment', source)),
  },
])(
  'allows $label pending drafts but rejects freezing without writes or transport',
  async ({ drafts }) => {
    const persistence = annotationStorage()
    const pending = drafts(annotationSource('rendered quote', '**raw**'))
    const store = createAnnotationDraftStore(persistence, 'pending')
    store.edit(pending)
    expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
      drafts: pending,
      sending: false,
    })
    const bytes = persistence.getItem('pending')
    const before = store.getSnapshot()
    let calls = 0
    await expect(
      store.submit({ text: '', images: [] }, async () => {
        calls++
      }),
    ).rejects.toThrow('Annotation input:')
    expect(calls).toBe(0)
    expect(store.getSnapshot()).toBe(before)
    expect(persistence.getItem('pending')).toBe(bytes)
  },
)
