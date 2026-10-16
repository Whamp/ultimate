import { useSyncExternalStore } from 'react'
import { api, getState } from '@/sdk'
import type { ComposerSubmissionInput } from '@/sdk'
import { annotationDraftStorageKey, createAnnotationDraftStore } from './annotation-drafts.ts'
import type { AnnotationBatchInput } from './annotation-domain.ts'

const stores = new Map<string, ReturnType<typeof createAnnotationDraftStore>>()
const listeners = new Set<() => void>()

/** One browser draft store per project and target, shared by editor and composer contributions. */
export function annotationDraftStore(conversationId: number) {
  const key = annotationDraftStorageKey(getState().system?.project.root ?? '', conversationId)
  let store = stores.get(key)
  if (!store) {
    store = createAnnotationDraftStore(localStorage, key)
    store.subscribe(() => {
      for (const listener of listeners) {
        listener()
      }
    })
    stores.set(key, store)
  }
  return store
}

/** React observes the same synchronous snapshot that the composer submit hook freezes. */
export function useAnnotationDrafts(conversationId: number) {
  const store = annotationDraftStore(conversationId)
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

async function acceptBatch(conversationId: number, input: AnnotationBatchInput) {
  await api.action('conversation-annotations', 'accept', input, { conversationId })
}

/** Composer transport replaces plain submit only when this conversation has pending annotation cards. */
export const annotationComposer = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  pending(conversationId: number) {
    const state = annotationDraftStore(conversationId).getSnapshot()
    return state.drafts.length > 0 || !!state.frozen
  },
  async submit(input: ComposerSubmissionInput) {
    await annotationDraftStore(input.conversationId).submit(input, (batch) =>
      acceptBatch(input.conversationId, batch),
    )
  },
}
