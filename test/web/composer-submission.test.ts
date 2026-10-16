import { expect, it, vi } from 'vitest'
import {
  composerSubmissionConflict,
  createComposerSubmissionStore,
} from '../../web/src/app/composer-submission.ts'
import type { ComposerSubmissionInput } from '../../web/src/sdk/types.ts'

function transport(extension: string) {
  const pending = new Set<number>()
  const listeners = new Set<() => void>()
  const contribution = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pending: (id: number) => pending.has(id),
    submit: vi.fn<(input: ComposerSubmissionInput) => Promise<void>>(async () => {}),
  }
  return {
    item: { extension, contribution },
    change(id: number, value: boolean) {
      if (value) pending.add(id)
      else pending.delete(id)
      for (const listener of listeners) listener()
    },
  }
}

const input: ComposerSubmissionInput = {
  conversationId: 7,
  text: 'General feedback',
  images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
  whenBusy: 'followUp',
}

it('subscribes to pending content for the target conversation and releases subscriptions', () => {
  const first = transport('first')
  const second = transport('second')
  const store = createComposerSubmissionStore([first.item, second.item], 7)
  const changed = vi.fn<() => void>()
  const unsubscribe = store.subscribe(changed)
  expect(store.getSnapshot()).toBe(0)
  first.change(8, true)
  expect(store.getSnapshot()).toBe(0)
  first.change(7, true)
  expect(store.getSnapshot()).toBe(1)
  second.change(7, true)
  expect(store.getSnapshot()).toBe(2)
  first.change(7, false)
  expect(store.getSnapshot()).toBe(1)
  expect(changed).toHaveBeenCalledTimes(4)
  unsubscribe()
  second.change(7, false)
  expect(changed).toHaveBeenCalledTimes(4)
})

it('does not subscribe to conversation transports for the new-conversation composer', () => {
  const first = transport('first')
  first.change(7, true)
  const store = createComposerSubmissionStore([first.item], undefined)
  const changed = vi.fn<() => void>()
  const unsubscribe = store.subscribe(changed)
  first.change(7, false)
  expect(store.getSnapshot()).toBe(0)
  expect(changed).not.toHaveBeenCalled()
  unsubscribe()
})

it('sends through the only pending transport, preserving general text, images and busy mode', async () => {
  const first = transport('first')
  const second = transport('second')
  const store = createComposerSubmissionStore([first.item, second.item], 7)
  const normalSubmit = vi.fn<(input: ComposerSubmissionInput) => Promise<void>>(async () => {})
  first.change(8, true)
  second.change(7, true)
  await store.submit(input, normalSubmit)
  expect(second.item.contribution.submit).toHaveBeenCalledExactlyOnceWith(input)
  expect(first.item.contribution.submit).not.toHaveBeenCalled()
  expect(normalSubmit).not.toHaveBeenCalled()
})

it('uses normal submit when content is no longer pending at the click', async () => {
  const first = transport('first')
  first.change(7, true)
  const store = createComposerSubmissionStore([first.item], 7)
  expect(store.getSnapshot()).toBe(1)
  first.change(7, false)
  const normalSubmit = vi.fn<(input: ComposerSubmissionInput) => Promise<void>>(async () => {})
  await store.submit(input, normalSubmit)
  expect(normalSubmit).toHaveBeenCalledExactlyOnceWith(input)
  expect(first.item.contribution.submit).not.toHaveBeenCalled()
})

it('rejects conflicting transports and never sends either batch or the plain draft', async () => {
  const first = transport('first')
  const second = transport('second')
  const store = createComposerSubmissionStore([first.item, second.item], 7)
  first.change(7, true)
  second.change(7, true)
  const normalSubmit = vi.fn<(input: ComposerSubmissionInput) => Promise<void>>(async () => {})
  await expect(store.submit(input, normalSubmit)).rejects.toThrow(composerSubmissionConflict)
  expect(first.item.contribution.submit).not.toHaveBeenCalled()
  expect(second.item.contribution.submit).not.toHaveBeenCalled()
  expect(normalSubmit).not.toHaveBeenCalled()
})

it('propagates extension failure without a fallback send, so the composer can retain its draft', async () => {
  const first = transport('first')
  first.change(7, true)
  first.item.contribution.submit.mockRejectedValue(new Error('Batch was not accepted'))
  const store = createComposerSubmissionStore([first.item], 7)
  const normalSubmit = vi.fn<(input: ComposerSubmissionInput) => Promise<void>>(async () => {})
  await expect(store.submit(input, normalSubmit)).rejects.toThrow('Batch was not accepted')
  expect(store.getSnapshot()).toBe(1)
  expect(normalSubmit).not.toHaveBeenCalled()
})

it('calls the transport synchronously so it can freeze its pending state before yielding', async () => {
  const first = transport('first')
  first.change(7, true)
  const accepted = Promise.withResolvers<void>()
  first.item.contribution.submit.mockImplementation(() => {
    first.change(7, false)
    return accepted.promise
  })
  const store = createComposerSubmissionStore([first.item], 7)
  const normalSubmit = vi.fn<(input: ComposerSubmissionInput) => Promise<void>>(async () => {})
  const sending = store.submit({ conversationId: 7, text: '', images: [] }, normalSubmit)
  expect(store.getSnapshot()).toBe(0)
  expect(first.item.contribution.submit).toHaveBeenCalledExactlyOnceWith({
    conversationId: 7,
    text: '',
    images: [],
  })
  accepted.resolve()
  await sending
  expect(normalSubmit).not.toHaveBeenCalled()
})
