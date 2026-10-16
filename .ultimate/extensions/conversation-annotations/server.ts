import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { annotationPrompt, parseAnnotationBatch } from './annotation-domain.ts'
import type { AnnotationBatch, AnnotationSource, AnnotationState } from './annotation-domain.ts'

/** Submitted history and batch receipts are latest-only and never copied into a fork. */
export const AnnotationHistory = defineDoc<AnnotationState>({
  kind: 'conversation-annotations.history',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ threads: {}, batches: {} }),
})
/** Export only accepted history. Pending browser drafts remain private to that browser. */
export const docs = [AnnotationHistory]

function deliveryTask(host: ExtensionHost) {
  return defineTask<{ target: ConversationId; batchId: string }, { phase: 'deliver' }, null>({
    name: 'conversation-annotations.deliver',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const { target, batchId } = task.input
        const batch = (await runtime.snapshot(AnnotationHistory, target, ctx))?.batches[batchId]
        if (!batch) {
          throw new Error('Annotation delivery: missing accepted batch')
        }
        try {
          const conversation = await host.harness().conversation(target, ctx)
          if (!conversation) {
            throw new Error('Annotation delivery: target conversation is unavailable')
          }
          // Stable across retries, crashes and new delivery tasks. Pi durably deduplicates the input.
          const submission = await conversation.submit(
            {
              type: 'input',
              requestId: `conversation-annotations:${batchId}`,
              content: [
                { type: 'text', text: batch.text },
                ...batch.images.map((image) => ({ type: 'image' as const, ...image })),
              ],
              whenBusy: batch.whenBusy,
              entry: { kind: 'conversation-annotations.batch', data: { batchId } },
            },
            ctx,
          )
          await runtime.commit(async (tx) => {
            const stored = (await tx.doc(AnnotationHistory, target)).batches[batchId]
            stored.status = 'delivered'
            stored.submissionId = submission.id
            delete stored.error
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, ctx)
        } catch (error) {
          await runtime.commit(async (tx) => {
            const stored = (await tx.doc(AnnotationHistory, target)).batches[batchId]
            stored.status = 'error'
            stored.error = error instanceof Error ? error.message : String(error)
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, ctx)
        }
      },
    },
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        const stored = (await tx.doc(AnnotationHistory, task.input.target)).batches[
          task.input.batchId
        ]
        stored.status = 'error'
        stored.error = 'Delivery stopped. Retry uses the same request id.'
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, ctx),
  })
}

function targetOf(conversationId: number | undefined): ConversationId {
  if (!conversationId || !Number.isSafeInteger(conversationId) || conversationId < 1) {
    throw new Error('Annotation action: a target conversation is required')
  }
  // SAFETY: validated positive integer; the harness verifies existence before writing.
  return conversationId as ConversationId
}

function assertStoredSnapshot(source: AnnotationSource, storedText: string) {
  if (source.content !== storedText) {
    throw new Error('Annotation source: snapshot does not match stored text')
  }
}

async function sourceImages(tx: Tx, host: ExtensionHost, source: AnnotationSource) {
  const location = source.location
  // SAFETY: source ids were validated at the action boundary; existence is checked below.
  const owner = location.conversationId as ConversationId
  if (!(await tx.conversation(owner))) {
    throw new Error('Annotation source: owning conversation is unavailable')
  }
  if (location.kind === 'plan') {
    const token = host.doc('ultimate.plan')
    if (!token) {
      throw new Error('Annotation source: plan document is unavailable')
    }
    const plan = await tx.doc(token, owner)
    const epics = plan.epics
    if (!epics || typeof epics !== 'object' || Array.isArray(epics)) {
      throw new Error('Annotation source: plan has no records')
    }
    const epic = epics[location.record.split('.')[0]]
    if (!epic || typeof epic !== 'object' || Array.isArray(epic)) {
      throw new Error('Annotation source: epic is unavailable')
    }
    if (location.record.includes('.')) {
      const tasks = epic.tasks
      if (
        !tasks ||
        typeof tasks !== 'object' ||
        Array.isArray(tasks) ||
        !Object.hasOwn(tasks, location.record)
      ) {
        throw new Error('Annotation source: task is unavailable')
      }
    }
    return []
  }
  // SAFETY: validated positive stored entry id, then checked against its owning conversation.
  const entry = await tx.entry(location.entryId as EntryId)
  if (!entry || entry.conversationId !== owner) {
    throw new Error('Annotation source: entry provenance does not match its owner')
  }
  if (location.kind === 'entry') {
    const message = entry.model?.[0]
    if (message?.role !== 'assistant') {
      throw new Error('Annotation source: only agent entries are supported')
    }
    assertStoredSnapshot(
      source,
      message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
    )
    return []
  }
  const result = entry.model?.find(
    (message) => message.role === 'toolResult' && message.toolCallId === location.toolCallId,
  )
  if (!result || result.role !== 'toolResult') {
    throw new Error('Annotation source: stored tool result is unavailable')
  }
  assertStoredSnapshot(
    source,
    result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
  )
  if (location.imageIndex === undefined) {
    return []
  }
  const image = result.content.filter((part) => part.type === 'image')[location.imageIndex]
  if (!image) {
    throw new Error('Annotation source: stored image is unavailable')
  }
  return [{ data: image.data, mimeType: image.mimeType }]
}

/** Atomic batch acceptance: revision checks, history, receipt and delivery task share one transaction. */
export async function acceptAnnotationBatch(
  args: JsonValue,
  { host, conversationId }: ActionContext,
) {
  const input = parseAnnotationBatch(args)
  const target = targetOf(conversationId)
  const signature = JSON.stringify(input)
  const Deliver = deliveryTask(host)
  const receipt = await host.harness().commit(async (tx) => {
    if (!(await tx.conversation(target))) {
      throw new Error('Annotation action: target conversation is unavailable')
    }
    const state = await tx.doc(AnnotationHistory, target)
    const existing = state.batches[input.id]
    if (existing) {
      if (existing.signature !== signature) {
        throw new Error('Annotation conflict: batch id was already accepted with different content')
      }
      return { id: existing.id, status: existing.status }
    }
    const images = [...input.images]
    const selected = []
    for (const draft of input.drafts) {
      images.push(...(await sourceImages(tx, host, draft.source)))
      if (
        images.length > 10 ||
        images.reduce((total, image) => total + Buffer.byteLength(image.data, 'base64'), 0) >
          10 * 1024 * 1024
      ) {
        throw new Error(
          'Annotation input: combined composer and stored source images exceed 10 images or 10 MiB',
        )
      }
      let thread = state.threads[draft.threadId]
      if (
        thread &&
        (thread.revision !== draft.revision ||
          JSON.stringify(thread.source) !== JSON.stringify(draft.source))
      ) {
        throw new Error('Annotation conflict: thread changed; reload history before sending again')
      }
      if (!thread) {
        if (draft.revision !== 0) {
          throw new Error('Annotation conflict: thread no longer exists')
        }
        thread = { id: draft.threadId, source: draft.source, revision: 0, comments: [] }
        state.threads[thread.id] = thread
        // Chord copies inserted JSON; mutate the document's proxy, not the detached input object.
        thread = state.threads[thread.id]
      }
      thread.comments.push({
        id: draft.id,
        text: draft.text,
        batchId: input.id,
        at: new Date().toISOString(),
      })
      thread.revision++
      selected.push(thread)
    }
    const batch: AnnotationBatch = {
      id: input.id,
      signature,
      status: 'accepted',
      draftIds: input.drafts.map((draft) => draft.id),
      generalText: input.text,
      text: annotationPrompt(input.text, selected),
      images,
    }
    if (input.whenBusy) {
      batch.whenBusy = input.whenBusy
    }
    state.batches[batch.id] = batch
    await tx.createTask(
      Deliver,
      { target, batchId: input.id },
      { conversationId: target, ownership: { kind: 'conversation' }, background: true },
    )
    return { id: batch.id, status: batch.status }
  }, context)
  host.harness().resume()
  return receipt
}

/** Validated browser actions; no separate plain submission or delayed history save exists. */
export const actions = {
  accept: acceptAnnotationBatch,
  async receipt(args: JsonValue, { host, conversationId }: ActionContext) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.id !== 'string') {
      throw new Error('Annotation receipt: expected batch id')
    }
    const target = targetOf(conversationId)
    const id = args.id
    return host.harness().commit(async (tx) => {
      const state = await tx.doc(AnnotationHistory, target)
      const batch = Object.hasOwn(state.batches, id) ? state.batches[id] : undefined
      return {
        accepted: !!batch,
        revisions: Object.fromEntries(
          Object.values(state.threads).map((thread) => [thread.id, thread.revision]),
        ),
      }
    }, context)
  },
  async retry(args: JsonValue, { host, conversationId }: ActionContext) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.id !== 'string') {
      throw new Error('Annotation retry: expected batch id')
    }
    const target = targetOf(conversationId)
    const batchId = args.id
    const Deliver = deliveryTask(host)
    await host.harness().commit(async (tx) => {
      const batch = (await tx.doc(AnnotationHistory, target)).batches[batchId]
      if (!batch) {
        throw new Error('Annotation retry: accepted batch not found')
      }
      if (batch.status !== 'error') {
        return
      }
      batch.status = 'accepted'
      delete batch.error
      await tx.createTask(
        Deliver,
        { target, batchId },
        { conversationId: target, ownership: { kind: 'conversation' }, background: true },
      )
    }, context)
    host.harness().resume()
    return { id: batchId }
  },
}

/** Install the durable outbox; replay uses the accepted immutable prompt, not today's mutable source. */
export default function conversationAnnotations(host: ExtensionHost) {
  return defineExtension({ name: 'conversation-annotations', tasks: [deliveryTask(host)] })
}
