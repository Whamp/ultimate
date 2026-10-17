import { MessageSquareIcon, MessageSquarePlusIcon, XIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { events, useConversation, useDoc, useEvent } from '@/sdk'
import { AnnotationQuote } from './annotation-cards.tsx'
import { annotationDraftStore, useAnnotationDrafts } from './annotation-client.tsx'
import { annotationExcerptKey, annotationSourceKey } from './annotation-domain.ts'
import type { AnnotationSource, AnnotationState, AnnotationThread } from './annotation-domain.ts'
import {
  ANNOTATION_EXCLUDED,
  annotationElementSource,
  selectedAnnotationSource,
} from './annotation-sources.tsx'
import type { AnnotationEditorRequest } from './annotation-sources.tsx'

interface SourceMount {
  element: HTMLElement
  mount: HTMLElement
}
interface SelectionControl {
  request: AnnotationEditorRequest
  rect: DOMRect
  wholeTable?: boolean
}

function sameField(source: AnnotationSource, current: AnnotationSource): boolean {
  if (source.location.kind === 'tool' && current.location.kind === 'tool') {
    return (
      source.location.conversationId === current.location.conversationId &&
      source.location.toolCallId === current.location.toolCallId
    )
  }
  return annotationSourceKey(source.location) === annotationSourceKey(current.location)
}

/** Permanent, quiet source markers; the count is submitted user comments, never inferred agent replies. */
function ThreadMarkers({
  element,
  threads,
}: {
  element: HTMLElement
  threads: AnnotationThread[]
}) {
  const current = annotationElementSource(element, '')
  const matching = current ? threads.filter((thread) => sameField(thread.source, current)) : []
  if (!matching.length) {
    return null
  }
  return (
    <div data-annotation-ui className="my-1 flex flex-wrap gap-1">
      {matching.map((thread) => (
        <button
          key={thread.id}
          type="button"
          aria-label={`Open annotation thread, ${thread.comments.length} comments`}
          title={`${thread.source.quote}\n\n${thread.comments.at(-1)?.text ?? ''}`}
          className="annotation-marker font-mono hover:bg-brand/10"
          onClick={() =>
            events.emit('conversation-annotations:open', {
              source: thread.source,
              threadId: thread.id,
              element,
            } satisfies AnnotationEditorRequest)
          }
        >
          <MessageSquareIcon className="size-3" />
          {thread.comments.length}
        </button>
      ))}
    </div>
  )
}

/** Selection listener and marker portals mount beside existing sources; no transcript renderer is replaced. */
export function AnnotationOverlay() {
  const { id } = useConversation()
  return id === undefined ? null : <ConversationAnnotationOverlay key={id} conversationId={id} />
}
function ConversationAnnotationOverlay({ conversationId }: { conversationId: number }) {
  const history = useDoc<AnnotationState>('conversation-annotations.history')
  const [selection, setSelection] = useState<SelectionControl>()
  const [editor, setEditor] = useState<AnnotationEditorRequest>()
  const [mounts, setMounts] = useState<SourceMount[]>([])
  useEvent('conversation-annotations:open', (value) => {
    // SAFETY: this extension is the only emitter; ephemeral DOM references are not a wire format.
    const request = value as AnnotationEditorRequest
    setSelection(undefined)
    setEditor(request)
  })
  const connect = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      return undefined
    }
    let active = true
    const attached = new Map<HTMLElement, HTMLElement>()
    let scheduled = false
    const scan = () => {
      scheduled = false
      if (!active) {
        return
      }
      let changed = false
      for (const [element, mount] of attached) {
        if (!element.isConnected) {
          mount.remove()
          attached.delete(element)
          changed = true
        }
      }
      for (const element of document.querySelectorAll<HTMLElement>(
        '[data-annotation-field],[data-annotation-entry]',
      )) {
        if (element.closest('[data-annotation-ui]') || attached.has(element)) {
          continue
        }
        const mount = document.createElement('div')
        mount.dataset.annotationUi = ''
        element.after(mount)
        attached.set(element, mount)
        changed = true
      }
      if (changed) {
        setMounts([...attached].map(([element, mount]) => ({ element, mount })))
      }
    }
    const schedule = () => {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(scan)
      }
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-annotation-content',
        'data-annotation-entry',
        'data-annotation-field',
      ],
    })
    const onSelection = (event: Event) => {
      // Whole-table actions have no text range; do not clear them on their own mouseup.
      if (event.target instanceof Element && event.target.closest('[data-annotation-floating]')) {
        return
      }
      const current = window.getSelection()
      const selected = selectedAnnotationSource(current)
      const range = current?.rangeCount ? current.getRangeAt(0) : undefined
      setSelection(
        selected && range ? { request: selected, rect: range.getBoundingClientRect() } : undefined,
      )
    }
    const onPointer = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest(ANNOTATION_EXCLUDED) ||
        !window.getSelection()?.isCollapsed
      ) {
        return
      }
      const table = event.target.closest('table')
      if (!table) {
        return
      }
      const element = table.closest<HTMLElement>('[data-annotation-field],[data-annotation-entry]')
      const source = element ? annotationElementSource(element, table.innerText) : undefined
      if (source && element) {
        setSelection({
          request: { source, element },
          rect: table.getBoundingClientRect(),
          wholeTable: true,
        })
      }
    }
    // Floating annotation controls must not dismiss the plan popover that owns their source.
    const keepSourceOpen = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-annotation-floating]')) {
        if (event.target.closest('button[data-annotation-floating]')) {
          // Capture stops React's pointer handler; preserve the quote here before touch defaults.
          event.preventDefault()
        }
        event.stopPropagation()
      }
    }
    document.addEventListener('pointerdown', keepSourceOpen, true)
    document.addEventListener('selectionchange', onSelection)
    document.addEventListener('mouseup', onSelection)
    document.addEventListener('keyup', onSelection)
    document.addEventListener('mouseover', onPointer)
    scan()
    return () => {
      active = false
      observer.disconnect()
      document.removeEventListener('pointerdown', keepSourceOpen, true)
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('mouseup', onSelection)
      document.removeEventListener('keyup', onSelection)
      document.removeEventListener('mouseover', onPointer)
      for (const mount of attached.values()) {
        mount.remove()
      }
    }
  }, [])
  const threads = Object.values(history?.threads ?? {})
  return (
    <div ref={connect} data-annotation-ui className="pointer-events-none">
      {mounts.map(({ element, mount }, index) =>
        createPortal(
          <div className="pointer-events-auto">
            <ThreadMarkers element={element} threads={threads} />
          </div>,
          mount,
          String(index),
        ),
      )}
      {selection &&
        !editor &&
        createPortal(
          <button
            data-annotation-ui
            data-annotation-floating
            type="button"
            className="fixed z-[90] flex items-center gap-1.5 rounded-lg border border-brand/35 bg-popover px-2.5 py-1.5 text-[12px] text-brand shadow-lg"
            style={{
              zIndex: 90,
              left: Math.max(8, Math.min(selection.rect.left, window.innerWidth - 180)),
              top: Math.max(8, Math.min(selection.rect.bottom + 6, window.innerHeight - 42)),
            }}
            onClick={() => {
              setEditor(selection.request)
              setSelection(undefined)
            }}
          >
            <MessageSquarePlusIcon className="size-3.5" />
            {selection.wholeTable ? 'Annotate whole table' : 'Annotate'}
          </button>,
          document.body,
        )}
      {editor &&
        createPortal(
          <BesideSourceEditor
            key={`${editor.threadId ?? 'new'}:${annotationSourceKey(editor.source.location)}:${editor.source.quote}`}
            request={editor}
            conversationId={conversationId}
            history={history ?? undefined}
            close={() => setEditor(undefined)}
          />,
          document.body,
        )}
    </div>
  )
}

function BesideSourceEditor({
  request,
  conversationId,
  history,
  close,
}: {
  request: AnnotationEditorRequest
  conversationId: number
  history?: Readonly<AnnotationState>
  close: () => void
}) {
  const pending = useAnnotationDrafts(conversationId)
  const excerptKey = annotationExcerptKey(request.source)
  const existing = request.threadId
    ? history?.threads[request.threadId]
    : Object.values(history?.threads ?? {}).find(
        (thread) => annotationExcerptKey(thread.source) === excerptKey,
      )
  const pendingDraft = pending.drafts.find((draft) =>
    request.threadId
      ? draft.threadId === request.threadId
      : annotationExcerptKey(draft.source) === excerptKey,
  )
  const [text, setText] = useState(pendingDraft?.text ?? '')
  const [error, setError] = useState('')
  const source = existing?.source ?? pendingDraft?.source ?? request.source
  const current = annotationElementSource(request.element, '')
  const changed =
    current && (current.content !== source.content || current.fingerprint !== source.fingerprint)
  const rect = request.element.getBoundingClientRect()
  const left =
    rect.right + 12 + 340 < window.innerWidth
      ? rect.right + 12
      : rect.left >= 352
        ? rect.left - 352
        : Math.max(8, Math.min(rect.left, window.innerWidth - 356))
  const top = Math.max(12, Math.min(rect.top, window.innerHeight - 460))
  const add = () => {
    if (!text.trim()) {
      return
    }
    const store = annotationDraftStore(conversationId)
    const latest = store.getSnapshot()
    const threadId = existing?.id ?? pendingDraft?.threadId ?? crypto.randomUUID()
    const currentDraft = latest.drafts.find((draft) => draft.threadId === threadId)
    const draft = {
      id: currentDraft?.id ?? crypto.randomUUID(),
      threadId,
      revision: existing?.revision ?? pendingDraft?.revision ?? 0,
      source,
      text,
    }
    try {
      store.edit(
        currentDraft
          ? latest.drafts.map((item) => (item.threadId === threadId ? draft : item))
          : [...latest.drafts, draft],
      )
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <dialog
      open
      data-annotation-ui
      data-annotation-floating
      aria-label="Annotate source"
      className="annotation-editor fixed rounded-xl border border-brand/25 bg-popover p-3 text-foreground shadow-xl"
      style={{ left, top, width: 340, maxWidth: 'calc(100vw - 16px)', zIndex: 95, margin: 0 }}
    >
      <div className="mb-2 flex items-center gap-2 text-[12px]">
        <MessageSquareIcon className="size-3.5 text-brand" />
        {existing ? 'Annotation thread' : 'Annotate'}
        <button
          aria-label="Close annotation editor"
          className="ml-auto text-muted-foreground"
          onClick={close}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <AnnotationQuote source={source} />
      {changed && (
        <output className="annotation-drift block">
          Source field changed. The original quote and snapshot are retained.
        </output>
      )}
      {existing && (
        <div className="mt-3 max-h-40 space-y-2 overflow-y-auto">
          {existing.comments.map((comment, index) => (
            <div
              key={comment.id}
              className="rounded-lg border border-border/65 bg-muted/20 p-2 text-[12px] whitespace-pre-wrap"
            >
              <div className="mb-1 font-mono text-[10px] text-muted-foreground">
                You · {index + 1} · {new Date(comment.at).toLocaleString()}
              </div>
              {comment.text}
            </div>
          ))}
        </div>
      )}
      <textarea
        aria-label="Annotation comment"
        autoFocus
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="annotation-comment"
        placeholder={existing ? 'Add new feedback…' : 'Your feedback…'}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            close()
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            add()
          }
        }}
      />
      {error && (
        <div role="alert" className="my-1 text-[11px] text-destructive">
          {error}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">Does not send or interrupt</span>
        <button
          className="rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] text-brand disabled:opacity-40"
          disabled={!text.trim()}
          onClick={add}
        >
          {pendingDraft ? 'Update pending' : 'Add to batch'}
        </button>
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground/70">
        Text and tables supported. Stored tool images use whole-image controls. Charts/canvas are
        not captured.
      </div>
    </dialog>
  )
}
