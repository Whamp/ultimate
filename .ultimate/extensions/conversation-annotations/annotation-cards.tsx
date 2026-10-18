import type { EntryRecord } from '@earendil-works/pi-durable'
import { MessageSquareIcon, RotateCwIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { api, events, useComposer, useConversation, useDoc } from '@/sdk'
import { annotationBreadcrumb, sameAnnotationField } from './annotation-domain.ts'
import type { AnnotationSource, AnnotationState } from './annotation-domain.ts'
import { annotationDraftStore, useAnnotationDrafts } from './annotation-client.tsx'
import { annotationElementSource } from './annotation-sources.tsx'
import type { AnnotationEditorRequest } from './annotation-sources.tsx'

/** Locate the same logical source in any currently mounted view; original snapshots are never replaced. */
export function findAnnotationElement(source: AnnotationSource): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-annotation-field],[data-annotation-entry]'),
  ].find((element) => {
    const current = annotationElementSource(element, '')
    return current ? sameAnnotationField(source.location, current.location) : false
  })
}

/** Compact source excerpt shared by composer, beside-source editor and submitted batch cards. */
export function AnnotationQuote({ source }: { source: AnnotationSource }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-mono text-[10px] text-muted-foreground">
        {annotationBreadcrumb(source)} · {source.title}
      </div>
      <blockquote className="mt-1 line-clamp-3 border-l-2 border-brand/35 pl-2 text-[12px] whitespace-pre-wrap text-foreground/75">
        {source.quote}
      </blockquote>
    </div>
  )
}

/** Editable cards above the ordinary textarea. Adding/editing/removing never submits an input. */
export function AnnotationAttachments() {
  const composer = useComposer()
  const { id } = useConversation()
  if (composer.target !== 'conversation' || id === undefined) {
    return null
  }
  return <PendingCards key={id} conversationId={id} />
}
function PendingCards({ conversationId }: { conversationId: number }) {
  const pending = useAnnotationDrafts(conversationId)
  const history = useDoc<AnnotationState>('conversation-annotations.history')
  const [error, setError] = useState('')
  const store = annotationDraftStore(conversationId)
  const run = async (operation: () => Promise<void>) => {
    setError('')
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const outstanding = Object.values(history?.batches ?? {}).filter(
    (batch) => batch.status !== 'delivered',
  )
  if (
    !pending.drafts.length &&
    !pending.frozen &&
    !outstanding.length &&
    !error &&
    !pending.error
  ) {
    return null
  }
  return (
    <div
      data-annotation-ui
      className="annotation-pending space-y-2 border-b border-border/60 px-3 pt-3 pb-3"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquareIcon className="size-3 text-brand" />
        Annotations · {pending.blocked ? 'drafts unavailable' : `${pending.drafts.length} pending`}
        {!pending.blocked && (
          <span className="ml-auto text-[10px]">Send once with the normal send button</span>
        )}
      </div>
      <div className="annotation-pending-stack max-h-72 space-y-2 overflow-y-auto">
        {pending.drafts.map((draft) => (
          <div key={draft.id} className="annotation-card">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <AnnotationQuote source={draft.source} />
              </div>
              <button
                type="button"
                aria-label="Remove annotation"
                title="Remove pending comment only"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  try {
                    store.edit(pending.drafts.filter((item) => item.id !== draft.id))
                  } catch (cause) {
                    setError(String(cause))
                  }
                }}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            {draft.revision > 0 && (
              <div className="mt-1 text-[10px] text-muted-foreground">
                Revisit · includes {draft.revision} submitted{' '}
                {draft.revision === 1 ? 'comment' : 'comments'}
              </div>
            )}
            <textarea
              aria-label="Pending annotation comment"
              value={draft.text}
              rows={2}
              className="annotation-comment"
              onChange={(event) => {
                try {
                  store.edit(
                    pending.drafts.map((item) =>
                      item.id === draft.id ? { ...item, text: event.target.value } : item,
                    ),
                  )
                } catch (cause) {
                  setError(String(cause))
                }
              }}
            />
          </div>
        ))}
      </div>
      {pending.frozen && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-brand/25 p-2 text-[11px] text-muted-foreground">
          <span>
            {pending.sending
              ? 'Accepting saved batch…'
              : 'Send not confirmed. Saved batch retained unchanged.'}
          </span>
          {!pending.sending && (
            <button
              type="button"
              className="shrink-0 text-brand"
              onClick={(event) => event.currentTarget.closest('form')?.requestSubmit()}
            >
              Retry send
            </button>
          )}
        </div>
      )}
      {outstanding.map((batch) => (
        <div
          key={batch.id}
          className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"
        >
          <span>
            {batch.status === 'accepted'
              ? 'Accepted · delivery queued'
              : `Delivery error · ${batch.error}`}
          </span>
          {batch.status === 'error' && (
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 text-brand"
              onClick={() =>
                void run(async () => {
                  await api.action(
                    'conversation-annotations',
                    'retry',
                    { id: batch.id },
                    { conversationId },
                  )
                })
              }
            >
              <RotateCwIcon className="size-3" />
              Retry delivery
            </button>
          )}
        </div>
      ))}
      {(error || pending.error) && (
        <div role="alert" className="text-[11px] text-destructive">
          {error || pending.error}
        </div>
      )}
      {pending.error?.includes('Annotation conflict:') && pending.frozen && (
        <button
          type="button"
          className="text-[11px] text-brand"
          onClick={() =>
            void run(async () => {
              const frozen = store.getSnapshot().frozen
              if (!frozen) {
                return
              }
              const receipt = await api.action<{
                accepted: boolean
                revisions: Record<string, number>
              }>('conversation-annotations', 'receipt', { id: frozen.id }, { conversationId })
              if (receipt.accepted) {
                throw new Error(
                  'Annotation batch: already accepted. Use Retry send to confirm it with the normal composer.',
                )
              }
              // Only release a frozen request after the server confirms it was never accepted.
              store.reviewRejected(receipt.revisions)
            })
          }
        >
          Keep feedback and review current revisions
        </button>
      )}
      <div
        className="text-[10px] text-muted-foreground/70"
        title="Pending drafts use localStorage scoped by this project and target conversation. They survive reload on this browser, not cleared site data or another browser. Submitted history is durable on the server."
      >
        {pending.blocked ? 'Saved browser data left unchanged' : 'Drafts saved in this browser'} ·
        submitted history saved on the server
      </div>
    </div>
  )
}

/** Render the extension's own user input as quiet cards, never expose a raw annotation payload in the transcript. */
export function AnnotationBatchEntry({ entry }: { entry: EntryRecord }) {
  const history = useDoc<AnnotationState>('conversation-annotations.history')
  const [unavailable, setUnavailable] = useState('')
  const batchId =
    entry.data &&
    !Array.isArray(entry.data) &&
    typeof entry.data === 'object' &&
    typeof entry.data.batchId === 'string'
      ? entry.data.batchId
      : undefined
  const batch = batchId ? history?.batches[batchId] : undefined
  const threads = Object.values(history?.threads ?? {}).filter((thread) =>
    thread.comments.some((comment) => comment.batchId === batchId),
  )
  return (
    <div data-annotation-ui className="my-2 rounded-xl border border-brand/20 bg-muted/15 p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <MessageSquareIcon className="size-3.5 text-brand" />
        Annotations · {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
        <span className="ml-auto">{batch?.status ?? 'Loading history…'}</span>
      </div>
      {batch?.generalText && (
        <div className="mb-3 text-[13px] whitespace-pre-wrap">{batch.generalText}</div>
      )}
      <div className="space-y-2">
        {threads.map((thread) => (
          <div key={thread.id} className="annotation-card">
            <button
              className="block w-full text-left"
              title="Reopen source thread"
              onClick={() => {
                const element = findAnnotationElement(thread.source)
                if (!element) {
                  setUnavailable(
                    'Source is not currently loaded. Open its original conversation or plan field to revisit it.',
                  )
                  return
                }
                element.scrollIntoView({ block: 'center' })
                events.emit('conversation-annotations:open', {
                  source: thread.source,
                  threadId: thread.id,
                  element,
                } satisfies AnnotationEditorRequest)
              }}
            >
              <AnnotationQuote source={thread.source} />
            </button>
            {thread.comments
              .filter((comment) => comment.batchId === batchId)
              .map((comment) => (
                <div key={comment.id} className="mt-2 text-[12px] whitespace-pre-wrap">
                  {comment.text}
                </div>
              ))}
          </div>
        ))}
      </div>
      {unavailable && (
        <output className="mt-2 block text-[11px] text-muted-foreground">{unavailable}</output>
      )}
    </div>
  )
}
