import type { EntryRecord } from '@earendil-works/pi-durable'
import { MessageSquarePlusIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { events, useTranscript } from '@/sdk'
import { annotationFingerprint } from './annotation-domain.ts'
import type { AnnotationLocation, AnnotationSource } from './annotation-domain.ts'

/** Beside-source editor request; DOM elements are ephemeral and never enter persisted history. */
export interface AnnotationEditorRequest {
  source: AnnotationSource
  element: HTMLElement
  threadId?: string
}

/** Source boundaries exclude editor, composer and action controls from every selection path. */
export const ANNOTATION_EXCLUDED =
  '[data-annotation-ui],button,input,textarea,select,[role="button"],[role="textbox"],[contenteditable="true"],form'

function elementOf(node: Node | null): HTMLElement | null {
  return node instanceof HTMLElement ? node : (node?.parentElement ?? null)
}
function sourceText(element: HTMLElement): string {
  const clone = element.cloneNode(true)
  if (!(clone instanceof HTMLElement)) {
    return ''
  }
  for (const control of clone.querySelectorAll(ANNOTATION_EXCLUDED)) {
    control.remove()
  }
  return clone.textContent ?? ''
}

/** Read canonical plan attributes or extension-owned stored-entry boundaries without replacing core renderers. */
export function annotationElementSource(
  element: HTMLElement,
  quote: string,
): AnnotationSource | undefined {
  const owner = Number(element.dataset.annotationConversation)
  if (!Number.isSafeInteger(owner) || owner < 1) {
    return undefined
  }
  let location: AnnotationLocation
  if (element.dataset.annotationDocument === 'ultimate.plan') {
    const record = element.dataset.annotationRecord
    const field = element.dataset.annotationField
    if (!record || !field) {
      return undefined
    }
    location = { kind: 'plan', conversationId: owner, document: 'ultimate.plan', record, field }
  } else {
    const entryId = Number(element.dataset.annotationEntry)
    if (!Number.isSafeInteger(entryId) || entryId < 1) {
      return undefined
    }
    const toolCallId = element.dataset.toolCallId
    location = toolCallId
      ? { kind: 'tool', conversationId: owner, entryId, toolCallId }
      : { kind: 'entry', conversationId: owner, entryId }
  }
  const content = element.dataset.annotationContent ?? sourceText(element)
  return {
    location,
    title: element.dataset.annotationTitle ?? 'Agent response',
    quote,
    content,
    fingerprint: annotationFingerprint(content),
  }
}

/** Exact selected quote must start and end in one supported source; cross-source and control selections are rejected. */
export function selectedAnnotationSource(
  selection: Selection | null,
): AnnotationEditorRequest | undefined {
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.rangeCount ||
    !selection.toString().trim()
  ) {
    return undefined
  }
  const start = elementOf(selection.anchorNode)
  const end = elementOf(selection.focusNode)
  if (!start || !end || start.closest(ANNOTATION_EXCLUDED) || end.closest(ANNOTATION_EXCLUDED)) {
    return undefined
  }
  const element = start.closest<HTMLElement>('[data-annotation-field],[data-annotation-entry]')
  if (!element || !element.contains(end)) {
    return undefined
  }
  if (end.closest('[data-annotation-field],[data-annotation-entry]') !== element) {
    return undefined
  }
  const range = selection.getRangeAt(0)
  for (const control of element.querySelectorAll(ANNOTATION_EXCLUDED)) {
    if (range.intersectsNode(control)) {
      return undefined
    }
  }
  const tool = start.closest('[data-tool-call-id]')
  if (tool && !tool.hasAttribute('data-annotation-entry')) {
    return undefined
  }
  const source = annotationElementSource(element, selection.toString())
  return source ? { source, element } : undefined
}

/** Preserve the full existing entry renderer; add only provenance boundaries and stored-image selection controls. */
export function AnnotatableEntry({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const entries = useTranscript()
  const message = entry.model?.[0]
  if (message?.role !== 'assistant' && message?.role !== 'toolResult') {
    return core
  }
  const calls =
    message.role === 'toolResult'
      ? [message.toolCallId]
      : message.content.flatMap((part) => (part.type === 'toolCall' ? [part.id] : []))
  const results = calls.flatMap((callId) =>
    entries.filter((candidate) =>
      candidate.model?.some((part) => part.role === 'toolResult' && part.toolCallId === callId),
    ),
  )
  const images = results.flatMap((result) => {
    const tool = result.model?.[0]
    if (tool?.role !== 'toolResult') {
      return []
    }
    return tool.content
      .filter((part) => part.type === 'image')
      .map((image, imageIndex) => ({ result, tool, imageIndex, image }))
  })
  const entryContent = message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
  return (
    <div
      data-annotation-entry={entry.id}
      data-annotation-conversation={entry.conversationId}
      data-annotation-content={entryContent}
      data-annotation-title="Agent response"
      ref={(node) => {
        if (!node) {
          return
        }
        for (const element of node.querySelectorAll<HTMLElement>('[data-tool-call-id]')) {
          const result = results.find(
            (candidate) =>
              candidate.model?.[0]?.role === 'toolResult' &&
              candidate.model[0].toolCallId === element.dataset.toolCallId,
          )
          const tool = result?.model?.[0]
          if (!result || tool?.role !== 'toolResult') {
            continue
          }
          element.dataset.annotationEntry = String(result.id)
          element.dataset.annotationConversation = String(result.conversationId)
          element.dataset.annotationTitle = `Tool · ${tool.toolName}`
          element.dataset.annotationContent = tool.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('\n')
        }
      }}
    >
      {core}
      {images.length > 0 && (
        <div data-annotation-ui className="mt-2 flex flex-wrap gap-2">
          {images.map(({ result, tool, imageIndex }) => (
            <button
              key={`${tool.toolCallId}:${imageIndex}`}
              className="flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] text-brand hover:bg-muted"
              title="Includes this actual stored image when the annotation batch is sent. No region selection."
              onClick={(event) => {
                const content = tool.content
                  .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  .join('\n')
                const source: AnnotationSource = {
                  location: {
                    kind: 'tool',
                    conversationId: result.conversationId,
                    entryId: result.id,
                    toolCallId: tool.toolCallId,
                    imageIndex,
                  },
                  title: `Tool · ${tool.toolName} · image ${imageIndex + 1}`,
                  quote: `[Whole stored image ${imageIndex + 1}]`,
                  content,
                  fingerprint: annotationFingerprint(content),
                }
                events.emit('conversation-annotations:open', {
                  source,
                  element: event.currentTarget,
                } satisfies AnnotationEditorRequest)
              }}
            >
              <MessageSquarePlusIcon className="size-3" />
              Annotate image {imageIndex + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
