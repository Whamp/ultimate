import './annotation.css'
import { MessageSquareIcon } from 'lucide-react'
import { defineWebExtension, useComposer } from '@/sdk'
import { AnnotationAttachments, AnnotationBatchEntry } from './annotation-cards.tsx'
import { annotationComposer } from './annotation-client.tsx'
import { AnnotationOverlay } from './annotation-overlay.tsx'
import { AnnotatableEntry } from './annotation-sources.tsx'

function AnnotationHelp() {
  const composer = useComposer()
  if (composer.target !== 'conversation') {
    return null
  }
  return (
    <span
      data-annotation-ui
      title="Select agent or tool text, or text in plan/task fields, then Annotate. Hover a table for whole-block selection. Stored tool images have whole-image buttons. Charts/canvas are not captured. Add several comments, then use the normal Send button once. Pending drafts are saved in this browser only."
      className="inline-flex items-center px-1 text-brand/60"
      aria-label="Annotation help"
    >
      <MessageSquareIcon className="size-3.5" />
    </span>
  )
}

/** Project-local prototype; entry renderers wrap core, while only this extension's batch entry gets its own card. */
export default defineWebExtension({
  composer: annotationComposer,
  entries: {
    'pi.assistant': AnnotatableEntry,
    'pi.tool-result': AnnotatableEntry,
    'conversation-annotations.batch': AnnotationBatchEntry,
  },
  slots: {
    'composer.attachments': [AnnotationAttachments],
    'composer.toolbar': [AnnotationHelp],
    'conversation.overlay': [AnnotationOverlay],
  },
})
