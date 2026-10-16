import type { JsonValue } from '@earendil-works/chord'
import { parseAnnotationBatch, parseAnnotationDraft } from './annotation-domain.ts'
import type { AnnotationBatchInput, AnnotationDraft } from './annotation-domain.ts'

/** Browser-local pending state, including a frozen request retained through network uncertainty. */
export interface AnnotationPendingState {
  drafts: AnnotationDraft[]
  frozen?: AnnotationBatchInput
  error?: string
  sending: boolean
}

/** Narrow persistence seam, using the real browser localStorage in the web facet. */
export interface AnnotationDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Atomically accepts a frozen batch; it must not use plain composer submission. */
export type AnnotationBatchTransport = (input: AnnotationBatchInput) => Promise<void>

/** Restore validated pending drafts; malformed storage is surfaced rather than silently discarded. */
export function restoreAnnotationDrafts(value: string | null): AnnotationPendingState {
  if (!value) {
    return { drafts: [], sending: false }
  }
  const parsed: JsonValue = JSON.parse(value)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.drafts)
  ) {
    throw new Error('Annotation drafts: invalid saved data; do not send until recovered')
  }
  const state: AnnotationPendingState = {
    drafts: parsed.drafts.map(parseAnnotationDraft),
    sending: false,
  }
  if (parsed.frozen) {
    state.frozen = parseAnnotationBatch(parsed.frozen)
  }
  return state
}

/** Pending store scoped by project and target conversation. Storage is written before notifying React or sending. */
export function createAnnotationDraftStore(storage: AnnotationDraftStorage, key: string) {
  let state = restoreAnnotationDrafts(storage.getItem(key))
  const listeners = new Set<() => void>()
  const update = (next: AnnotationPendingState) => {
    storage.setItem(key, JSON.stringify({ drafts: next.drafts, frozen: next.frozen }))
    state = next
    for (const listener of listeners) {
      listener()
    }
  }
  const getSnapshot = () => state
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const edit = (drafts: AnnotationDraft[]) => update({ ...state, drafts })
  const deliver = async (transport: AnnotationBatchTransport) => {
    const frozen = state.frozen
    if (!frozen || state.sending) {
      throw new Error('Annotation batch: no retryable batch or a send is already active')
    }
    update({ ...state, sending: true, error: undefined })
    try {
      await transport(frozen)
      // Keep comments edited or added while this request was in flight.
      const drafts = state.drafts.flatMap((draft) => {
        const sent = frozen.drafts.find((comment) => comment.id === draft.id)
        if (!sent) {
          return [draft]
        }
        if (JSON.stringify(sent) === JSON.stringify(draft)) {
          return []
        }
        return [{ ...draft, id: crypto.randomUUID(), revision: sent.revision + 1 }]
      })
      update({ drafts, sending: false })
    } catch (error) {
      update({
        ...state,
        sending: false,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
  const submit = async (
    input: {
      text: string
      images: AnnotationBatchInput['images']
      whenBusy?: AnnotationBatchInput['whenBusy']
    },
    transport: AnnotationBatchTransport,
  ) => {
    if (state.frozen) {
      if (
        state.frozen.text !== input.text ||
        JSON.stringify(state.frozen.images) !== JSON.stringify(input.images)
      ) {
        throw new Error(
          'Annotation batch: retry the saved batch first; new general text is not part of that frozen send',
        )
      }
    } else {
      // This snapshot and its stable request id are persisted synchronously, before the first await.
      const frozen: AnnotationBatchInput = {
        id: crypto.randomUUID(),
        drafts: structuredClone(state.drafts),
        text: input.text,
        images: structuredClone(input.images),
      }
      if (input.whenBusy) {
        frozen.whenBusy = input.whenBusy
      }
      update({ ...state, frozen })
    }
    await deliver(transport)
  }
  const reviewRejected = (revisions: Record<string, number>) => {
    if (state.sending) {
      throw new Error('Annotation batch: cannot review an active send')
    }
    update({
      drafts: state.drafts.map((draft) => ({ ...draft, revision: revisions[draft.threadId] ?? 0 })),
      sending: false,
    })
  }
  return { getSnapshot, subscribe, edit, submit, retry: deliver, reviewRejected }
}

/** Exact browser project path plus target conversation avoids collisions across projects and forks. */
export function annotationDraftStorageKey(project: string, conversationId: number): string {
  return `conversation-annotations:${JSON.stringify([project, conversationId])}`
}
