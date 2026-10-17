import assert from 'node:assert/strict'
import * as fc from 'fast-check'
import { it } from 'vitest'
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

// For each 1..20-operation history, a slot->text map owns pending expectations.
// A frozen obligation captures that map's values plus only the first actual UUID.
// No decoder, reconciliation or store algorithm is used to construct the model.
// 100 histories, seed 20261017. Arrays shrink by deleting/simplifying operations.
// Commands are total; empty-send/no-obligation retry assert rejection, not discard.
const count = annotationCounts('histories')
const slot = fc.integer({ min: 0, max: 3 })
const operation = fc.oneof(
  fc.record({
    kind: fc.constant('edit'),
    slot,
    text: annotationText.map((text) => `comment ${text.slice(0, 120)}`),
  }),
  fc.record({ kind: fc.constant('remove'), slot }),
  fc.record({ kind: fc.constant('fail-write'), slot, text: annotationText }),
  fc.constant({ kind: 'reload' } as const),
  fc.constant({ kind: 'uncertain' } as const),
  fc.constant({ kind: 'retry' } as const),
)

it('preserves pending slots and frozen obligations across bounded generated operation histories', async () => {
  await fc.assert(
    fc.asyncProperty(
      annotationText,
      annotationText,
      fc.array(operation, { minLength: 1, maxLength: 20 }),
      async (quote, content, operations) => {
        const persistence = annotationStorage()
        const source = annotationSource(quote, content)
        const model = new Map([[0, 'initial']])
        const drafts = () => [...model].map(([key, text]) => annotationDraft(key, text, source))
        let frozen: AnnotationBatchInput | undefined
        let store = createAnnotationDraftStore(persistence, 'pending')
        store.edit(drafts())
        let previous = 'start'
        for (const command of operations) {
          count(`command:${command.kind}`)
          count(`pair:${previous}/${command.kind}`)
          previous = command.kind
          if (command.kind === 'edit') {
            count(model.has(command.slot) ? 'edit:existing' : 'edit:new')
            model.set(command.slot, command.text)
            store.edit(drafts())
          } else if (command.kind === 'remove') {
            count(model.has(command.slot) ? 'remove:existing' : 'remove:absent')
            model.delete(command.slot)
            store.edit(drafts())
          } else if (command.kind === 'reload') {
            store = createAnnotationDraftStore(persistence, 'pending')
          } else if (command.kind === 'fail-write') {
            const before = store.getSnapshot()
            const bytes = persistence.getItem('pending')
            let notifications = 0
            const unsubscribe = store.subscribe(() => {
              notifications++
            })
            persistence.failWrite = true
            assert.throws(
              () => store.edit([annotationDraft(command.slot, command.text, source)]),
              /Injected storage write failure/u,
            )
            persistence.failWrite = false
            unsubscribe()
            assert.equal(notifications, 0)
            assert.equal(store.getSnapshot(), before)
            assert.equal(persistence.getItem('pending'), bytes)
          } else {
            let calls = 0
            const transport = async (batch: AnnotationBatchInput) => {
              calls++
              if (!frozen) {
                frozen = {
                  id: batch.id,
                  drafts: drafts(),
                  text: 'general',
                  images: [{ data: 'AAAA', mimeType: 'image/png' }],
                  whenBusy: 'steer',
                }
              }
              assert.deepEqual(batch, frozen)
              assert.deepEqual(
                createAnnotationDraftStore(persistence, 'pending').getSnapshot().frozen,
                frozen,
              )
              throw new Error('Uncertain acceptance')
            }
            if (command.kind === 'retry') {
              if (frozen) {
                await assert.rejects(store.retry(transport), /Uncertain acceptance/u)
                assert.equal(calls, 1)
                count('transition:uncertain-retry')
              } else {
                await assert.rejects(store.retry(transport), /no retryable batch/u)
                assert.equal(calls, 0)
                count('transition:no-obligation-retry')
              }
            } else if (!frozen && model.size === 0) {
              const before = store.getSnapshot()
              await assert.rejects(
                store.submit({ text: 'general', images: [] }, transport),
                /select 1–30 comments/u,
              )
              assert.equal(store.getSnapshot(), before)
              assert.equal(calls, 0)
              count('transition:empty-freeze-rejected')
            } else {
              await assert.rejects(
                store.submit(
                  {
                    text: 'general',
                    images: [{ data: 'AAAA', mimeType: 'image/png' }],
                    whenBusy: 'steer',
                  },
                  transport,
                ),
                /Uncertain acceptance/u,
              )
              assert.equal(calls, 1)
              count('transition:uncertain-send')
            }
          }
          assert.deepEqual(store.getSnapshot().drafts, drafts())
          assert.deepEqual(store.getSnapshot().frozen, frozen)
          assert.equal(store.getSnapshot().sending, false)
          const reloaded = createAnnotationDraftStore(persistence, 'pending').getSnapshot()
          assert.deepEqual(reloaded.drafts, drafts())
          assert.deepEqual(reloaded.frozen, frozen)
          assert.equal(reloaded.sending, false)
          assert.equal(reloaded.blocked, undefined)
          count(model.size === 0 ? 'state:empty' : 'state:pending')
          count(frozen ? 'state:obligation' : 'state:unfrozen')
        }
        if (frozen) {
          // Only text varies per slot in these histories. The fate property separately
          // checks full JSON reversion, revision increments and new/removed comments.
          const obligation = new Map(frozen.drafts.map((draft) => [draft.threadId, draft.text]))
          const expected = drafts().filter((draft) => obligation.get(draft.threadId) !== draft.text)
          await store.retry(async (batch) => {
            assert.deepEqual(batch, frozen)
          })
          const survivors = store.getSnapshot().drafts
          assert.deepEqual(
            survivors.map((draft) => ({
              ...draft,
              id: `draft-${draft.threadId.slice(7)}`,
              revision: 0,
            })),
            expected,
          )
          for (const draft of survivors) {
            if (obligation.has(draft.threadId)) {
              assert.notEqual(draft.id, `draft-${draft.threadId.slice(7)}`)
              assert.equal(draft.revision, 1)
            } else {
              assert.equal(draft.id, `draft-${draft.threadId.slice(7)}`)
              assert.equal(draft.revision, 0)
            }
          }
          assert.equal(store.getSnapshot().frozen, undefined)
          assert.equal(store.getSnapshot().sending, false)
          assert.deepEqual(
            createAnnotationDraftStore(persistence, 'pending').getSnapshot(),
            store.getSnapshot(),
          )
          count('transition:accepted')
        }
      },
    ),
    annotationSearch(100),
  )
})
