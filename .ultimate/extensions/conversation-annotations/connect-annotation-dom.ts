import {
  ANNOTATION_EXCLUDED,
  annotationElementSource,
  selectedAnnotationSource,
} from './annotation-sources.tsx'
import type { AnnotationEditorRequest } from './annotation-sources.tsx'

/** The connection owns each sibling portal target, not the source element. */
export interface SourceMount {
  element: HTMLElement
  mount: HTMLElement
}
/** Selection geometry and DOM references are ephemeral, never persisted with the quote. */
export interface SelectionControl {
  request: AnnotationEditorRequest
  rect: DOMRect
  wholeTable?: boolean
}

/** Own one annotation DOM connection; disposal also cancels its queued scan publications. */
export function connectAnnotationDom({
  onMounts,
  onSelection,
}: {
  onMounts: (mounts: SourceMount[]) => void
  onSelection: (selection: SelectionControl | undefined) => void
}): () => void {
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
      onMounts([...attached].map(([element, mount]) => ({ element, mount })))
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
    attributeFilter: ['data-annotation-content', 'data-annotation-entry', 'data-annotation-field'],
  })
  const handleSelection = (event: Event) => {
    // Whole-table actions have no text range; do not clear them on their own mouseup.
    if (event.target instanceof Element && event.target.closest('[data-annotation-floating]')) {
      return
    }
    const current = window.getSelection()
    const selected = selectedAnnotationSource(current)
    const range = current?.rangeCount ? current.getRangeAt(0) : undefined
    onSelection(
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
      onSelection({
        request: { source, element },
        rect: table.getBoundingClientRect(),
        wholeTable: true,
      })
    }
  }
  // Floating annotation controls must not dismiss the plan popover that owns their source.
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- each connection needs its own listener identity so disposal cannot remove another connection's capture
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
  document.addEventListener('selectionchange', handleSelection)
  document.addEventListener('mouseup', handleSelection)
  document.addEventListener('keyup', handleSelection)
  document.addEventListener('mouseover', onPointer)
  scan()
  return () => {
    active = false
    observer.disconnect()
    document.removeEventListener('pointerdown', keepSourceOpen, true)
    document.removeEventListener('selectionchange', handleSelection)
    document.removeEventListener('mouseup', handleSelection)
    document.removeEventListener('keyup', handleSelection)
    document.removeEventListener('mouseover', onPointer)
    for (const mount of attached.values()) {
      mount.remove()
    }
  }
}
