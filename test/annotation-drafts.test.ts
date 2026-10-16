import { expect, it, vi } from 'vitest'
import {
  annotationBreadcrumb,
  annotationExcerptKey,
  annotationFingerprint,
  annotationSourceKey,
  parseAnnotationBatch,
} from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import type {
  AnnotationDraft,
  AnnotationSource,
} from '../.ultimate/extensions/conversation-annotations/annotation-domain.ts'
import {
  annotationDraftStorageKey,
  createAnnotationDraftStore,
} from '../.ultimate/extensions/conversation-annotations/annotation-drafts.ts'

import type {
  AnnotationBatchTransport,
  AnnotationDraftStorage,
} from '../.ultimate/extensions/conversation-annotations/annotation-drafts.ts'

const original: AnnotationSource = {
  location: {
    kind: 'plan',
    conversationId: 7,
    document: 'ultimate.plan',
    record: 'E1.5',
    field: 'description',
  },
  title: 'Task',
  quote: 'exact selected quote',
  content: 'The **exact selected quote** and the entire raw field.',
  fingerprint: annotationFingerprint('The **exact selected quote** and the entire raw field.'),
}
function draft(id: string, text = 'Feedback'): AnnotationDraft {
  return { id, threadId: `thread-${id}`, revision: 0, source: original, text }
}
function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

it('persists edits/removal without sending; reload preserves exact quotes and independent field snapshots', () => {
  const persistence = storage()
  const store = createAnnotationDraftStore(persistence, 'project:conversation')
  store.edit([draft('one'), draft('two')])
  store.edit([{ ...store.getSnapshot().drafts[0], text: 'Edited' }])
  const restored = createAnnotationDraftStore(persistence, 'project:conversation')
  expect(restored.getSnapshot().drafts).toEqual([{ ...draft('one'), text: 'Edited' }])
  expect(restored.getSnapshot().drafts[0].source.quote).toBe('exact selected quote')
  expect(restored.getSnapshot().drafts[0].source.content).toBe(
    'The **exact selected quote** and the entire raw field.',
  )
  expect(restored.getSnapshot().frozen).toBeUndefined()
  expect(annotationDraftStorageKey('/project/a', 1)).not.toBe(
    annotationDraftStorageKey('/project/b', 1),
  )
  expect(annotationDraftStorageKey('/project/a', 1)).not.toBe(
    annotationDraftStorageKey('/project/a', 2),
  )
})

it('freezes synchronously before awaiting acceptance and retains edits made during the request at the next revision', async () => {
  const persistence = storage()
  const store = createAnnotationDraftStore(persistence, 'pending')
  store.edit([draft('one')])
  const { promise: accepted, resolve: finish } = Promise.withResolvers<void>()
  const calls: string[] = []
  const send = store.submit({ text: 'General', images: [] }, async (input) => {
    calls.push(JSON.stringify(input))
    await accepted
  })
  const frozen = store.getSnapshot().frozen!
  expect(frozen.drafts[0].text).toBe('Feedback')
  expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot().frozen?.id).toBe(
    frozen.id,
  )
  store.edit([{ ...draft('one'), text: 'New feedback while sending' }, draft('two')])
  expect(store.getSnapshot().frozen?.drafts[0].text).toBe('Feedback')
  finish()
  await send
  expect(calls).toHaveLength(1)
  expect(store.getSnapshot().frozen).toBeUndefined()
  expect(store.getSnapshot().drafts.map((item) => [item.text, item.revision])).toEqual([
    ['New feedback while sending', 1],
    ['Feedback', 0],
  ])
  expect(store.getSnapshot().drafts[0].id).not.toBe('one')
})

it('retries an uncertain send with the same immutable batch id/payload after reload, and rejects changed general text', async () => {
  const persistence = storage()
  const store = createAnnotationDraftStore(persistence, 'pending')
  store.edit([draft('one')])
  let attempted = ''
  await expect(
    store.submit({ text: 'General', images: [] }, async (input) => {
      attempted = JSON.stringify(input)
      throw new Error('Connection lost after acceptance')
    }),
  ).rejects.toThrow('Connection lost')
  const restored = createAnnotationDraftStore(persistence, 'pending')
  await expect(
    restored.submit({ text: 'Different', images: [] }, async () => {
      throw new Error('Must not reach transport')
    }),
  ).rejects.toThrow('retry the saved batch first')
  await restored.retry(async (input) => {
    expect(JSON.stringify(input)).toBe(attempted)
  })
  expect(restored.getSnapshot()).toEqual({ drafts: [], sending: false })
})

it.each([
  { label: 'comment', invalid: { ...draft('bad'), text: 'x'.repeat(20001) } },
  {
    label: 'source snapshot',
    invalid: {
      ...draft('bad'),
      source: {
        ...original,
        content: 'x'.repeat(100001),
        fingerprint: annotationFingerprint('x'.repeat(100001)),
      },
    },
  },
])(
  'rejects oversized $label edits before any write; prior drafts survive reload',
  ({ invalid }) => {
    const persistence = storage()
    const store = createAnnotationDraftStore(persistence, 'pending')
    store.edit([draft('one')])
    const saved = persistence.getItem('pending')
    const previous = store.getSnapshot()
    const writes = vi.spyOn(persistence, 'setItem')
    expect(() => store.edit([invalid])).toThrow('invalid text or length')
    expect(writes).not.toHaveBeenCalled()
    expect(persistence.getItem('pending')).toBe(saved)
    expect(store.getSnapshot()).toBe(previous)
    expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
      drafts: [draft('one')],
      sending: false,
    })
  },
)

it.each([
  {
    label: 'general text',
    input: { text: 'x'.repeat(50001), images: [] },
    error: 'invalid text or length',
  },
  {
    label: 'image count',
    input: {
      text: '',
      images: Array.from({ length: 11 }, () => ({ mimeType: 'image/png', data: 'AAAA' })),
    },
    error: 'invalid images',
  },
  {
    label: 'image data',
    input: { text: '', images: [{ mimeType: 'image/png', data: 'A'.repeat(3000001) }] },
    error: 'invalid text or length',
  },
])(
  'rejects oversized $label before persisting a frozen batch or starting transport',
  async ({ input, error }) => {
    const persistence = storage()
    const store = createAnnotationDraftStore(persistence, 'pending')
    store.edit([draft('one')])
    const saved = persistence.getItem('pending')
    const previous = store.getSnapshot()
    const writes = vi.spyOn(persistence, 'setItem')
    const transport = vi.fn<AnnotationBatchTransport>(async () => {
      throw new Error('Must not send')
    })
    await expect(store.submit(input, transport)).rejects.toThrow(error)
    expect(writes).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
    expect(persistence.getItem('pending')).toBe(saved)
    expect(store.getSnapshot()).toBe(previous)
    expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot()).toEqual({
      drafts: [draft('one')],
      sending: false,
    })
  },
)

it('retains valid limit-sized drafts and frozen text exactly through reload', async () => {
  const persistence = storage()
  const store = createAnnotationDraftStore(persistence, 'pending')
  const content = 'x'.repeat(100000)
  const accepted = {
    ...draft('one'),
    text: 'x'.repeat(20000),
    source: { ...original, content, fingerprint: annotationFingerprint(content) },
  }
  store.edit([accepted])
  const input = { text: 'x'.repeat(50000), images: [] }
  await expect(
    store.submit(input, async (batch) => {
      expect(batch.drafts).toEqual([accepted])
      expect(batch.text).toBe(input.text)
      throw new Error('Simulated response loss')
    }),
  ).rejects.toThrow('Simulated response loss')
  const restored = createAnnotationDraftStore(persistence, 'pending').getSnapshot()
  expect(restored.blocked).toBeUndefined()
  expect(restored.drafts).toEqual([accepted])
  expect(restored.frozen).toEqual(store.getSnapshot().frozen)
  expect(restored.frozen?.text).toBe(input.text)
})

it.each(['{', '', '{"drafts":false}'])(
  'blocks malformed saved drafts without throwing during reads or overwriting bytes (%j)',
  async (saved) => {
    const values = new Map([['pending', saved]])
    const persistence = {
      getItem: vi.fn<AnnotationDraftStorage['getItem']>((key) => values.get(key) ?? null),
      setItem: vi.fn<AnnotationDraftStorage['setItem']>((key, value) => {
        values.set(key, value)
      }),
    }
    const transport = vi.fn<AnnotationBatchTransport>(async () => {
      throw new Error('Must not send')
    })
    const store = createAnnotationDraftStore(persistence, 'pending')
    const state = store.getSnapshot()
    expect(state).toMatchObject({ drafts: [], blocked: true, sending: false })
    expect(state.error).toContain('Restore browser data or storage access, then reload')
    expect(store.getSnapshot()).toBe(state)
    expect(() => store.edit([draft('one')])).toThrow('Editing and sending are blocked')
    expect(() => store.reviewRejected({})).toThrow('Editing and sending are blocked')
    await expect(
      store.submit({ text: 'Keep ordinary draft', images: [] }, transport),
    ).rejects.toThrow('Editing and sending are blocked')
    await expect(store.retry(transport)).rejects.toThrow('Editing and sending are blocked')
    expect(persistence.getItem).toHaveBeenCalledTimes(1)
    expect(persistence.setItem).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
    expect(values.get('pending')).toBe(saved)
    expect(store.getSnapshot()).toBe(state)
    values.set('pending', JSON.stringify({ drafts: [draft('restored')] }))
    expect(store.getSnapshot()).toBe(state)
    expect(createAnnotationDraftStore(persistence, 'pending').getSnapshot().drafts).toEqual([
      draft('restored'),
    ])
  },
)

it('keeps unavailable initial storage reads blocked and stable until reload, without writes or transport', async () => {
  const persistence = {
    getItem: vi.fn<AnnotationDraftStorage['getItem']>(() => {
      throw new Error('Storage access denied')
    }),
    setItem: vi.fn<AnnotationDraftStorage['setItem']>(),
  }
  const store = createAnnotationDraftStore(persistence, 'pending')
  const state = store.getSnapshot()
  const transport = vi.fn<AnnotationBatchTransport>(async () => {
    throw new Error('Must not send')
  })
  expect(state.blocked).toBe(true)
  expect(() => store.edit([])).toThrow('Restore browser data or storage access, then reload')
  await expect(store.submit({ text: '', images: [] }, transport)).rejects.toThrow(
    'Editing and sending are blocked',
  )
  expect(store.getSnapshot()).toBe(state)
  expect(persistence.getItem).toHaveBeenCalledTimes(1)
  expect(persistence.setItem).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()
})

it('does not pretend draft storage succeeded when browser storage fails', () => {
  const store = createAnnotationDraftStore(
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded')
      },
    },
    'pending',
  )
  expect(() => store.edit([draft('one')])).toThrow('Quota exceeded')
  expect(store.getSnapshot().drafts).toEqual([])
})

it('shares plan/task excerpt identity across views and surrounding edits, without merging other owners or quotes', () => {
  const source: AnnotationSource = {
    location: {
      kind: 'plan',
      conversationId: 2,
      document: 'ultimate.plan',
      record: 'E1.5',
      field: 'description',
    },
    title: 'Task in Documents',
    quote: 'selected task text',
    content: 'selected task text with original surroundings',
    fingerprint: annotationFingerprint('selected task text with original surroundings'),
  }
  const otherView = {
    ...source,
    title: 'Task in plan popover',
    content: 'changed surroundings: selected task text',
    fingerprint: annotationFingerprint('changed surroundings: selected task text'),
  }
  expect(annotationExcerptKey(source)).toBe(annotationExcerptKey(otherView))
  expect(annotationExcerptKey({ ...otherView, quote: 'different excerpt' })).not.toBe(
    annotationExcerptKey(source),
  )
  expect(
    annotationExcerptKey({ ...otherView, location: { ...otherView.location, conversationId: 3 } }),
  ).not.toBe(annotationExcerptKey(source))
  expect(
    annotationExcerptKey({
      ...otherView,
      location: {
        kind: 'plan',
        conversationId: 2,
        document: 'ultimate.plan',
        record: 'E1',
        field: 'body',
      },
    }),
  ).not.toBe(annotationExcerptKey(source))
})

it('canonical plan source identity is view-independent and fingerprints do not replace the original quote', () => {
  const duplicateView = { ...original, title: 'Documents task view' }
  expect(annotationSourceKey(duplicateView.location)).toBe(annotationSourceKey(original.location))
  expect(annotationBreadcrumb(original)).toBe('#7 · E1.5 · description')
  expect(annotationFingerprint('Changed field')).not.toBe(original.fingerprint)
  const input = { id: 'batch', drafts: [draft('one')], text: '', images: [] }
  expect(parseAnnotationBatch(input).drafts[0].source).toEqual(original)
  expect(() =>
    parseAnnotationBatch({
      ...input,
      drafts: [{ ...draft('one'), source: { ...original, content: 'Changed field' } }],
    }),
  ).toThrow('fingerprint mismatch')
  expect(() =>
    parseAnnotationBatch({ ...input, drafts: [{ ...draft('one'), threadId: 'constructor' }] }),
  ).toThrow('invalid identifier')
})
